import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  createShortcutRegistry
} from "../main/shortcut-registry.js";

class FakeGlobalShortcut {
  constructor() {
    this.callbacks = new Map();
    this.registerCalls = [];
    this.unregisterCalls = [];
    this.registerResults = new Map();
    this.unregisterErrors = new Set();
  }

  register(accelerator, callback) {
    this.registerCalls.push(accelerator);
    const queued = this.registerResults.get(accelerator);
    const result = queued?.length ? queued.shift() : true;
    if (result instanceof Error) throw result;
    if (result === true) this.callbacks.set(accelerator, callback);
    return result;
  }

  unregister(accelerator) {
    this.unregisterCalls.push(accelerator);
    if (this.unregisterErrors.has(accelerator)) throw new Error("native unregister detail");
    this.callbacks.delete(accelerator);
  }

  queueRegisterResults(accelerator, ...results) {
    this.registerResults.set(accelerator, results);
  }
}

test("every overlay action registers independently and reports a renderer-safe status", () => {
  const globalShortcut = new FakeGlobalShortcut();
  const calls = [];
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers((action) => calls.push(action))
  });

  const status = registry.registerAll();

  assert.equal(globalShortcut.registerCalls.length, SHORTCUT_DEFINITIONS.length);
  assert.deepEqual(globalShortcut.registerCalls, SHORTCUT_DEFINITIONS.map(({ accelerator }) => accelerator));
  assert.equal(status.canEnableClickThrough, true);
  assert.equal(status.shortcuts.length, SHORTCUT_DEFINITIONS.length);
  assert.ok(status.shortcuts.every(({ state, available, message }) => (
    state === "registered" && available === true && message === "Available"
  )));

  for (const { action, accelerator } of SHORTCUT_DEFINITIONS) {
    globalShortcut.callbacks.get(accelerator)();
    assert.equal(calls.at(-1), action);
  }
});

test("register false and register throws become visible unavailable states", () => {
  const globalShortcut = new FakeGlobalShortcut();
  globalShortcut.queueRegisterResults(DEFAULT_SHORTCUTS.showHide, false);
  globalShortcut.queueRegisterResults(DEFAULT_SHORTCUTS.focusAssist, new Error("private native detail"));
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers()
  });

  const status = registry.registerAll();
  const showHide = findStatus(status, "showHide");
  const focusAssist = findStatus(status, "focusAssist");
  const clickThrough = findStatus(status, "toggleClickThrough");

  assert.deepEqual(
    pickStatus(showHide),
    { state: "unavailable", available: false, reason: "registration_failed" }
  );
  assert.deepEqual(
    pickStatus(focusAssist),
    { state: "unavailable", available: false, reason: "registration_error" }
  );
  assert.deepEqual(
    pickStatus(clickThrough),
    { state: "blocked", available: false, reason: "recovery_unavailable" }
  );
  assert.match(showHide.message, /Unavailable/);
  assert.match(focusAssist.message, /Unavailable/);
  assert.equal(focusAssist.message.includes("private native detail"), false);
  assert.equal(
    globalShortcut.registerCalls.includes(DEFAULT_SHORTCUTS.toggleClickThrough),
    false
  );
  assert.equal(status.canEnableClickThrough, false);
});

test("click-through cannot run after its show/recovery shortcut is unregistered", () => {
  const globalShortcut = new FakeGlobalShortcut();
  let clickThroughCalls = 0;
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers((action) => {
      if (action === "toggleClickThrough") clickThroughCalls += 1;
    })
  });
  registry.registerAll();
  const staleClickThroughCallback = globalShortcut.callbacks.get(DEFAULT_SHORTCUTS.toggleClickThrough);

  const status = registry.unregister("showHide");

  assert.equal(status.canEnableClickThrough, false);
  assert.equal(findStatus(status, "showHide").state, "unregistered");
  assert.equal(findStatus(status, "toggleClickThrough").state, "blocked");
  assert.ok(globalShortcut.unregisterCalls.includes(DEFAULT_SHORTCUTS.toggleClickThrough));
  staleClickThroughCallback();
  assert.equal(clickThroughCalls, 0);

  registry.register("toggleClickThrough");
  assert.equal(findStatus(registry.getStatus(), "toggleClickThrough").state, "blocked");
  assert.equal(
    globalShortcut.registerCalls.filter((value) => value === DEFAULT_SHORTCUTS.toggleClickThrough).length,
    1
  );
});

test("retryUnavailable restores recovery first, then safely registers click-through", () => {
  const globalShortcut = new FakeGlobalShortcut();
  globalShortcut.queueRegisterResults(DEFAULT_SHORTCUTS.showHide, false, true);
  globalShortcut.queueRegisterResults(DEFAULT_SHORTCUTS.opacityDown, false, true);
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers()
  });
  const initial = registry.registerAll();
  assert.equal(initial.canEnableClickThrough, false);
  assert.equal(findStatus(initial, "toggleClickThrough").state, "blocked");

  const retried = registry.retryUnavailable();

  assert.equal(retried.canEnableClickThrough, true);
  assert.ok(retried.shortcuts.every(({ state }) => state === "registered"));
  assert.equal(
    globalShortcut.registerCalls.filter((value) => value === DEFAULT_SHORTCUTS.showHide).length,
    2
  );
  assert.equal(
    globalShortcut.registerCalls.filter((value) => value === DEFAULT_SHORTCUTS.toggleClickThrough).length,
    1
  );
});

test("unregisterAll, reset, and destroy affect only this registry's accelerators", () => {
  const globalShortcut = new FakeGlobalShortcut();
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers()
  });
  registry.registerAll();

  const unregistered = registry.unregisterAll();
  assert.equal(unregistered.canEnableClickThrough, false);
  assert.ok(unregistered.shortcuts.every(({ state }) => (
    state === "unregistered" || state === "blocked"
  )));
  assert.equal(typeof globalShortcut.unregisterAll, "undefined");
  for (const accelerator of Object.values(DEFAULT_SHORTCUTS)) {
    assert.ok(globalShortcut.unregisterCalls.includes(accelerator));
  }

  const reset = registry.reset();
  assert.equal(reset.canEnableClickThrough, true);
  assert.ok(reset.shortcuts.every(({ state }) => state === "registered"));

  const staleCallback = globalShortcut.callbacks.get(DEFAULT_SHORTCUTS.focusAssist);
  registry.destroy();
  staleCallback();
  assert.throws(() => registry.registerAll(), /destroyed/);
  registry.destroy();
});

test("unregister errors are captured without exposing native details", () => {
  const globalShortcut = new FakeGlobalShortcut();
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers()
  });
  registry.registerAll();
  globalShortcut.unregisterErrors.add(DEFAULT_SHORTCUTS.opacityUp);

  const status = registry.unregister("opacityUp");
  const opacityUp = findStatus(status, "opacityUp");
  assert.equal(opacityUp.state, "unavailable");
  assert.equal(opacityUp.reason, "unregister_error");
  assert.equal(opacityUp.message.includes("native unregister detail"), false);
});

test("an old callback stays inert after native unregister failure and recovery re-registration", () => {
  const globalShortcut = new FakeGlobalShortcut();
  let clickThroughCalls = 0;
  const registry = createShortcutRegistry({
    globalShortcut,
    handlers: createHandlers((action) => {
      if (action === "toggleClickThrough") clickThroughCalls += 1;
    })
  });
  registry.registerAll();
  const staleCallback = globalShortcut.callbacks.get(DEFAULT_SHORTCUTS.toggleClickThrough);
  globalShortcut.unregisterErrors.add(DEFAULT_SHORTCUTS.toggleClickThrough);

  registry.unregister("showHide");
  globalShortcut.unregisterErrors.delete(DEFAULT_SHORTCUTS.toggleClickThrough);
  registry.register("showHide");
  staleCallback();

  assert.equal(registry.canEnableClickThrough(), true);
  assert.equal(clickThroughCalls, 0);
});

test("registry dependencies and custom accelerators use exact schemas", () => {
  const globalShortcut = new FakeGlobalShortcut();
  assert.throws(() => createShortcutRegistry({ handlers: createHandlers() }), /globalShortcut/);
  assert.throws(
    () => createShortcutRegistry({ globalShortcut, handlers: { showHide: () => {} } }),
    /handler is required for every/
  );
  assert.throws(
    () => createShortcutRegistry({
      globalShortcut,
      handlers: createHandlers(),
      accelerators: { ...DEFAULT_SHORTCUTS, focusAssist: DEFAULT_SHORTCUTS.showHide }
    }),
    /accelerator is invalid/
  );
  assert.throws(
    () => createShortcutRegistry({
      globalShortcut,
      handlers: createHandlers(),
      accelerators: { ...DEFAULT_SHORTCUTS, extra: "F12" }
    }),
    /accelerator is required for every/
  );
});

function createHandlers(onCall = () => {}) {
  return Object.freeze(Object.fromEntries(
    SHORTCUT_DEFINITIONS.map(({ action }) => [action, () => onCall(action)])
  ));
}

function findStatus(status, action) {
  return status.shortcuts.find((shortcut) => shortcut.action === action);
}

function pickStatus(value) {
  return {
    state: value.state,
    available: value.available,
    reason: value.reason
  };
}
