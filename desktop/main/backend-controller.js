import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  MAX_BACKEND_LINE_BYTES,
  createAudioCommand,
  createStartCommand,
  parseBackendLine
} from "./protocol.js";

const MAX_PENDING_BYTES = 1_000_000;
// First use can provision a selected Whisper model before inference starts.
// Medium alone is large enough to exceed a short request timeout on a healthy
// but slower connection, so startup gets a distinct provisioning budget.
export const START_TIMEOUT_MS = 20 * 60_000;
// Final decoding can legitimately be slow with Medium or on a CPU that has a
// bounded backlog. Preserve accepted finals before declaring the sidecar stuck.
export const STOP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const FORCE_KILL_TIMEOUT_MS = 2_000;

export class BackendController extends EventEmitter {
  constructor({
    backendRoot,
    env = process.env,
    fakeBackendPath,
    spawnProcess = spawn,
    getVerifiedLaunch = null,
    startTimeoutMs = START_TIMEOUT_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
    forceKillTimeoutMs = FORCE_KILL_TIMEOUT_MS
  } = {}) {
    super();
    this.backendRoot = backendRoot;
    this.env = env;
    this.fakeBackendPath = fakeBackendPath;
    this.spawnProcess = spawnProcess;
    this.getVerifiedLaunch = getVerifiedLaunch;
    this.child = null;
    this.childContext = null;
    this.generation = 0;
    this.sessionState = "idle";
    this.lastEngineStatus = null;
    this.startTimeoutMs = startTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.forceKillTimeoutMs = forceKillTimeoutMs;
  }

  async startSession(options = {}) {
    if (this.childContext?.terminationUnconfirmed) {
      throw new Error("The local process termination has not been confirmed yet.");
    }
    if (this.childContext?.shuttingDown) {
      throw new Error("The local transcription process is still shutting down.");
    }
    if (this.sessionState === "ready") return this.lastEngineStatus;
    if (!["idle", "failed", "stopped"].includes(this.sessionState)) {
      throw new Error("A transcription session is already changing state.");
    }

    this.sessionState = "starting";
    let context = null;
    try {
      context = await this.ensureRunning();
      const result = this.waitForEvent((event) => {
        if (event.type === "engine_status" && event.status === "ready") return { resolve: event };
        if (event.type === "engine_status" && event.status === "unavailable") {
          return { reject: new Error("The local transcription engine could not start.") };
        }
        if (event.type === "error" && event.code === "engine_initialization_failed") {
          return { reject: new Error(event.message) };
        }
        return null;
      }, this.startTimeoutMs, "The local transcription engine took too long to start.", context);
      result.catch(() => {});
      await this.enqueue(createStartCommand(options), context);
      const readyEvent = await result;
      if (this.childContext === context && this.sessionState === "starting") {
        this.sessionState = "ready";
      }
      return readyEvent;
    } catch (error) {
      let shutdownError = null;
      try {
        await this.shutdownContext(context ?? this.childContext);
      } catch (cleanupError) {
        shutdownError = cleanupError;
      }
      this.sessionState = "failed";
      preserveCleanupError(error, shutdownError);
      throw error;
    }
  }

  async sendAudio(packet) {
    if (this.sessionState !== "ready") {
      throw new Error("The transcription engine is not ready for audio.");
    }
    await this.enqueue(createAudioCommand(packet), this.childContext);
  }

  async cancelStart() {
    if (this.sessionState !== "starting") return false;
    const context = this.childContext;
    try {
      await this.shutdownContext(context);
    } finally {
      if (this.sessionState === "starting") this.sessionState = "failed";
    }
    return true;
  }

  async stopSession() {
    const context = this.childContext;
    if (!context || ["idle", "failed", "stopped"].includes(this.sessionState)) return;
    if (this.sessionState === "stopping") {
      try {
        await this.waitForEvent(
          (event) => event.type === "session_stopped" ? { resolve: event } : null,
          this.stopTimeoutMs,
          "Finalizing the transcript timed out.",
          context
        );
      } catch (error) {
        let shutdownError = null;
        try {
          await this.shutdownContext(context);
        } catch (cleanupError) {
          shutdownError = cleanupError;
        }
        this.sessionState = "failed";
        preserveCleanupError(error, shutdownError);
        throw error;
      }
      return;
    }

    this.sessionState = "stopping";
    const stopped = this.waitForEvent(
      (event) => event.type === "session_stopped" ? { resolve: event } : null,
      this.stopTimeoutMs,
      "Finalizing the transcript timed out.",
      context
    );
    stopped.catch(() => {});
    try {
      await this.enqueue({ type: "stop" }, context);
      await stopped;
      if (this.childContext === context) this.sessionState = "stopped";
    } catch (error) {
      let shutdownError = null;
      try {
        await this.shutdownContext(context);
      } catch (cleanupError) {
        shutdownError = cleanupError;
      }
      this.sessionState = "failed";
      preserveCleanupError(error, shutdownError);
      throw error;
    }
  }

  async shutdown() {
    await this.shutdownContext(this.childContext);
  }

  async shutdownContext(context) {
    if (!context) return;
    if (context.shutdownPromise) return context.shutdownPromise;

    context.shuttingDown = true;
    context.shutdownPromise = this.performShutdown(context);
    return context.shutdownPromise;
  }

  async performShutdown(context) {
    const { child } = context;
    const terminated = waitForTermination(context);
    let terminationConfirmed = isTerminationConfirmed(context);
    let gracefulError = null;
    try {
      await withTimeout((async () => {
        await this.enqueue({ type: "shutdown" }, context);
        await terminated;
      })(), this.shutdownTimeoutMs, "Backend shutdown timed out.");
      terminationConfirmed = true;
    } catch (error) {
      gracefulError = error;
      if (!isTerminationConfirmed(context)) {
        try {
          child.kill();
        } catch {
          // The confirmation wait below is authoritative; kill() can race with a natural exit.
        }
      }
      try {
        await withTimeout(
          terminated,
          this.forceKillTimeoutMs,
          "Forced backend termination timed out."
        );
        terminationConfirmed = true;
      } catch (forceError) {
        context.terminationUnconfirmed = true;
        this.rejectWaiters(context, "The local process termination was not confirmed.");
        if (this.childContext === context) this.sessionState = "failed";
        const shutdownError = new Error("Forced local process termination was not confirmed.", {
          cause: gracefulError
        });
        Object.defineProperty(shutdownError, "forceKillError", {
          value: forceError,
          enumerable: false
        });
        throw shutdownError;
      }
    } finally {
      if (terminationConfirmed) {
        this.rejectWaiters(context, "The local transcription process stopped.");
        context.stdoutBuffer = "";
        context.pendingBytes = 0;
        if (this.childContext === context) {
          this.childContext = null;
          this.child = null;
        }
        if (this.generation === context.generation) {
          this.sessionState = "idle";
          this.lastEngineStatus = null;
        }
      }
    }
  }

  async ensureRunning() {
    if (this.childContext?.terminationUnconfirmed) {
      throw new Error("The local process termination has not been confirmed yet.");
    }
    if (this.childContext?.child.exitCode === null) return this.childContext;
    if (this.childContext) {
      this.rejectWaiters(this.childContext, "The local transcription process stopped.");
      this.childContext = null;
      this.child = null;
    }
    let verifiedLaunch = null;
    if (this.getVerifiedLaunch && this.env.MEETING_TRANSCRIBER_FAKE !== "1") {
      try {
        verifiedLaunch = this.getVerifiedLaunch();
      } catch {
        throw new Error("The local transcription prerequisites could not be verified.");
      }
      if (!verifiedLaunch) {
        throw new Error("The local transcription prerequisites have not been verified.");
      }
    }
    const launch = resolveLaunch({
      backendRoot: this.backendRoot,
      env: this.env,
      fakeBackendPath: this.fakeBackendPath,
      verifiedLaunch
    });
    const child = this.spawnProcess(launch.command, launch.args, {
      cwd: this.backendRoot,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    const context = {
      generation: ++this.generation,
      child,
      stdoutBuffer: "",
      pendingBytes: 0,
      writeChain: Promise.resolve(),
      waiters: new Set(),
      lastEngineStatus: null,
      shuttingDown: false,
      shutdownPromise: null,
      terminationConfirmed: false,
      terminationUnconfirmed: false
    };
    this.child = child;
    this.childContext = context;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(context, chunk));
    // Stderr may contain model diagnostics or user-derived data. It is deliberately not logged or relayed.
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.handleProcessFailure(context, error));
    child.once("exit", (code, signal) => this.handleExit(context, code, signal));
    child.once("close", (code, signal) => this.handleExit(context, code, signal));
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = () => {
        child.off("spawn", onSpawn);
        reject(new Error("The local transcription process could not start."));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return context;
  }

  enqueue(command, context = this.childContext) {
    if (!context || context.terminationUnconfirmed || !context.child.stdin || context.child.exitCode !== null) {
      return Promise.reject(new Error("The transcription backend is not running."));
    }
    const line = `${JSON.stringify(command)}\n`;
    const byteLength = Buffer.byteLength(line);
    if (byteLength > MAX_BACKEND_LINE_BYTES || context.pendingBytes + byteLength > MAX_PENDING_BYTES) {
      return Promise.reject(new Error("The local audio queue reached its safety limit."));
    }

    context.pendingBytes += byteLength;
    const operation = context.writeChain.then(() => writeToStdin(context.child, line));
    context.writeChain = operation.catch(() => {}).finally(() => {
      context.pendingBytes = Math.max(0, context.pendingBytes - byteLength);
    });
    return operation;
  }

  handleStdout(context, chunk) {
    if (this.childContext !== context || context.terminationUnconfirmed) return;
    context.stdoutBuffer += chunk;
    if (Buffer.byteLength(context.stdoutBuffer) > MAX_BACKEND_LINE_BYTES) {
      context.stdoutBuffer = "";
      this.emitSafeProtocolError(context, "backend_output_too_large");
      return;
    }

    let newlineIndex = context.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = context.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      context.stdoutBuffer = context.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const event = parseBackendLine(line);
          this.handleEvent(context, event);
        } catch {
          this.emitSafeProtocolError(context, "malformed_backend_output");
        }
      }
      newlineIndex = context.stdoutBuffer.indexOf("\n");
    }
  }

  handleEvent(context, event) {
    if (this.childContext !== context || context.terminationUnconfirmed) return;
    if (event.type === "engine_status") {
      context.lastEngineStatus = event;
      this.lastEngineStatus = event;
    }
    if (event.type === "session_stopped") this.sessionState = "stopped";
    this.emit("event", event);
    for (const waiter of [...context.waiters]) {
      const result = waiter.predicate(event);
      if (!result) continue;
      context.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if ("reject" in result) waiter.reject(result.reject);
      else waiter.resolve(result.resolve);
    }
  }

  waitForEvent(predicate, timeoutMs, timeoutMessage, context = this.childContext) {
    if (!context || this.childContext !== context) {
      return Promise.reject(new Error("The transcription backend is not running."));
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        context.waiters.delete(waiter);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      context.waiters.add(waiter);
    });
  }

  emitSafeProtocolError(context, code) {
    this.handleEvent(context, {
      type: "error",
      source: "protocol",
      code,
      message: "The local process returned an invalid response.",
      recoverable: false
    });
  }

  handleProcessFailure(context) {
    this.handleEvent(context, {
      type: "error",
      source: "transcription",
      code: "backend_process_failed",
      message: "The local transcription process could not start.",
      recoverable: false
    });
  }

  handleExit(context, code, signal) {
    context.terminationConfirmed = true;
    const expected = context.shuttingDown || context.lastEngineStatus?.status === "shutdown";
    if (this.childContext !== context) {
      this.rejectWaiters(context, "The local transcription process stopped.");
      return;
    }

    if (!expected) {
      this.sessionState = "failed";
      this.handleEvent(context, {
        type: "error",
        source: "transcription",
        code: "backend_process_exited",
        message: "The local transcription process stopped unexpectedly.",
        recoverable: false
      });
    }
    this.rejectWaiters(context, "The local transcription process stopped.");
    this.childContext = null;
    this.child = null;
    if (expected && !context.shuttingDown) {
      this.sessionState = "idle";
      this.lastEngineStatus = null;
    }
    void code;
    void signal;
  }

  rejectWaiters(context, message) {
    for (const waiter of [...context.waiters]) {
      context.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  }
}

export function resolveLaunch({ backendRoot, env, fakeBackendPath, verifiedLaunch = null }) {
  if (env.MEETING_TRANSCRIBER_FAKE === "1") {
    if (!fakeBackendPath) throw new Error("Fake backend path is not configured.");
    return {
      command: process.execPath,
      args: [fakeBackendPath],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" }
    };
  }

  if (verifiedLaunch) {
    const descriptor = normalizeLaunchDescriptor(verifiedLaunch);
    if (descriptor.kind === "sidecar") {
      return {
        command: descriptor.command,
        args: [...descriptor.prefixArgs],
        env: createVerifiedPythonEnvironment(env)
      };
    }
    const prefixArgs = [...descriptor.prefixArgs];
    if (!prefixArgs.includes("-I")) prefixArgs.push("-I");
    if (!prefixArgs.includes("-B")) prefixArgs.push("-B");
    return {
      command: descriptor.command,
      args: [...prefixArgs, "-m", "meeting_transcriber"],
      env: createVerifiedPythonEnvironment(env)
    };
  }

  const descriptor = resolveLegacyPythonLaunch({ backendRoot, env });
  const pythonPath = [path.join(backendRoot, "src"), env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return {
    command: descriptor.command,
    args: [...descriptor.prefixArgs, "-m", "meeting_transcriber"],
    env: { ...env, PYTHONPATH: pythonPath }
  };
}

function resolveLegacyPythonLaunch({ backendRoot, env }) {
  const repoRoot = path.dirname(backendRoot);
  const override = env.MEETING_TRANSCRIBER_PYTHON?.trim();
  const candidates = [
    path.join(backendRoot, ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    path.join(backendRoot, ".venv", "bin", "python"),
    path.join(repoRoot, ".venv", "bin", "python")
  ].filter(Boolean);
  return {
    command: override ?? candidates.find((candidate) => existsSync(candidate))
      ?? (process.platform === "win32" ? "python" : "python3"),
    prefixArgs: []
  };
}

function normalizeLaunchDescriptor(value) {
  if (!value || typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error("The verified local runtime is invalid.");
  }
  if (!Array.isArray(value.prefixArgs) || value.prefixArgs.some((item) => typeof item !== "string")) {
    throw new Error("The verified local runtime is invalid.");
  }
  const kind = value.kind ?? "python";
  if (!new Set(["python", "sidecar"]).has(kind)) {
    throw new Error("The verified local runtime is invalid.");
  }
  return { kind, command: value.command, prefixArgs: [...value.prefixArgs] };
}

function createVerifiedPythonEnvironment(env) {
  const isolated = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"].includes(normalizedKey)) continue;
    if (normalizedKey.startsWith("PIP_")) continue;
    isolated[key] = value;
  }
  return {
    ...isolated,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1"
  };
}

function writeToStdin(child, line) {
  return new Promise((resolve, reject) => {
    if (!child?.stdin || child.exitCode !== null || child.stdin.destroyed) {
      reject(new Error("The transcription backend is not writable."));
      return;
    }
    child.stdin.write(line, "utf8", (error) => error ? reject(error) : resolve());
  });
}

function waitForTermination(context) {
  if (isTerminationConfirmed(context)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      context.child.off("exit", finish);
      context.child.off("close", finish);
      resolve();
    };
    context.child.once("exit", finish);
    context.child.once("close", finish);
    if (isTerminationConfirmed(context)) finish();
  });
}

function isTerminationConfirmed(context) {
  return context.terminationConfirmed
    || context.child.exitCode !== null
    || context.child.signalCode !== null;
}

function preserveCleanupError(error, cleanupError) {
  if (!cleanupError || !(error instanceof Error)) return;
  Object.defineProperty(error, "shutdownError", {
    value: cleanupError,
    enumerable: false
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
