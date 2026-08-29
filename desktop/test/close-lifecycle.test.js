import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloseCoordinator,
  createCloseReadyGate,
  finalizeCloseLifecycle,
  getWindowCloseAction,
  getWindowMinimizeAction
} from "../main/close-lifecycle.js";

test("window close and minimize policies are explicit and default to normal app behavior", () => {
  assert.equal(getWindowCloseAction({ closeBehavior: "quit" }), "quit");
  assert.equal(getWindowCloseAction({ closeBehavior: "tray" }), "hide");
  assert.equal(getWindowCloseAction({ closeBehavior: "tray", quitRequested: true }), "quit");
  assert.equal(getWindowCloseAction(), "quit");
  assert.equal(getWindowMinimizeAction({ minimizeToTray: true }), "hide");
  assert.equal(getWindowMinimizeAction({ minimizeToTray: false }), "minimize");
  assert.equal(getWindowMinimizeAction(), "minimize");
});

test("shutdown rejection releases the window and force-exits exactly once", async () => {
  const calls = [];

  const result = await finalizeCloseLifecycle({
    stopBackend: async () => calls.push("stop"),
    shutdownBackend: async () => {
      calls.push("shutdown");
      throw new Error("termination not confirmed");
    },
    releaseWindow: () => calls.push("release"),
    finishCleanly: () => calls.push("clean"),
    forceExit: (code) => calls.push(`force:${code}`)
  });

  assert.deepEqual(result, { forced: true });
  assert.deepEqual(calls, ["stop", "shutdown", "release", "force:1"]);
});

test("confirmed shutdown releases the window and completes without force-exit", async () => {
  const calls = [];

  const result = await finalizeCloseLifecycle({
    stopBackend: async () => calls.push("stop"),
    shutdownBackend: async () => calls.push("shutdown"),
    releaseWindow: () => calls.push("release"),
    finishCleanly: () => calls.push("clean"),
    forceExit: (code) => calls.push(`force:${code}`)
  });

  assert.deepEqual(result, { forced: false });
  assert.deepEqual(calls, ["stop", "shutdown", "release", "clean"]);
});

test("a completed non-quit close can be reused for a later window close cycle", async () => {
  const cycles = [];
  const coordinator = createCloseCoordinator(async ({ shouldQuit }) => {
    const cycle = { quit: shouldQuit() };
    cycles.push(cycle);
    return { forced: false };
  });

  const first = coordinator.request();
  assert.strictEqual(coordinator.request(), first);
  await first;

  const second = coordinator.request();
  assert.notStrictEqual(second, first);
  await second;

  assert.deepEqual(cycles, [{ quit: false }, { quit: false }]);
});

test("the close-ready gate preserves a slow renderer finalization until its explicit acknowledgement", async () => {
  let timeoutCallback = null;
  let timeoutValue = null;
  let clearedTimer = null;
  const timerToken = Symbol("close-timeout");
  const gate = createCloseReadyGate({
    timeoutMs: 250_000,
    setTimer(callback, milliseconds) {
      timeoutCallback = callback;
      timeoutValue = milliseconds;
      return timerToken;
    },
    clearTimer(token) {
      clearedTimer = token;
    }
  });
  let signaled = false;
  let completed = false;

  const waiting = gate.wait(() => {
    signaled = true;
  }).then(() => {
    completed = true;
  });
  await Promise.resolve();

  assert.equal(signaled, true);
  assert.equal(completed, false);
  assert.equal(timeoutValue, 250_000);
  assert.equal(typeof timeoutCallback, "function");

  gate.notify();
  await waiting;
  assert.equal(completed, true);
  assert.equal(clearedTimer, timerToken);
});
