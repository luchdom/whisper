const INTERRUPTION_REASONS = Object.freeze({
  powerSuspend: "power_suspended",
  powerResume: "power_resumed",
  mainUnresponsive: "main_renderer_unresponsive",
  mainProcessGone: "main_renderer_terminated",
  mainLoadFailed: "main_renderer_load_failed",
  overlayProcessGone: "overlay_renderer_terminated",
  overlayLoadFailed: "overlay_renderer_load_failed"
});

const UNSAFE_REASONS = new Set([
  INTERRUPTION_REASONS.powerSuspend,
  INTERRUPTION_REASONS.powerResume,
  INTERRUPTION_REASONS.mainUnresponsive,
  INTERRUPTION_REASONS.mainProcessGone,
  INTERRUPTION_REASONS.mainLoadFailed
]);

export const RUNTIME_INTERRUPTION_REASONS = INTERRUPTION_REASONS;

export class RuntimeLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeLifecycleError";
    this.code = code;
  }
}

export function createRuntimeLifecycleCoordinator({
  isMeetingActive = () => false,
  cancelAssist,
  cancelProvider,
  stopActiveMeeting,
  clearTransientState,
  publishInterruptedState,
  recoverMainRenderer,
  recoverOverlayRenderer
} = {}) {
  assertFunction(isMeetingActive, "isMeetingActive");
  assertFunction(cancelAssist, "cancelAssist");
  assertFunction(cancelProvider, "cancelProvider");
  assertFunction(stopActiveMeeting, "stopActiveMeeting");
  assertFunction(clearTransientState, "clearTransientState");
  assertFunction(publishInterruptedState, "publishInterruptedState");
  assertFunction(recoverMainRenderer, "recoverMainRenderer");
  assertFunction(recoverOverlayRenderer, "recoverOverlayRenderer");

  let destroyed = false;
  let generation = 0;
  let captureAttempt = null;
  let handledGeneration = null;
  let activeCleanup = null;
  let mainRecoveryGeneration = null;
  const bindings = new Set();
  const mainWindowBindings = new WeakMap();
  const overlayWindowBindings = new WeakMap();
  const powerMonitorBindings = new WeakMap();

  function beginExplicitCaptureAttempt() {
    assertActive();
    if (activeCleanup) {
      throw new RuntimeLifecycleError(
        "runtime_cleanup_in_progress",
        "Wait for runtime cleanup to finish before starting a new meeting."
      );
    }
    if (captureAttempt?.state === "pending" || safeMeetingActive()) {
      throw new RuntimeLifecycleError(
        "capture_attempt_in_progress",
        "A transcription session is already changing state."
      );
    }

    generation += 1;
    const token = Object.freeze({ generation });
    captureAttempt = { token, state: "pending", interrupted: false };
    handledGeneration = null;
    mainRecoveryGeneration = null;
    return token;
  }

  function completeCaptureAttempt(token) {
    if (!isCaptureAttemptCurrent(token) || captureAttempt.state !== "pending") return false;
    captureAttempt.state = "active";
    return true;
  }

  function failCaptureAttempt(token) {
    if (captureAttempt?.token !== token || captureAttempt.state !== "pending") return false;
    captureAttempt = null;
    return true;
  }

  function finishCapture() {
    captureAttempt = null;
  }

  function isCaptureAttemptCurrent(token) {
    return Boolean(
      !destroyed
        && captureAttempt?.token === token
        && captureAttempt.interrupted !== true
        && handledGeneration !== generation
    );
  }

  function isCaptureAttemptPending() {
    return captureAttempt?.state === "pending";
  }

  function isInterruptionLatched() {
    return handledGeneration === generation || captureAttempt?.interrupted === true;
  }

  function waitForIdle() {
    return activeCleanup?.promise ?? Promise.resolve();
  }

  function handleUnsafeInterruption(reason) {
    if (!UNSAFE_REASONS.has(reason)) {
      return Promise.reject(new TypeError("The runtime interruption reason is invalid."));
    }
    if (destroyed) return Promise.resolve(frozenResult("destroyed", reason, false));
    if (captureAttempt) {
      captureAttempt.interrupted = true;
      captureAttempt.state = "interrupted";
    }
    if (activeCleanup) return activeCleanup.promise;
    if (handledGeneration === generation) {
      return Promise.resolve(frozenResult("already_handled", reason, false));
    }

    handledGeneration = generation;
    const cleanup = { generation, promise: null };
    cleanup.promise = performUnsafeCleanup(reason).finally(() => {
      if (activeCleanup === cleanup) activeCleanup = null;
    });
    activeCleanup = cleanup;
    return cleanup.promise;
  }

  function handlePowerSuspend() {
    return handlePowerInterruption(INTERRUPTION_REASONS.powerSuspend);
  }

  function handlePowerResume() {
    return handlePowerInterruption(INTERRUPTION_REASONS.powerResume);
  }

  function handlePowerInterruption(reason) {
    if (!captureAttempt && !safeMeetingActive() && !activeCleanup) {
      return Promise.resolve(frozenResult("idle", reason, false));
    }
    // The renderer remains alive across ordinary suspend/resume. Reloading it
    // here would discard transcript text that has not crossed the IPC boundary
    // yet, so renderer recovery is reserved for actual renderer failures.
    return handleUnsafeInterruption(reason);
  }

  function handleMainRendererFailure(reason) {
    const cleanup = handleUnsafeInterruption(reason);
    recoverMainOnce(reason);
    return cleanup;
  }

  async function performUnsafeCleanup(reason) {
    const context = interruptionContext(reason);
    const meetingWasActive = captureAttempt !== null || safeMeetingActive();
    let failed = false;

    safeCall(publishInterruptedState, context);
    if (!safeCall(cancelAssist, context).ok) failed = true;
    if (!safeCall(cancelProvider, context).ok) failed = true;
    if (meetingWasActive) {
      try {
        await stopActiveMeeting(context);
      } catch {
        failed = true;
      }
    }
    try {
      await clearTransientState(context);
    } catch {
      failed = true;
    }
    captureAttempt = captureAttempt
      ? { ...captureAttempt, state: "interrupted", interrupted: true }
      : null;
    safeCall(publishInterruptedState, context);
    return frozenResult(failed ? "handled_with_errors" : "handled", reason, meetingWasActive);
  }

  function recoverMainOnce(reason) {
    if (destroyed || mainRecoveryGeneration === generation) return false;
    mainRecoveryGeneration = generation;
    return safeCall(recoverMainRenderer, interruptionContext(reason)).ok;
  }

  function bindPowerMonitor(powerMonitor) {
    assertEmitter(powerMonitor, "powerMonitor");
    const existing = powerMonitorBindings.get(powerMonitor);
    if (existing) return existing;

    const onSuspend = () => { void handlePowerSuspend(); };
    const onResume = () => { void handlePowerResume(); };
    const cleanup = createBindingCleanup([
      [powerMonitor, "suspend", onSuspend],
      [powerMonitor, "resume", onResume]
    ], () => powerMonitorBindings.delete(powerMonitor));
    powerMonitorBindings.set(powerMonitor, cleanup);
    return cleanup;
  }

  function bindMainWindow(window) {
    assertWindow(window, "main window");
    const existing = mainWindowBindings.get(window);
    if (existing) return existing;

    const onUnresponsive = () => {
      void handleMainRendererFailure(INTERRUPTION_REASONS.mainUnresponsive);
    };
    const onProcessGone = () => {
      void handleMainRendererFailure(INTERRUPTION_REASONS.mainProcessGone);
    };
    const onLoadFailed = (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame !== true) return;
      void handleMainRendererFailure(INTERRUPTION_REASONS.mainLoadFailed);
    };
    let cleanup = null;
    const onClosed = () => cleanup?.();
    cleanup = createBindingCleanup([
      [window, "unresponsive", onUnresponsive],
      [window, "closed", onClosed],
      [window.webContents, "render-process-gone", onProcessGone],
      [window.webContents, "did-fail-load", onLoadFailed]
    ], () => mainWindowBindings.delete(window));
    mainWindowBindings.set(window, cleanup);
    return cleanup;
  }

  function bindOverlayWindow(window) {
    assertWindow(window, "overlay window");
    const existing = overlayWindowBindings.get(window);
    if (existing) return existing;

    let recoveryArmed = true;
    const recover = (reason) => {
      if (destroyed || !recoveryArmed) return;
      recoveryArmed = false;
      safeCall(recoverOverlayRenderer, window, interruptionContext(reason));
    };
    const onProcessGone = () => recover(INTERRUPTION_REASONS.overlayProcessGone);
    const onLoadFailed = (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame === true) recover(INTERRUPTION_REASONS.overlayLoadFailed);
    };
    const onLoadFinished = () => { recoveryArmed = true; };
    let cleanup = null;
    const onClosed = () => cleanup?.();
    cleanup = createBindingCleanup([
      [window, "closed", onClosed],
      [window.webContents, "render-process-gone", onProcessGone],
      [window.webContents, "did-fail-load", onLoadFailed],
      [window.webContents, "did-finish-load", onLoadFinished]
    ], () => overlayWindowBindings.delete(window));
    overlayWindowBindings.set(window, cleanup);
    return cleanup;
  }

  function createBindingCleanup(entries, onCleanup) {
    for (const [emitter, eventName, listener] of entries) emitter.on(eventName, listener);
    let active = true;
    const cleanup = () => {
      if (!active) return false;
      active = false;
      for (const [emitter, eventName, listener] of entries) {
        emitter.removeListener(eventName, listener);
      }
      bindings.delete(cleanup);
      onCleanup();
      return true;
    };
    bindings.add(cleanup);
    return cleanup;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const cleanup of [...bindings]) cleanup();
    captureAttempt = null;
  }

  function assertActive() {
    if (destroyed) throw new RuntimeLifecycleError(
      "runtime_lifecycle_destroyed",
      "The runtime lifecycle coordinator has been destroyed."
    );
  }

  function safeMeetingActive() {
    try {
      return isMeetingActive() === true;
    } catch {
      return true;
    }
  }

  return Object.freeze({
    beginExplicitCaptureAttempt,
    completeCaptureAttempt,
    failCaptureAttempt,
    finishCapture,
    isCaptureAttemptCurrent,
    isCaptureAttemptPending,
    isInterruptionLatched,
    waitForIdle,
    handleUnsafeInterruption,
    handlePowerSuspend,
    handlePowerResume,
    bindPowerMonitor,
    bindMainWindow,
    bindOverlayWindow,
    destroy
  });
}

function interruptionContext(reason) {
  return Object.freeze({ reason });
}

function frozenResult(status, reason, meetingWasActive) {
  return Object.freeze({ status, reason, meetingWasActive });
}

function safeCall(callback, ...args) {
  try {
    const result = callback(...args);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function assertWindow(value, label) {
  assertEmitter(value, label);
  assertEmitter(value.webContents, `${label} webContents`);
}

function assertEmitter(value, label) {
  if (!value || typeof value.on !== "function" || typeof value.removeListener !== "function") {
    throw new TypeError(`${label} must be an event emitter.`);
  }
}

function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function.`);
}
