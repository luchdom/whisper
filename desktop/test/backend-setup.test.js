import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BackendSetupManager } from "../main/backend-setup.js";

const backendRoot = path.resolve("backend");
const READY_COMPONENTS = Object.freeze({
  meeting_transcriber: "ready",
  faster_whisper: "ready",
  huggingface_hub: "ready",
  sherpa_onnx: "ready"
});
const BUNDLED_READY_COMPONENTS = Object.freeze({
  meeting_transcriber: "ready",
  faster_whisper: "ready",
  "faster_whisper.utils": "ready",
  huggingface_hub: "ready",
  numpy: "ready",
  sherpa_onnx: "ready",
  ctranslate2: "ready",
  "ctranslate2.converters": "ready",
  sentencepiece: "ready"
});

test("fake mode is ready without probing Python or model providers", async () => {
  let spawnCount = 0;
  const manager = new BackendSetupManager({
    backendRoot: "missing-backend-is-not-used-in-fake-mode",
    fakeBackendPath: path.resolve("desktop/test/fake-backend.js"),
    env: { MEETING_TRANSCRIBER_FAKE: "1" },
    spawnProcess: () => {
      spawnCount += 1;
      throw new Error("must not spawn");
    }
  });

  assert.deepEqual(await manager.check(), {
    state: "ready",
    pythonVersion: null,
    components: READY_COMPONENTS
  });
  assert.equal(spawnCount, 0);
  assert.deepEqual(manager.getVerifiedLaunch(), {
    command: process.execPath,
    prefixArgs: []
  });
});

test("fake mode fails closed when its configured sidecar resource is missing", async () => {
  let spawnCount = 0;
  const manager = new BackendSetupManager({
    backendRoot,
    fakeBackendPath: path.resolve("desktop/test/missing-fake-backend.js"),
    env: { MEETING_TRANSCRIBER_FAKE: "1" },
    spawnProcess: () => {
      spawnCount += 1;
      throw new Error("must not spawn");
    }
  });

  const result = await manager.check();

  assert.equal(result.state, "resource_missing");
  assert.equal(spawnCount, 0);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("an installed build verifies and selects only its bundled sidecar", async () => {
  const bundledSidecarPath = path.resolve(
    "resources/sidecar/meeting-transcriber-sidecar.exe"
  );
  const mock = createSpawnMock(() => ({ stdout: bundledProbePayload() }));
  const manager = new BackendSetupManager({
    backendRoot,
    bundledSidecarPath,
    allowSourceRuntime: false,
    env: {
      MEETING_TRANSCRIBER_FAKE: "1",
      MEETING_TRANSCRIBER_PYTHON: "must-not-run"
    },
    pathExists: (candidate) => candidate === bundledSidecarPath,
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.equal(result.state, "ready");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, bundledSidecarPath);
  assert.deepEqual(mock.calls[0].args, ["--setup-probe"]);
  assert.equal(mock.calls[0].options.shell, false);
  assert.deepEqual(manager.getVerifiedLaunch(), {
    kind: "sidecar",
    command: bundledSidecarPath,
    prefixArgs: []
  });
});

test("an installed build preserves every bundled component and rejects broken translation", async () => {
  const bundledSidecarPath = path.resolve(
    "resources/sidecar/meeting-transcriber-sidecar.exe"
  );
  const components = { ...BUNDLED_READY_COMPONENTS, sentencepiece: "broken" };
  const mock = createSpawnMock(() => ({
    stdout: bundledProbePayload({ components })
  }));
  const manager = new BackendSetupManager({
    backendRoot,
    bundledSidecarPath,
    allowSourceRuntime: false,
    env: {},
    pathExists: (candidate) => candidate === bundledSidecarPath,
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.equal(result.state, "components_broken");
  assert.deepEqual(result.components, components);
  assert.deepEqual(Object.keys(result.components), Object.keys(BUNDLED_READY_COMPONENTS));
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("an installed build rejects an incomplete bundled component schema", async () => {
  const bundledSidecarPath = path.resolve(
    "resources/sidecar/meeting-transcriber-sidecar.exe"
  );
  const components = { ...BUNDLED_READY_COMPONENTS };
  delete components["ctranslate2.converters"];
  const mock = createSpawnMock(() => ({
    stdout: bundledProbePayload({ components })
  }));
  const manager = new BackendSetupManager({
    backendRoot,
    bundledSidecarPath,
    allowSourceRuntime: false,
    env: {},
    pathExists: (candidate) => candidate === bundledSidecarPath,
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.equal(result.state, "check_failed");
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("an installed build fails closed when the bundled sidecar is absent", async () => {
  let spawnCount = 0;
  const manager = new BackendSetupManager({
    backendRoot,
    bundledSidecarPath: path.resolve("resources/sidecar/missing-sidecar.exe"),
    allowSourceRuntime: false,
    env: { MEETING_TRANSCRIBER_PYTHON: "must-not-run" },
    pathExists: () => false,
    spawnProcess: () => {
      spawnCount += 1;
      throw new Error("must not spawn");
    }
  });

  const result = await manager.check();

  assert.equal(result.state, "resource_missing");
  assert.equal(spawnCount, 0);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("the doctor checks the override first and verifies the Windows py prefix args", async () => {
  const mock = createSpawnMock(({ command }) => (
    command === "py"
      ? { stdout: probePayload() }
      : { errorCode: "ENOENT" }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    platform: "win32",
    spawnProcess: mock.spawn
  });

  const result = await manager.check();
  const pyCall = mock.calls.find(({ command }) => command === "py");

  assert.equal(result.state, "ready");
  assert.equal(result.pythonVersion, "3.12.0");
  assert.equal(mock.calls[0].command, "configured-python");
  assert.deepEqual(pyCall.args.slice(0, 4), ["-3.12", "-I", "-B", "-c"]);
  assert.equal(pyCall.options.shell, false);
  assert.deepEqual(pyCall.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(manager.getVerifiedLaunch(), {
    command: "py",
    prefixArgs: ["-3.12", "-I", "-B"]
  });
});

test("macOS command candidates are checked without a shell", async () => {
  const mock = createSpawnMock(() => ({ errorCode: "ENOENT" }));
  const manager = new BackendSetupManager({
    backendRoot,
    env: {},
    platform: "darwin",
    spawnProcess: mock.spawn,
    pathExists: (candidate) => candidate === path.join(
      backendRoot,
      "src",
      "meeting_transcriber",
      "__main__.py"
    )
  });

  const result = await manager.check();

  assert.equal(result.state, "python_missing");
  assert.deepEqual(mock.calls.map(({ command }) => command), ["python3.12", "python3"]);
  assert.equal(mock.calls.every(({ options }) => options.shell === false), true);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("Python 3.12.x is supported and a ready result is cached until forced", async () => {
  const mock = createSpawnMock(() => ({ stdout: probePayload({ version: [3, 12, 9] }) }));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn
  });

  const first = await manager.check();
  const cached = await manager.check();
  const forced = await manager.check({ force: true });

  assert.equal(first.state, "ready");
  assert.equal(first.pythonVersion, "3.12.9");
  assert.equal(cached, first);
  assert.equal(forced.state, "ready");
  assert.equal(mock.calls.length, 2);
});

test("Python versions newer than the supported 3.12 line remain fail-closed", async () => {
  const mock = createSpawnMock(({ command }) => (
    command === "configured-python"
      ? { stdout: probePayload({ version: [3, 13, 1] }) }
      : { errorCode: "ENOENT" }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.equal(result.state, "python_unsupported");
  assert.equal(result.pythonVersion, "3.13.1");
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("a non-CPython 3.12 interpreter is unsupported", async () => {
  const mock = createSpawnMock(({ command }) => (
    command === "configured-python"
      ? { stdout: probePayload({ implementation: "pypy" }) }
      : { errorCode: "ENOENT" }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.equal(result.state, "python_unsupported");
  assert.equal(result.pythonVersion, "3.12.0");
  assert.equal("implementation" in result, false);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("the isolated probe strips Python and pip injection variables and accepts import noise", async () => {
  const mock = createSpawnMock(() => ({ stdout: `dependency banner\n${probePayload()}` }));
  const manager = new BackendSetupManager({
    backendRoot,
    env: {
      MEETING_TRANSCRIBER_PYTHON: "configured-python",
      PATH: "safe-path",
      PYTHONHOME: "private-home",
      PythonPath: "private-module-path",
      VIRTUAL_ENV: "private-venv",
      PIP_INDEX_URL: "https://token@example.invalid"
    },
    spawnProcess: mock.spawn
  });

  const result = await manager.check();
  const probeEnvironment = mock.calls[0].options.env;

  assert.equal(result.state, "ready");
  assert.equal(probeEnvironment.PATH, "safe-path");
  assert.equal(probeEnvironment.PYTHONHOME, undefined);
  assert.equal(probeEnvironment.PythonPath, undefined);
  assert.equal(probeEnvironment.VIRTUAL_ENV, undefined);
  assert.equal(probeEnvironment.PIP_INDEX_URL, undefined);
  assert.equal(probeEnvironment.PYTHONNOUSERSITE, "1");
  assert.equal(probeEnvironment.PYTHONUTF8, "1");
});

test("an older Python is reported without exposing its executable", async () => {
  const mock = createSpawnMock(({ command }) => (
    command === "configured-python"
      ? { stdout: probePayload({ version: [3, 11, 9] }) }
      : { errorCode: "ENOENT" }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn
  });

  const result = await manager.check();

  assert.deepEqual(result, {
    state: "python_unsupported",
    pythonVersion: "3.11.9",
    components: READY_COMPONENTS
  });
  assert.equal(JSON.stringify(result).includes("configured-python"), false);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("missing and broken components have distinct sanitized states", async (t) => {
  for (const { componentState, expectedState } of [
    { componentState: "missing", expectedState: "components_missing" },
    { componentState: "broken", expectedState: "components_broken" }
  ]) {
    await t.test(componentState, async () => {
      const components = { ...READY_COMPONENTS, sherpa_onnx: componentState };
      const mock = createSpawnMock(({ command }) => (
        command === "configured-python"
          ? { stdout: probePayload({ components }) }
          : { errorCode: "ENOENT" }
      ));
      const manager = new BackendSetupManager({
        backendRoot,
        env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
        spawnProcess: mock.spawn
      });

      const result = await manager.check();

      assert.equal(result.state, expectedState);
      assert.equal(result.pythonVersion, "3.12.0");
      assert.equal(result.components.sherpa_onnx, componentState);
      assert.deepEqual(Object.keys(result).sort(), ["components", "pythonVersion", "state"]);
      assert.equal(manager.getVerifiedLaunch(), null);
    });
  }
});

test("a missing packaged backend resource is detected before Python runs", async () => {
  let spawnCount = 0;
  const manager = new BackendSetupManager({
    backendRoot: path.resolve("missing-backend"),
    env: {},
    spawnProcess: () => {
      spawnCount += 1;
      throw new Error("must not spawn");
    }
  });

  const result = await manager.check();

  assert.equal(result.state, "resource_missing");
  assert.equal(spawnCount, 0);
  assert.equal(result.pythonVersion, null);
  assert.equal(Object.values(result.components).every((value) => value === "unknown"), true);
});

test("probe failures are bounded and never relay stdout, stderr, paths, or exceptions", async () => {
  const secret = "private-path-and-stderr-must-not-escape";
  const mock = createSpawnMock(({ command }) => (
    command === "configured-python"
      ? { stdout: "x".repeat(1_000), stderr: secret }
      : { errorCode: "ENOENT" }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn,
    maxOutputBytes: 128
  });

  const result = await manager.check();
  const serialized = JSON.stringify(result);

  assert.equal(result.state, "check_failed");
  assert.equal(mock.children[0].killed, true);
  assert.equal(mock.children[0].closed, true);
  assert.deepEqual(mock.children[0].killSignals, ["SIGTERM"]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(backendRoot), false);
  assert.deepEqual(Object.keys(result).sort(), ["components", "pythonVersion", "state"]);
});

test("a hung probe waits for close and escalates to SIGKILL after the termination grace", async () => {
  const mock = createSpawnMock(() => ({ hang: true, closeOnSignal: "SIGKILL" }));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn,
    timeoutMs: 10,
    terminationGraceMs: 5
  });

  const result = await manager.check();

  assert.equal(result.state, "check_failed");
  assert.equal(mock.children.length, 1);
  assert.equal(mock.children[0].killed, true);
  assert.equal(mock.children[0].closed, true);
  assert.deepEqual(mock.children[0].killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(manager.getVerifiedLaunch(), null);
});

test("an unconfirmed SIGKILL blocks forced rechecks until the old probe closes", async () => {
  const mock = createSpawnMock(({ callIndex }) => (
    callIndex === 0
      ? { hang: true }
      : { stdout: probePayload() }
  ));
  const manager = new BackendSetupManager({
    backendRoot,
    env: { MEETING_TRANSCRIBER_PYTHON: "configured-python" },
    spawnProcess: mock.spawn,
    timeoutMs: 5,
    terminationGraceMs: 2
  });

  const first = await manager.check();
  const blockedRetry = await manager.check({ force: true });

  assert.equal(first.state, "check_failed");
  assert.equal(blockedRetry.state, "check_failed");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.children[0].closed, false);
  assert.deepEqual(mock.children[0].killSignals, ["SIGTERM", "SIGKILL"]);

  mock.children[0].emitClose(1);
  await new Promise((resolve) => setImmediate(resolve));

  const recovered = await manager.check({ force: true });
  assert.equal(recovered.state, "ready");
  assert.equal(mock.calls.length, 2);
});

function probePayload({
  version = [3, 12, 0],
  implementation = "cpython",
  components = READY_COMPONENTS
} = {}) {
  return `__MEETING_TRANSCRIBER_SETUP_V1__${JSON.stringify({
    version,
    implementation,
    components
  })}`;
}

function bundledProbePayload({
  version = [3, 12, 0],
  implementation = "cpython",
  components = BUNDLED_READY_COMPONENTS
} = {}) {
  return probePayload({ version, implementation, components });
}

function createSpawnMock(resolveOutcome) {
  const calls = [];
  const children = [];
  return {
    calls,
    children,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.closed = false;
      child.killSignals = [];
      const outcome = resolveOutcome({ command, args, options, callIndex: calls.length - 1 });
      const emitClose = (code = outcome.code ?? 0) => {
        if (child.closed) return;
        child.closed = true;
        child.emit("close", code, null);
      };
      child.emitClose = emitClose;
      child.kill = (signal = "SIGTERM") => {
        child.killed = true;
        child.killSignals.push(signal);
        if (outcome.closeOnSignal === signal) queueMicrotask(() => emitClose(1));
        return true;
      };
      children.push(child);
      queueMicrotask(() => {
        if (outcome.hang) return;
        if (outcome.errorCode) {
          const error = new Error("sensitive process error");
          error.code = outcome.errorCode;
          child.emit("error", error);
          return;
        }
        if (outcome.stdout) child.stdout.write(outcome.stdout);
        if (outcome.stderr) child.stderr.write(outcome.stderr);
        emitClose();
      });
      return child;
    }
  };
}
