import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const SOURCE_COMPONENT_IDS = Object.freeze([
  "meeting_transcriber",
  "faster_whisper",
  "huggingface_hub",
  "sherpa_onnx"
]);
const BUNDLED_COMPONENT_IDS = Object.freeze([
  "meeting_transcriber",
  "faster_whisper",
  "faster_whisper.utils",
  "huggingface_hub",
  "numpy",
  "sherpa_onnx",
  "ctranslate2",
  "ctranslate2.converters",
  "sentencepiece"
]);
const COMPONENT_STATES = new Set(["ready", "missing", "broken"]);
const PROBE_SENTINEL = "__MEETING_TRANSCRIBER_SETUP_V1__";
const PROBE_SCRIPT = String.raw`
import importlib
import importlib.util
import json
import sys

components = {}
for name in ("meeting_transcriber", "faster_whisper", "huggingface_hub", "sherpa_onnx"):
    try:
        spec = importlib.util.find_spec(name)
        if spec is None:
            components[name] = "missing"
            continue
        importlib.import_module(name)
        components[name] = "ready"
    except BaseException:
        components[name] = "broken"

print("__MEETING_TRANSCRIBER_SETUP_V1__" + json.dumps({
    "version": [sys.version_info.major, sys.version_info.minor, sys.version_info.micro],
    "implementation": sys.implementation.name,
    "components": components,
}, separators=(",", ":")))
`.trim();

export class BackendSetupManager {
  constructor({
    backendRoot,
    bundledSidecarPath = null,
    allowSourceRuntime = true,
    env = process.env,
    fakeBackendPath,
    platform = process.platform,
    spawnProcess = spawn,
    pathExists = existsSync,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS
  } = {}) {
    this.backendRoot = backendRoot;
    this.bundledSidecarPath = bundledSidecarPath;
    this.allowSourceRuntime = allowSourceRuntime;
    this.env = env;
    this.fakeBackendPath = fakeBackendPath;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.pathExists = pathExists;
    this.timeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxOutputBytes = normalizePositiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.terminationGraceMs = normalizePositiveInteger(
      terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS
    );
    this.cachedResult = null;
    this.verifiedLaunch = null;
    this.checkPromise = null;
    this.unconfirmedTermination = null;
  }

  async check(options = {}) {
    const force = options?.force === true;
    if (this.unconfirmedTermination) {
      this.verifiedLaunch = null;
      this.cachedResult = createResult("check_failed");
      return this.cachedResult;
    }
    if (!force && this.cachedResult?.state === "ready") return this.cachedResult;
    if (this.checkPromise) return this.checkPromise;

    this.verifiedLaunch = null;
    this.checkPromise = this.performCheck()
      .catch(() => ({ result: createResult("check_failed"), launch: null }))
      .then(({ result, launch }) => {
        this.cachedResult = result;
        this.verifiedLaunch = result.state === "ready" ? freezeLaunch(launch) : null;
        return result;
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  getVerifiedLaunch() {
    if (!this.verifiedLaunch) return null;
    const launch = {
      command: this.verifiedLaunch.command,
      prefixArgs: Object.freeze([...this.verifiedLaunch.prefixArgs])
    };
    if (this.verifiedLaunch.kind === "sidecar") launch.kind = "sidecar";
    return Object.freeze(launch);
  }

  async performCheck() {
    if (this.allowSourceRuntime && this.env.MEETING_TRANSCRIBER_FAKE === "1") {
      if (!this.fakeBackendPath || !this.pathExists(this.fakeBackendPath)) {
        return { result: createResult("resource_missing"), launch: null };
      }
      return {
        result: createResult("ready", null, createComponentStates("ready")),
        launch: { command: process.execPath, prefixArgs: [] }
      };
    }

    if (this.bundledSidecarPath) {
      if (!this.pathExists(this.bundledSidecarPath)) {
        return { result: createResult("resource_missing"), launch: null };
      }
      const probe = await runRuntimeProbe({
        candidate: {
          command: this.bundledSidecarPath,
          prefixArgs: [],
          missingOnNonzero: false
        },
        probeArgs: ["--setup-probe"],
        backendRoot: this.backendRoot,
        env: this.env,
        spawnProcess: this.spawnProcess,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        terminationGraceMs: this.terminationGraceMs
      });
      if (probe.kind === "termination_unconfirmed") {
        this.guardUnconfirmedTermination(probe.closePromise);
        return { result: createResult("check_failed"), launch: null };
      }
      if (probe.kind !== "result") {
        return { result: createResult("check_failed"), launch: null };
      }
      const normalized = normalizeProbeResult(probe.value, {
        componentIds: BUNDLED_COMPONENT_IDS,
        requireExactComponents: true
      });
      if (!normalized) return { result: createResult("check_failed"), launch: null };
      const { pythonVersion, versionParts, implementation, components } = normalized;
      if (!isSupportedPython(versionParts, implementation)) {
        return {
          result: createResult("python_unsupported", pythonVersion, components),
          launch: null
        };
      }
      const componentValues = Object.values(components);
      if (componentValues.includes("broken")) {
        return {
          result: createResult("components_broken", pythonVersion, components),
          launch: null
        };
      }
      if (componentValues.includes("missing")) {
        return {
          result: createResult("components_missing", pythonVersion, components),
          launch: null
        };
      }
      return {
        result: createResult("ready", pythonVersion, components),
        launch: {
          kind: "sidecar",
          command: this.bundledSidecarPath,
          prefixArgs: []
        }
      };
    }

    if (!this.allowSourceRuntime) {
      return { result: createResult("resource_missing"), launch: null };
    }

    if (!hasBackendResource(this.backendRoot, this.pathExists)) {
      return { result: createResult("resource_missing"), launch: null };
    }

    const deadline = Date.now() + this.timeoutMs;
    let firstSupportedFailure = null;
    let firstUnsupported = null;
    let sawCheckFailure = false;

    for (const candidate of createPythonCandidates({
      backendRoot: this.backendRoot,
      env: this.env,
      platform: this.platform,
      pathExists: this.pathExists
    })) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        sawCheckFailure = true;
        break;
      }

      const probe = await runRuntimeProbe({
        candidate,
        probeArgs: [...candidate.prefixArgs, "-I", "-B", "-c", PROBE_SCRIPT],
        backendRoot: this.backendRoot,
        env: this.env,
        spawnProcess: this.spawnProcess,
        timeoutMs: remainingMs,
        maxOutputBytes: this.maxOutputBytes,
        terminationGraceMs: this.terminationGraceMs
      });
      if (probe.kind === "termination_unconfirmed") {
        this.guardUnconfirmedTermination(probe.closePromise);
        return { result: createResult("check_failed"), launch: null };
      }
      if (probe.kind === "missing") continue;
      if (probe.kind !== "result") {
        sawCheckFailure = true;
        continue;
      }

      const normalized = normalizeProbeResult(probe.value);
      if (!normalized) {
        sawCheckFailure = true;
        continue;
      }

      const { pythonVersion, versionParts, implementation, components } = normalized;
      if (!isSupportedPython(versionParts, implementation)) {
        firstUnsupported ??= createResult("python_unsupported", pythonVersion, components);
        continue;
      }

      const componentValues = Object.values(components);
      if (componentValues.includes("broken")) {
        firstSupportedFailure ??= createResult("components_broken", pythonVersion, components);
        continue;
      }
      if (componentValues.includes("missing")) {
        firstSupportedFailure ??= createResult("components_missing", pythonVersion, components);
        continue;
      }

      return {
        result: createResult("ready", pythonVersion, components),
        launch: {
          command: candidate.command,
          prefixArgs: [...candidate.prefixArgs, "-I", "-B"]
        }
      };
    }

    if (firstSupportedFailure) return { result: firstSupportedFailure, launch: null };
    if (firstUnsupported) return { result: firstUnsupported, launch: null };
    if (sawCheckFailure) return { result: createResult("check_failed"), launch: null };
    return { result: createResult("python_missing"), launch: null };
  }

  guardUnconfirmedTermination(closePromise) {
    const guard = Promise.resolve(closePromise).finally(() => {
      if (this.unconfirmedTermination === guard) this.unconfirmedTermination = null;
    });
    this.unconfirmedTermination = guard;
  }
}

function createPythonCandidates({ backendRoot, env, platform, pathExists }) {
  const repoRoot = path.dirname(backendRoot);
  const windows = platform === "win32";
  const venvSuffix = windows
    ? ["Scripts", "python.exe"]
    : ["bin", "python"];
  const candidates = [];
  const override = env.MEETING_TRANSCRIBER_PYTHON?.trim();

  if (override) candidates.push({ command: override, prefixArgs: [], missingOnNonzero: false });
  for (const root of [backendRoot, repoRoot]) {
    const command = path.join(root, ".venv", ...venvSuffix);
    if (pathExists(command)) {
      candidates.push({ command, prefixArgs: [], missingOnNonzero: false });
    }
  }
  if (windows) {
    candidates.push(
      { command: "py", prefixArgs: ["-3.12"], missingOnNonzero: true },
      { command: "python", prefixArgs: [], missingOnNonzero: true }
    );
  } else {
    candidates.push(
      { command: "python3.12", prefixArgs: [], missingOnNonzero: true },
      { command: "python3", prefixArgs: [], missingOnNonzero: true }
    );
  }

  const seen = new Set();
  return candidates.filter(({ command, prefixArgs }) => {
    const key = `${command}\0${prefixArgs.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runRuntimeProbe({
  candidate,
  probeArgs,
  backendRoot,
  env,
  spawnProcess,
  timeoutMs,
  maxOutputBytes,
  terminationGraceMs
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(
        candidate.command,
        probeArgs,
        {
          cwd: backendRoot,
          env: createPythonEnvironment(backendRoot, env),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: false
        }
      );
    } catch (error) {
      resolve({ kind: error?.code === "ENOENT" ? "missing" : "failed" });
      return;
    }

    let settled = false;
    let terminating = false;
    let outputBytes = 0;
    let stdout = "";
    let probeTimer = null;
    let escalationTimer = null;
    let confirmationTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(probeTimer);
      clearTimeout(escalationTimer);
      clearTimeout(confirmationTimer);
      child.off?.("error", onError);
      child.off?.("close", onClose);
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      resolve(value);
    };
    const terminateAsFailed = () => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(probeTimer);
      try {
        child.kill?.();
      } catch {
        // The bounded SIGKILL escalation below remains authoritative.
      }
      if (settled) return;
      escalationTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill?.("SIGKILL");
        } catch {
          // The final bounded confirmation wait still prevents an unbounded check.
        }
        if (settled) return;
        confirmationTimer = setTimeout(() => {
          const closePromise = waitForLateClose(child);
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
          finish({ kind: "termination_unconfirmed", closePromise });
        }, terminationGraceMs);
      }, terminationGraceMs);
    };
    const capture = (chunk, keep) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > maxOutputBytes) {
        terminateAsFailed();
        return;
      }
      if (keep) stdout += value;
    };
    const onStdout = (chunk) => capture(chunk, true);
    const onStderr = (chunk) => capture(chunk, false);
    const onError = (error) => {
      if (terminating) return;
      finish({ kind: error?.code === "ENOENT" ? "missing" : "failed" });
    };
    const onClose = (code) => {
      if (terminating) {
        finish({ kind: "failed" });
        return;
      }
      if (code !== 0) {
        finish({ kind: candidate.missingOnNonzero ? "missing" : "failed" });
        return;
      }
      try {
        finish({ kind: "result", value: parseProbeOutput(stdout) });
      } catch {
        finish({ kind: "failed" });
      }
    };
    probeTimer = setTimeout(terminateAsFailed, Math.max(1, timeoutMs));

    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.once?.("error", onError);
    child.once?.("close", onClose);
    if (!child.stdout || !child.stderr || typeof child.once !== "function") terminateAsFailed();
  });
}

function waitForLateClose(child) {
  return new Promise((resolve) => {
    const ignoreLateError = () => {};
    const confirm = () => {
      child.off?.("error", ignoreLateError);
      resolve();
    };
    child.on?.("error", ignoreLateError);
    child.once?.("close", confirm);
  });
}

function createPythonEnvironment(_backendRoot, env) {
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

function parseProbeOutput(stdout) {
  const sentinelIndex = stdout.lastIndexOf(PROBE_SENTINEL);
  if (sentinelIndex < 0) throw new Error("Missing setup result.");
  const payload = stdout.slice(sentinelIndex + PROBE_SENTINEL.length).split(/\r?\n/, 1)[0];
  return JSON.parse(payload);
}

function normalizeProbeResult(
  value,
  {
    componentIds = SOURCE_COMPONENT_IDS,
    requireExactComponents = false
  } = {}
) {
  if (!value || !Array.isArray(value.version) || value.version.length < 3) return null;
  const versionParts = value.version.slice(0, 3).map(Number);
  if (versionParts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  if (!value.components || typeof value.components !== "object" || Array.isArray(value.components)) return null;
  if (requireExactComponents) {
    const receivedIds = Object.keys(value.components);
    const expectedIds = new Set(componentIds);
    if (
      receivedIds.length !== componentIds.length
      || receivedIds.some((id) => !expectedIds.has(id))
    ) return null;
  }

  const components = {};
  for (const id of componentIds) {
    const state = value.components[id];
    if (!COMPONENT_STATES.has(state)) return null;
    components[id] = state;
  }
  return {
    pythonVersion: versionParts.join("."),
    versionParts,
    implementation: typeof value.implementation === "string"
      ? value.implementation.toLowerCase()
      : null,
    components
  };
}

function isSupportedPython([major, minor], implementation) {
  return implementation === "cpython" && major === 3 && minor === 12;
}

function hasBackendResource(backendRoot, pathExists) {
  return typeof backendRoot === "string"
    && backendRoot.length > 0
    && pathExists(path.join(backendRoot, "src", "meeting_transcriber", "__main__.py"));
}

function createResult(state, pythonVersion = null, components = createComponentStates("unknown")) {
  return Object.freeze({
    state,
    pythonVersion,
    components: Object.freeze({ ...components })
  });
}

function createComponentStates(state) {
  return Object.fromEntries(SOURCE_COMPONENT_IDS.map((id) => [id, state]));
}

function freezeLaunch(launch) {
  if (!launch || typeof launch.command !== "string" || !Array.isArray(launch.prefixArgs)) return null;
  const frozen = {
    command: launch.command,
    prefixArgs: Object.freeze([...launch.prefixArgs])
  };
  if (launch.kind === "sidecar") frozen.kind = "sidecar";
  return Object.freeze(frozen);
}

function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
