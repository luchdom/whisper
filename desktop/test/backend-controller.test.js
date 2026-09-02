import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  BackendController,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  resolveLaunch
} from "../main/backend-controller.js";
import { AssistController } from "../main/assist-controller.js";

test("fake backend uses Electron as Node without changing the production protocol", () => {
  const launch = resolveLaunch({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { MEETING_TRANSCRIBER_FAKE: "1" }
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [path.resolve("desktop/test/fake-backend.js")]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
});

test("an explicit Python executable is honored and backend src is placed on PYTHONPATH", () => {
  const backendRoot = path.resolve("backend");
  const launch = resolveLaunch({
    backendRoot,
    fakeBackendPath: null,
    env: { MEETING_TRANSCRIBER_PYTHON: process.execPath, PYTHONPATH: "existing-path" }
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ["-m", "meeting_transcriber"]);
  assert.equal(launch.env.PYTHONPATH, `${path.join(backendRoot, "src")}${path.delimiter}existing-path`);
});

test("an explicit Python command name does not need to be an absolute path", () => {
  const launch = resolveLaunch({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: null,
    env: { MEETING_TRANSCRIBER_PYTHON: "python-custom" }
  });
  assert.equal(launch.command, "python-custom");
});

test("a verified launcher preserves isolation flags and strips Python environment injection", () => {
  const launch = resolveLaunch({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: null,
    env: {
      PATH: "safe-path",
      PYTHONHOME: "private-home",
      PythonPath: "private-module-path",
      VIRTUAL_ENV: "private-venv",
      PIP_INDEX_URL: "https://token@example.invalid"
    },
    verifiedLaunch: { command: "py", prefixArgs: ["-3.12", "-I", "-B"] }
  });

  assert.equal(launch.command, "py");
  assert.deepEqual(launch.args, ["-3.12", "-I", "-B", "-m", "meeting_transcriber"]);
  assert.equal(launch.env.PATH, "safe-path");
  assert.equal(launch.env.PYTHONHOME, undefined);
  assert.equal(launch.env.PythonPath, undefined);
  assert.equal(launch.env.VIRTUAL_ENV, undefined);
  assert.equal(launch.env.PIP_INDEX_URL, undefined);
  assert.equal(launch.env.PYTHONPATH, undefined);
  assert.equal(launch.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(launch.env.PYTHONNOUSERSITE, "1");
  assert.equal(launch.env.PYTHONUTF8, "1");
});

test("a verified bundled sidecar launches directly without Python module arguments", () => {
  const launch = resolveLaunch({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: null,
    env: {
      PATH: "safe-path",
      PYTHONHOME: "private-home",
      PIP_INDEX_URL: "https://token@example.invalid"
    },
    verifiedLaunch: {
      kind: "sidecar",
      command: path.resolve("resources/sidecar/meeting-transcriber-sidecar.exe"),
      prefixArgs: []
    }
  });

  assert.equal(launch.command.endsWith("meeting-transcriber-sidecar.exe"), true);
  assert.deepEqual(launch.args, []);
  assert.equal(launch.env.PATH, "safe-path");
  assert.equal(launch.env.PYTHONHOME, undefined);
  assert.equal(launch.env.PIP_INDEX_URL, undefined);
});

test("the controller launches only the verified runtime without a shell", async () => {
  let invocation;
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: null,
    env: {},
    getVerifiedLaunch: () => ({ command: "py", prefixArgs: ["-3.12"] }),
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      return new ControlledChild({ autoReady: true, blockFirstAudio: false, exitOnShutdown: true });
    }
  });

  await controller.startSession({ model: "small" });

  assert.equal(invocation.command, "py");
  assert.deepEqual(invocation.args, ["-3.12", "-I", "-B", "-m", "meeting_transcriber"]);
  assert.equal(invocation.options.shell, false);
  await controller.shutdown();
});

test("the default stop budget preserves slow local finalization", () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js")
  });

  assert.equal(controller.stopTimeoutMs, 120_000);
});

test("the default start budget allows first-use model provisioning", () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js")
  });

  assert.equal(controller.startTimeoutMs, 20 * 60_000);
});

test("the renderer close ceiling excludes the cancellable provisioning budget", () => {
  const closeReadyBudgetMs = STOP_TIMEOUT_MS + 30_000;
  assert.equal(START_TIMEOUT_MS, 20 * 60_000);
  assert.equal(closeReadyBudgetMs, 150_000);
  assert.equal(closeReadyBudgetMs < START_TIMEOUT_MS, true);
});

test("fake sidecar exercises the same start, audio, stop, and shutdown lifecycle", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { ...process.env, MEETING_TRANSCRIBER_FAKE: "1" }
  });
  const events = [];
  const assist = new AssistController({
    provider: Object.freeze({
      async *streamAssist() {}
    })
  });
  controller.on("event", (event) => {
    events.push(event);
    assist.ingest(event);
  });

  try {
    const ready = await controller.startSession({ model: "small", device: "cpu", compute: "int8" });
    assert.equal(ready.status, "ready");
    assist.startSession(ready.session_id);
    const liveFinal = controller.waitForEvent(
      (event) => event.type === "final_segment" ? { resolve: event } : null,
      1_000,
      "The fake backend did not emit live finalized text."
    );
    await controller.sendAudio({
      track: "system",
      startMs: 0,
      endMs: 200,
      pcm: new Uint8Array(6_400)
    });
    const finalizedWhileActive = await liveFinal;
    const reviewed = assist.freezeContextForRequest();
    assert.equal(controller.sessionState, "ready");
    assert.equal(reviewed.sessionId, ready.session_id);
    assert.deepEqual(
      reviewed.segments.map(({ id, revision, text }) => ({ id, revision, text })),
      [{ id: "fake-segment-1", revision: 2, text: "Local test transcript." }]
    );
    await controller.stopSession();
    assert.equal(events.some(({ type }) => type === "partial_transcript"), true);
    assert.deepEqual(
      events
        .filter(({ type, session_id }) => type === "final_segment" && session_id === ready.session_id)
        .map(({ segment }) => segment.revision),
      [2, 3]
    );
    assert.equal(events.some(({ type }) => type === "session_stopped"), true);
    assert.equal(
      events.indexOf(finalizedWhileActive) < events.findIndex(({ type }) => type === "session_stopped"),
      true
    );

    const secondReady = await controller.startSession({ model: "small", device: "cpu", compute: "int8" });
    assert.equal(secondReady.status, "ready");
    assist.startSession(secondReady.session_id);
    await controller.sendAudio({
      track: "microphone",
      startMs: 0,
      endMs: 200,
      pcm: new Uint8Array(6_400)
    });
    await controller.stopSession();
    assert.equal(events.filter(({ type, status }) => type === "engine_status" && status === "ready").length, 2);
    assert.equal(events.filter(({ type }) => type === "session_stopped").length, 2);
    assert.deepEqual(
      events
        .filter(({ type, session_id }) => type === "final_segment" && session_id === secondReady.session_id)
        .map(({ segment }) => segment.revision),
      [2, 3]
    );
  } finally {
    await controller.shutdown();
  }
});

test("fake sidecar exposes original finals before delayed translation updates", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: {
      ...process.env,
      MEETING_TRANSCRIBER_FAKE: "1",
      MEETING_TRANSCRIBER_FAKE_TRANSLATION_DELAY_MS: "75"
    }
  });
  const events = [];
  controller.on("event", (event) => events.push(event));

  try {
    const ready = await controller.startSession({
      model: "small",
      language: "en",
      device: "cpu",
      compute: "int8",
      translation: "en_to_pt_br"
    });
    const liveFinal = controller.waitForEvent(
      (event) => event.type === "final_segment" ? { resolve: event } : null,
      1_000,
      "The fake backend did not emit original finalized text."
    );
    const translationUpdate = controller.waitForEvent(
      (event) => event.type === "segment_translation" ? { resolve: event } : null,
      1_000,
      "The fake backend did not emit a delayed translation update."
    );

    await controller.sendAudio({
      track: "system",
      startMs: 0,
      endMs: 200,
      pcm: new Uint8Array(6_400)
    });

    const original = await liveFinal;
    assert.equal(original.segment.translated_text ?? null, null);
    assert.equal(original.segment.translated_language ?? null, null);
    const translated = await translationUpdate;
    assert.deepEqual(translated, {
      type: "segment_translation",
      session_id: ready.session_id,
      segment_id: original.segment.id,
      segment_revision: original.segment.revision,
      translated_text: "Transcrição local de teste.",
      translated_language: "pt-BR"
    });
    assert.equal(events.indexOf(original) < events.indexOf(translated), true);

    await controller.stopSession();
    const stoppedIndex = events.findIndex(({ type }) => type === "session_stopped");
    const acceptedUpdates = events.filter(({ type }) => type === "segment_translation");
    assert.equal(acceptedUpdates.length, 2);
    assert.equal(events.indexOf(acceptedUpdates.at(-1)) < stoppedIndex, true);
  } finally {
    await controller.shutdown();
  }
});

test("fake sidecar drains accepted translation updates during active shutdown", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: {
      ...process.env,
      MEETING_TRANSCRIBER_FAKE: "1",
      MEETING_TRANSCRIBER_FAKE_TRANSLATION_DELAY_MS: "75"
    }
  });
  const events = [];
  controller.on("event", (event) => events.push(event));

  const ready = await controller.startSession({
    model: "small",
    language: "en",
    device: "cpu",
    compute: "int8",
    translation: "en_to_pt_br"
  });
  await controller.sendAudio({
    track: "microphone",
    startMs: 0,
    endMs: 200,
    pcm: new Uint8Array(6_400)
  });
  await controller.shutdown();

  const sessionEvents = events.filter(({ session_id }) => session_id === ready.session_id);
  const translations = sessionEvents.filter(({ type }) => type === "segment_translation");
  const stoppedIndex = sessionEvents.findIndex(({ type }) => type === "session_stopped");
  const shutdownIndex = events.findIndex(
    ({ type, status }) => type === "engine_status" && status === "shutdown"
  );
  const stoppedGlobalIndex = events.indexOf(sessionEvents[stoppedIndex]);
  assert.deepEqual(translations.map(({ segment_revision }) => segment_revision), [2, 3]);
  assert.equal(sessionEvents.indexOf(translations.at(-1)) < stoppedIndex, true);
  assert.equal(stoppedGlobalIndex < shutdownIndex, true);
  assert.equal(events[shutdownIndex].session_id ?? null, null);
});

test("the controller sends the selected model, language, and diarization fields on start", async () => {
  let child;
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    spawnProcess: () => {
      child = new ControlledChild({ autoReady: true, blockFirstAudio: false, exitOnShutdown: true });
      return child;
    }
  });
  const diarizationModel = path.resolve("user-data/models/wespeaker_en_voxceleb_CAM++.onnx");

  await controller.startSession({
    model: "medium.en",
    language: "en",
    device: "cpu",
    compute: "int8",
    diarization: "online",
    diarization_model: diarizationModel
  });

  assert.deepEqual(child.commands[0], {
    type: "start",
    model: "medium.en",
    language: "en",
    device: "cpu",
    compute: "int8",
    diarization: "online",
    diarization_model: diarizationModel
  });
  await controller.shutdown();
});

test("a launch failure leaves the controller retryable instead of wedged in starting", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: null,
    env: { ...process.env, MEETING_TRANSCRIBER_PYTHON: "definitely-missing-python-command" },
    startTimeoutMs: 100,
    shutdownTimeoutMs: 100
  });

  await assert.rejects(controller.startSession({ model: "small" }));
  assert.equal(controller.sessionState, "failed");
  assert.equal(controller.child, null);
});

test("a start timeout terminates the ambiguous child before a retry", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: {
      ...process.env,
      MEETING_TRANSCRIBER_FAKE: "1",
      MEETING_TRANSCRIBER_FAKE_START_DELAY_MS: "250"
    },
    startTimeoutMs: 20,
    shutdownTimeoutMs: 200
  });

  await assert.rejects(controller.startSession({ model: "small" }), /too long to start/);
  assert.equal(controller.sessionState, "failed");
  assert.equal(controller.child, null);
});

test("an in-progress first-use start can be canceled within the shutdown budget", async () => {
  let child;
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    spawnProcess: () => {
      child = new ControlledChild({
        autoReady: false,
        blockFirstAudio: false,
        exitOnShutdown: true
      });
      return child;
    },
    startTimeoutMs: 20 * 60_000,
    shutdownTimeoutMs: 100,
    forceKillTimeoutMs: 100
  });

  const start = controller.startSession({ model: "medium.en" });
  start.catch(() => {});
  await child.waitForCommand("start");

  assert.equal(await controller.cancelStart(), true);
  await assert.rejects(start, /stopped/);
  assert.deepEqual(child.commands.map(({ type }) => type), ["start", "shutdown"]);
  assert.equal(controller.child, null);
  assert.equal(controller.sessionState, "failed");
});

test("a stop timeout terminates the ambiguous child before another session", async () => {
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: {
      ...process.env,
      MEETING_TRANSCRIBER_FAKE: "1",
      MEETING_TRANSCRIBER_FAKE_STOP_DELAY_MS: "250"
    },
    // This test targets the 20 ms stop timeout. Give process startup and
    // teardown normal headroom so parallel-suite load cannot fail the wrong
    // lifecycle phase before the stop assertion is reached.
    startTimeoutMs: 2_000,
    stopTimeoutMs: 20,
    shutdownTimeoutMs: 1_000
  });

  await controller.startSession({ model: "small" });
  await assert.rejects(controller.stopSession(), /timed out/);
  assert.equal(controller.sessionState, "failed");
  assert.equal(controller.child, null);
});

test("forced shutdown waits for termination confirmation before allowing a replacement", async () => {
  const children = [];
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { ...process.env, MEETING_TRANSCRIBER_FAKE: "1" },
    spawnProcess: () => {
      const child = new ControlledChild({
        autoReady: children.length === 0,
        blockFirstAudio: children.length === 0,
        exitOnShutdown: children.length > 0
      });
      children.push(child);
      return child;
    },
    startTimeoutMs: 500,
    shutdownTimeoutMs: 0,
    forceKillTimeoutMs: 500
  });

  await controller.startSession({ model: "small" });
  const first = children[0];
  const audioWrite = controller.sendAudio({
    track: "system",
    startMs: 0,
    endMs: 200,
    pcm: new Uint8Array(6_400)
  });
  audioWrite.catch(() => {});
  await first.waitForCommand("audio");

  let shutdownSettled = false;
  const shutdown = controller.shutdown().finally(() => {
    shutdownSettled = true;
  });
  await first.waitForKill();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.killed, true);
  assert.equal(shutdownSettled, false);
  assert.equal(controller.child, first);

  first.close(0, "SIGTERM");
  await shutdown;
  assert.equal(controller.child, null);

  const retry = controller.startSession({ model: "small" });
  const second = children[1];
  await second.waitForCommand("start");

  first.releaseBlockedWrite();
  await audioWrite;
  await first.waitForCommand("shutdown");
  assert.deepEqual(second.commands.map(({ type }) => type), ["start"]);

  first.exit(0, "SIGTERM");
  second.emitReady();
  const ready = await retry;

  assert.equal(ready.status, "ready");
  assert.equal(controller.child, second);
  assert.equal(controller.sessionState, "ready");
  assert.deepEqual(first.commands.map(({ type }) => type), ["start", "audio", "shutdown"]);
  assert.deepEqual(second.commands.map(({ type }) => type), ["start"]);

  await controller.shutdown();
});

test("an unconfirmed forced termination fails closed until the old child really exits", async () => {
  const children = [];
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { ...process.env, MEETING_TRANSCRIBER_FAKE: "1" },
    spawnProcess: () => {
      const child = new ControlledChild({
        autoReady: true,
        blockFirstAudio: false,
        exitOnShutdown: children.length > 0
      });
      children.push(child);
      return child;
    },
    startTimeoutMs: 500,
    shutdownTimeoutMs: 0,
    forceKillTimeoutMs: 10
  });

  await controller.startSession({ model: "small" });
  const first = children[0];

  await assert.rejects(controller.shutdown(), /not confirmed/);
  assert.equal(first.killed, true);
  assert.equal(controller.child, first);
  assert.equal(controller.sessionState, "failed");
  assert.equal(children.length, 1);

  await assert.rejects(
    controller.startSession({ model: "small" }),
    /not been confirmed yet/
  );
  assert.equal(controller.child, first);
  assert.equal(children.length, 1);

  first.exit(0, "SIGTERM");
  assert.equal(controller.child, null);

  const ready = await controller.startSession({ model: "small" });
  assert.equal(ready.status, "ready");
  assert.equal(children.length, 2);
  assert.equal(controller.child, children[1]);

  await controller.shutdown();
});

test("an unconfirmed cleanup does not mask the original start failure", async () => {
  let child = null;
  const controller = new BackendController({
    backendRoot: path.resolve("backend"),
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { ...process.env, MEETING_TRANSCRIBER_FAKE: "1" },
    spawnProcess: () => {
      child = new ControlledChild({
        autoReady: false,
        blockFirstAudio: false,
        exitOnShutdown: false
      });
      return child;
    },
    startTimeoutMs: 5,
    shutdownTimeoutMs: 0,
    forceKillTimeoutMs: 10
  });

  const error = await controller.startSession({ model: "small" }).catch((failure) => failure);

  assert.match(error.message, /too long to start/);
  assert.match(error.shutdownError?.message ?? "", /not confirmed/);
  assert.equal(controller.sessionState, "failed");
  assert.equal(controller.child, child);

  child.exit(0, "SIGTERM");
  assert.equal(controller.child, null);
});

class ControlledChild extends EventEmitter {
  constructor({ autoReady, blockFirstAudio, exitOnShutdown }) {
    super();
    this.autoReady = autoReady;
    this.blockFirstAudio = blockFirstAudio;
    this.exitOnShutdown = exitOnShutdown;
    this.commands = [];
    this.commandWaiters = new Set();
    this.blockedWrite = null;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.closed = false;
    this.killPromise = new Promise((resolve) => {
      this.resolveKill = resolve;
    });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => this.handleWrite(chunk, callback)
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  handleWrite(chunk, callback) {
    const command = JSON.parse(chunk.toString("utf8").trim());
    this.commands.push(command);
    this.resolveCommandWaiters(command);

    if (command.type === "start" && this.autoReady) {
      callback();
      queueMicrotask(() => this.emitReady());
      return;
    }
    if (command.type === "audio" && this.blockFirstAudio && !this.blockedWrite) {
      this.blockedWrite = callback;
      return;
    }
    if (command.type === "shutdown" && this.exitOnShutdown) {
      callback();
      queueMicrotask(() => {
        this.emitBackend({ type: "engine_status", status: "shutdown" });
        this.exit(0, null);
      });
      return;
    }
    callback();
  }

  emitReady() {
    this.emitBackend({
      type: "engine_status",
      status: "ready",
      session_id: "controlled-session",
      model: "fake",
      language: "pt",
      device: "cpu",
      compute: "int8"
    });
  }

  emitBackend(event) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  waitForCommand(type) {
    const existing = this.commands.find((command) => command.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.commandWaiters.add({ type, resolve }));
  }

  resolveCommandWaiters(command) {
    for (const waiter of [...this.commandWaiters]) {
      if (waiter.type !== command.type) continue;
      this.commandWaiters.delete(waiter);
      waiter.resolve(command);
    }
  }

  releaseBlockedWrite() {
    const callback = this.blockedWrite;
    this.blockedWrite = null;
    callback?.();
  }

  kill() {
    this.killed = true;
    this.resolveKill();
    return true;
  }

  waitForKill() {
    return this.killed ? Promise.resolve() : this.killPromise;
  }

  close(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }

  exit(code, signal) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
