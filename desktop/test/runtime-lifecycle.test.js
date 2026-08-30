import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RUNTIME_INTERRUPTION_REASONS,
  RuntimeLifecycleError,
  createRuntimeLifecycleCoordinator
} from "../main/runtime-lifecycle.js";

test("main renderer failures coalesce, invalidate capture, and expose only fixed reasons", async () => {
  const stopped = deferred();
  const fixture = createFixture({ stopPromise: stopped.promise });
  const token = fixture.coordinator.beginExplicitCaptureAttempt();
  assert.equal(fixture.coordinator.completeCaptureAttempt(token), true);
  const window = createWindowProbe();

  const firstCleanup = fixture.coordinator.bindMainWindow(window);
  assert.equal(fixture.coordinator.bindMainWindow(window), firstCleanup);
  assert.equal(window.listenerCount("unresponsive"), 1);
  assert.equal(window.webContents.listenerCount("render-process-gone"), 1);

  window.emit("unresponsive", { raw: "must-not-cross" });
  window.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 99 });
  window.webContents.emit(
    "did-fail-load",
    {},
    -3,
    "C:\\private\\secret.txt",
    "file:///C:/private/secret.txt",
    true
  );

  assert.equal(fixture.calls.cancelAssist.length, 1);
  assert.equal(fixture.calls.cancelProvider.length, 1);
  assert.equal(fixture.calls.stop.length, 1);
  assert.equal(fixture.calls.recoverMain.length, 1);
  assert.equal(fixture.coordinator.isCaptureAttemptCurrent(token), false);
  assert.equal(fixture.coordinator.isInterruptionLatched(), true);
  assert.throws(
    () => fixture.coordinator.beginExplicitCaptureAttempt(),
    (error) => error instanceof RuntimeLifecycleError && error.code === "runtime_cleanup_in_progress"
  );

  stopped.resolve();
  await fixture.coordinator.waitForIdle();
  assert.equal(fixture.calls.clear.length, 1);
  assert.deepEqual(fixture.calls.stop[0], { reason: "main_renderer_unresponsive" });
  assert.deepEqual(fixture.calls.recoverMain[0], { reason: "main_renderer_unresponsive" });
  assert.equal(JSON.stringify(fixture.calls).includes("private"), false);
  assert.equal(JSON.stringify(fixture.calls).includes("oom"), false);

  window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await fixture.coordinator.waitForIdle();
  assert.equal(fixture.calls.stop.length, 1);
  assert.equal(fixture.calls.recoverMain.length, 1);

  const nextToken = fixture.coordinator.beginExplicitCaptureAttempt();
  assert.equal(fixture.coordinator.completeCaptureAttempt(nextToken), true);
  window.webContents.emit("did-fail-load", {}, -3, "subframe", "https://invalid.test", false);
  assert.equal(fixture.calls.stop.length, 1);
  window.webContents.emit("did-fail-load", {}, -3, "main", "file:///app/index.html", true);
  await fixture.coordinator.waitForIdle();
  assert.equal(fixture.calls.stop.length, 2);
  assert.deepEqual(fixture.calls.stop[1], { reason: "main_renderer_load_failed" });
  assert.equal(fixture.calls.recoverMain.length, 2);
});

test("idle power suspend and resume are no-ops and do not latch an interruption", async () => {
  const fixture = createFixture();
  const powerMonitor = new EventEmitter();
  fixture.coordinator.bindPowerMonitor(powerMonitor);

  powerMonitor.emit("suspend");
  powerMonitor.emit("resume");
  await fixture.coordinator.waitForIdle();

  assert.deepEqual(fixture.calls, {
    cancelAssist: [],
    cancelProvider: [],
    stop: [],
    clear: [],
    publish: [],
    recoverMain: [],
    recoverOverlay: []
  });
  assert.equal(fixture.coordinator.isInterruptionLatched(), false);

  const token = fixture.coordinator.beginExplicitCaptureAttempt();
  assert.equal(fixture.coordinator.isCaptureAttemptCurrent(token), true);
  fixture.coordinator.finishCapture();
});

test("active power suspend and resume stop once without reloading the main renderer", async () => {
  const stopped = deferred();
  const fixture = createFixture({ stopPromise: stopped.promise });
  const powerMonitor = new EventEmitter();
  fixture.coordinator.bindPowerMonitor(powerMonitor);
  const token = fixture.coordinator.beginExplicitCaptureAttempt();
  fixture.coordinator.completeCaptureAttempt(token);

  powerMonitor.emit("suspend");
  powerMonitor.emit("resume");
  powerMonitor.emit("resume");

  assert.equal(fixture.calls.stop.length, 1);
  assert.equal(fixture.calls.recoverMain.length, 0);
  assert.deepEqual(fixture.calls.stop[0], { reason: "power_suspended" });

  stopped.resolve();
  await fixture.coordinator.waitForIdle();
  assert.equal(fixture.coordinator.isCaptureAttemptCurrent(token), false);
  assert.equal(fixture.calls.clear.length, 1);

  powerMonitor.emit("suspend");
  await fixture.coordinator.waitForIdle();
  assert.equal(fixture.calls.stop.length, 1);
  assert.equal(fixture.calls.recoverMain.length, 0);

  const freshToken = fixture.coordinator.beginExplicitCaptureAttempt();
  assert.equal(fixture.coordinator.isCaptureAttemptCurrent(freshToken), true);
  fixture.coordinator.finishCapture();
});

test("overlay renderer recovery is bounded and never changes meeting or provider state", async () => {
  const fixture = createFixture();
  const window = createWindowProbe();
  fixture.coordinator.bindOverlayWindow(window);

  window.webContents.emit("render-process-gone", {}, { reason: "crashed", raw: "secret" });
  window.webContents.emit("did-fail-load", {}, -2, "raw failure", "file:///private", true);
  assert.equal(fixture.calls.recoverOverlay.length, 1);
  assert.deepEqual(fixture.calls.recoverOverlay[0].context, {
    reason: "overlay_renderer_terminated"
  });

  window.webContents.emit("did-finish-load");
  window.webContents.emit("did-fail-load", {}, -2, "subframe", "https://invalid.test", false);
  assert.equal(fixture.calls.recoverOverlay.length, 1);
  window.webContents.emit("did-fail-load", {}, -2, "main", "file:///app/overlay.html", true);
  assert.equal(fixture.calls.recoverOverlay.length, 2);
  assert.deepEqual(fixture.calls.recoverOverlay[1].context, {
    reason: "overlay_renderer_load_failed"
  });

  assert.equal(fixture.calls.cancelAssist.length, 0);
  assert.equal(fixture.calls.cancelProvider.length, 0);
  assert.equal(fixture.calls.stop.length, 0);
  assert.equal(fixture.calls.clear.length, 0);
  assert.equal(fixture.calls.publish.length, 0);
});

test("bindings clean themselves up and coordinator destroy removes every handler", () => {
  const fixture = createFixture();
  const mainWindow = createWindowProbe();
  const overlayWindow = createWindowProbe();
  const powerMonitor = new EventEmitter();
  const unbindMain = fixture.coordinator.bindMainWindow(mainWindow);
  fixture.coordinator.bindOverlayWindow(overlayWindow);
  fixture.coordinator.bindPowerMonitor(powerMonitor);

  assert.equal(unbindMain(), true);
  assert.equal(unbindMain(), false);
  assert.equal(mainWindow.listenerCount("unresponsive"), 0);
  assert.equal(mainWindow.webContents.listenerCount("render-process-gone"), 0);

  fixture.coordinator.bindMainWindow(mainWindow);
  mainWindow.emit("closed");
  assert.equal(mainWindow.listenerCount("unresponsive"), 0);
  assert.equal(mainWindow.webContents.listenerCount("did-fail-load"), 0);

  fixture.coordinator.destroy();
  assert.equal(overlayWindow.webContents.listenerCount("render-process-gone"), 0);
  assert.equal(powerMonitor.listenerCount("suspend"), 0);
  assert.equal(powerMonitor.listenerCount("resume"), 0);

  overlayWindow.webContents.emit("render-process-gone");
  powerMonitor.emit("suspend");
  assert.equal(fixture.calls.recoverOverlay.length, 0);
  assert.equal(fixture.calls.stop.length, 0);
  assert.throws(
    () => fixture.coordinator.beginExplicitCaptureAttempt(),
    (error) => error.code === "runtime_lifecycle_destroyed"
  );
});

test("unsafe cleanup is fail-soft and always attempts transient-state clearing", async () => {
  const calls = [];
  const coordinator = createRuntimeLifecycleCoordinator({
    isMeetingActive: () => true,
    cancelAssist: () => { calls.push("assist"); throw new Error("private assist error"); },
    cancelProvider: () => { calls.push("provider"); throw new Error("private provider error"); },
    stopActiveMeeting: async ({ reason }) => {
      calls.push(`stop:${reason}`);
      throw new Error("private stop error");
    },
    clearTransientState: async ({ reason }) => {
      calls.push(`clear:${reason}`);
      throw new Error("private clear error");
    },
    publishInterruptedState: ({ reason }) => calls.push(`publish:${reason}`),
    recoverMainRenderer: () => {},
    recoverOverlayRenderer: () => {}
  });

  const result = await coordinator.handleUnsafeInterruption(
    RUNTIME_INTERRUPTION_REASONS.powerSuspend
  );
  assert.equal(result.status, "handled_with_errors");
  assert.equal(result.reason, "power_suspended");
  assert.deepEqual(calls, [
    "publish:power_suspended",
    "assist",
    "provider",
    "stop:power_suspended",
    "clear:power_suspended",
    "publish:power_suspended"
  ]);
  await assert.rejects(
    coordinator.handleUnsafeInterruption("C:\\private\\raw"),
    /reason is invalid/
  );
});

test("Electron main wires power and renderer failures through the incomplete-stop boundary", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  assert.match(main, /runtimeLifecycle\.bindPowerMonitor\(powerMonitor\)/);
  assert.match(main, /runtimeLifecycle\.bindMainWindow\(createdWindow\)/);
  assert.match(main, /BrowserWindow: RuntimeAwareOverlayWindow/);
  assert.match(main, /runtimeLifecycle\.bindOverlayWindow\(window\)/);
  assert.match(main, /runtimeLifecycle\.destroy\(\)/);

  const stop = sliceBetween(
    main,
    "async function stopMeetingAfterRuntimeInterruption",
    "async function clearInterruptedRuntimeState"
  );
  assert.equal(
    stop.indexOf("finalizeLocalDebriefSession") < stop.indexOf("await backend.stopSession()"),
    true
  );
  const clear = sliceBetween(
    main,
    "async function clearInterruptedRuntimeState",
    "function publishInterruptedRuntimeState"
  );
  for (const invariant of [
    "endAssistSession",
    "meetingInProgress = false",
    "successfulStop = false",
    "transcriptFiles.resetCurrentAutoSavePath()",
    'overlayController?.setMeetingState("stopped")',
    "runtimeLifecycle.finishCapture()"
  ]) assert.match(clear, new RegExp(escapeRegex(invariant)));
});

function createFixture({ stopPromise = null } = {}) {
  let active = false;
  const calls = {
    cancelAssist: [],
    cancelProvider: [],
    stop: [],
    clear: [],
    publish: [],
    recoverMain: [],
    recoverOverlay: []
  };
  const coordinator = createRuntimeLifecycleCoordinator({
    isMeetingActive: () => active,
    cancelAssist: (context) => calls.cancelAssist.push(context),
    cancelProvider: (context) => calls.cancelProvider.push(context),
    stopActiveMeeting: async (context) => {
      calls.stop.push(context);
      if (stopPromise) await stopPromise;
    },
    clearTransientState: async (context) => {
      calls.clear.push(context);
      active = false;
    },
    publishInterruptedState: (context) => calls.publish.push(context),
    recoverMainRenderer: (context) => calls.recoverMain.push(context),
    recoverOverlayRenderer: (window, context) => calls.recoverOverlay.push({ window, context })
  });
  const originalBegin = coordinator.beginExplicitCaptureAttempt;
  return {
    coordinator: Object.freeze({
      ...coordinator,
      beginExplicitCaptureAttempt() {
        const token = originalBegin();
        active = true;
        return token;
      }
    }),
    calls
  };
}

function createWindowProbe() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  return window;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function sliceBetween(value, start, end) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return value.slice(startIndex, endIndex);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
