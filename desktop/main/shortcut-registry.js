export const SHORTCUT_REGISTRY_VERSION = 1;

export const SHORTCUT_DEFINITIONS = Object.freeze([
  Object.freeze({
    action: "showHide",
    label: "Show or hide overlay",
    accelerator: "CommandOrControl+Shift+Space"
  }),
  Object.freeze({
    action: "focusAssist",
    label: "Focus Copilot",
    accelerator: "CommandOrControl+Shift+A"
  }),
  Object.freeze({
    action: "cancelAssist",
    label: "Cancel Assist",
    accelerator: "CommandOrControl+Shift+Esc"
  }),
  Object.freeze({
    action: "opacityUp",
    label: "Increase overlay opacity",
    accelerator: "CommandOrControl+Alt+Up"
  }),
  Object.freeze({
    action: "opacityDown",
    label: "Decrease overlay opacity",
    accelerator: "CommandOrControl+Alt+Down"
  }),
  Object.freeze({
    action: "toggleClickThrough",
    label: "Toggle click-through",
    accelerator: "CommandOrControl+Shift+X"
  })
]);

export const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(
  SHORTCUT_DEFINITIONS.map(({ action, accelerator }) => [action, accelerator])
));

const ACTIONS = Object.freeze(SHORTCUT_DEFINITIONS.map(({ action }) => action));
const ACTION_SET = new Set(ACTIONS);
const RECOVERY_ACTION = "showHide";
const CLICK_THROUGH_ACTION = "toggleClickThrough";
const STATUS_COPY = Object.freeze({
  registered: "Available",
  unavailable: "Unavailable — another application or system setting may be using this shortcut.",
  blocked: "Unavailable until the Show or hide overlay shortcut is available.",
  unregistered: "Not registered."
});

export function createShortcutRegistry({
  globalShortcut,
  handlers,
  accelerators = DEFAULT_SHORTCUTS
} = {}) {
  assertGlobalShortcut(globalShortcut);
  const actionHandlers = validateHandlers(handlers);
  const actionAccelerators = validateAccelerators(accelerators);
  const statusByAction = new Map(ACTIONS.map((action) => [
    action,
    createInternalStatus(action, "unregistered", "not_registered")
  ]));
  const generationByAction = new Map(ACTIONS.map((action) => [action, 0]));
  let destroyed = false;

  function registerAll() {
    assertActive();
    unregisterAllInternal();
    for (const action of ACTIONS) registerInternal(action);
    return getStatus();
  }

  function register(action) {
    assertActive();
    assertAction(action);
    if (statusByAction.get(action).state === "registered") return getStatus();
    registerInternal(action);
    return getStatus();
  }

  function unregister(action) {
    assertActive();
    assertAction(action);
    unregisterInternal(action, { cascadeRecovery: true });
    return getStatus();
  }

  function unregisterAll() {
    assertActive();
    unregisterAllInternal();
    return getStatus();
  }

  function retry(action) {
    assertActive();
    assertAction(action);
    unregisterInternal(action, { cascadeRecovery: true });
    registerInternal(action);
    return getStatus();
  }

  function retryUnavailable() {
    assertActive();
    if (statusByAction.get(RECOVERY_ACTION).state !== "registered") {
      unregisterInternal(RECOVERY_ACTION, { cascadeRecovery: true });
      registerInternal(RECOVERY_ACTION);
    }
    for (const action of ACTIONS) {
      if (action === RECOVERY_ACTION) continue;
      if (statusByAction.get(action).state !== "registered") {
        unregisterInternal(action, { cascadeRecovery: false });
        registerInternal(action);
      }
    }
    return getStatus();
  }

  function reset() {
    assertActive();
    unregisterAllInternal();
    for (const action of ACTIONS) registerInternal(action);
    return getStatus();
  }

  function getStatus() {
    return Object.freeze({
      version: SHORTCUT_REGISTRY_VERSION,
      canEnableClickThrough: canEnableClickThrough(),
      shortcuts: Object.freeze(SHORTCUT_DEFINITIONS.map((definition) => {
        const status = statusByAction.get(definition.action);
        return Object.freeze({
          action: definition.action,
          label: definition.label,
          accelerator: actionAccelerators[definition.action],
          state: status.state,
          available: status.state === "registered",
          reason: status.reason,
          message: STATUS_COPY[status.state]
        });
      }))
    });
  }

  function canEnableClickThrough() {
    return statusByAction.get(RECOVERY_ACTION).state === "registered";
  }

  function destroy() {
    if (destroyed) return;
    unregisterAllInternal();
    destroyed = true;
  }

  function registerInternal(action) {
    if (action === CLICK_THROUGH_ACTION && !canEnableClickThrough()) {
      statusByAction.set(action, createInternalStatus(action, "blocked", "recovery_unavailable"));
      return;
    }

    const accelerator = actionAccelerators[action];
    const generation = generationByAction.get(action) + 1;
    generationByAction.set(action, generation);
    try {
      const registered = globalShortcut.register(accelerator, () => {
        if (destroyed) return;
        if (generationByAction.get(action) !== generation) return;
        if (statusByAction.get(action).state !== "registered") return;
        if (action === CLICK_THROUGH_ACTION && !canEnableClickThrough()) return;
        actionHandlers[action]();
      });
      statusByAction.set(action, registered === true
        ? createInternalStatus(action, "registered", null)
        : createInternalStatus(action, "unavailable", "registration_failed"));
    } catch {
      statusByAction.set(action, createInternalStatus(action, "unavailable", "registration_error"));
    }

    if (action === RECOVERY_ACTION && !canEnableClickThrough()) {
      unregisterInternal(CLICK_THROUGH_ACTION, { cascadeRecovery: false });
      statusByAction.set(
        CLICK_THROUGH_ACTION,
        createInternalStatus(CLICK_THROUGH_ACTION, "blocked", "recovery_unavailable")
      );
    }
  }

  function unregisterInternal(action, { cascadeRecovery = false } = {}) {
    if (action === RECOVERY_ACTION && cascadeRecovery) {
      unregisterInternal(CLICK_THROUGH_ACTION, { cascadeRecovery: false });
    }

    const current = statusByAction.get(action);
    generationByAction.set(action, generationByAction.get(action) + 1);
    try {
      globalShortcut.unregister(actionAccelerators[action]);
      statusByAction.set(action, createInternalStatus(action, "unregistered", "not_registered"));
    } catch {
      statusByAction.set(action, createInternalStatus(action, "unavailable", "unregister_error"));
    }

    if (action === RECOVERY_ACTION && current?.state !== "unregistered") {
      const clickThrough = statusByAction.get(CLICK_THROUGH_ACTION);
      if (clickThrough.state !== "unavailable" || clickThrough.reason !== "unregister_error") {
        statusByAction.set(
          CLICK_THROUGH_ACTION,
          createInternalStatus(CLICK_THROUGH_ACTION, "blocked", "recovery_unavailable")
        );
      }
    }
  }

  function unregisterAllInternal() {
    unregisterInternal(CLICK_THROUGH_ACTION, { cascadeRecovery: false });
    for (const action of [...ACTIONS].reverse()) {
      if (action !== CLICK_THROUGH_ACTION) {
        unregisterInternal(action, { cascadeRecovery: false });
      }
    }
  }

  function assertActive() {
    if (destroyed) throw new Error("The shortcut registry has been destroyed.");
  }

  return Object.freeze({
    registerAll,
    register,
    unregister,
    unregisterAll,
    retry,
    retryUnavailable,
    reset,
    getStatus,
    canEnableClickThrough,
    destroy
  });
}

function validateHandlers(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== ACTIONS.length
    || Object.keys(value).some((action) => !ACTION_SET.has(action))) {
    throw new TypeError("A handler is required for every shortcut action.");
  }
  for (const action of ACTIONS) {
    if (typeof value[action] !== "function") {
      throw new TypeError(`The ${action} shortcut handler is required.`);
    }
  }
  return Object.freeze({ ...value });
}

function validateAccelerators(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== ACTIONS.length
    || Object.keys(value).some((action) => !ACTION_SET.has(action))) {
    throw new TypeError("An accelerator is required for every shortcut action.");
  }

  const accelerators = {};
  const seen = new Set();
  for (const action of ACTIONS) {
    const accelerator = value[action];
    if (typeof accelerator !== "string"
      || accelerator.length === 0
      || accelerator.length > 128
      || seen.has(accelerator)) {
      throw new TypeError(`The ${action} shortcut accelerator is invalid.`);
    }
    seen.add(accelerator);
    accelerators[action] = accelerator;
  }
  return Object.freeze(accelerators);
}

function assertGlobalShortcut(value) {
  if (!value
    || typeof value.register !== "function"
    || typeof value.unregister !== "function") {
    throw new TypeError("An Electron globalShortcut implementation is required.");
  }
}

function assertAction(action) {
  if (!ACTION_SET.has(action)) throw new TypeError("The shortcut action is invalid.");
}

function createInternalStatus(action, state, reason) {
  return Object.freeze({ action, state, reason });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
