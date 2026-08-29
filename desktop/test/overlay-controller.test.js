import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OVERLAY_DISCLOSURE_VERSION } from "../main/overlay-policy.js";
import { createOverlayController } from "../main/overlay-controller.js";

test("overlay initializes hidden with hardened web preferences and an overt accessible policy", async () => {
  const fixture = createFixture();
  const status = await fixture.controller.initialize();
  const window = fixture.windows[0];

  assert.equal(window.options.width, 560);
  assert.equal(window.options.height, 360);
  assert.equal(window.options.alwaysOnTop, true);
  assert.deepEqual(window.options.webPreferences, {
    preload: "C:\\app\\overlay.cjs",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: false
  });
  assert.equal(window.visible, false);
  assert.equal(window.contentProtection, false);
  assert.equal(window.skipTaskbar, false);
  assert.equal(window.opacity, 1);
  assert.equal(status.meeting.label, "Ready — not recording");
  assert.equal(status.overlay.mode, "accessible");
  assert.equal(status.disclosure.body.includes("not stealth"), true);
});

test("private mode requires the exact disclosure acknowledgement and click-through recovery", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();

  await assert.rejects(
    fixture.controller.updateSettings({ mode: "private", opacity: 0.7 }),
    (error) => error.code === "overlay_acknowledgement_required"
  );
  assert.throws(
    () => fixture.controller.acknowledgePrivateMode({ acknowledged: true, version: "old" }),
    (error) => error.code === "overlay_disclosure_mismatch"
  );
  fixture.controller.acknowledgePrivateMode({
    acknowledged: true,
    version: OVERLAY_DISCLOSURE_VERSION
  });
  await fixture.controller.updateSettings({ mode: "private", opacity: 0.7 });

  let status = fixture.controller.getStatus();
  assert.equal(status.overlay.contentProtection, true);
  assert.equal(status.overlay.skipTaskbar, true);
  assert.equal(status.overlay.opacity, 0.7);
  assert.throws(
    () => fixture.controller.toggleClickThrough(),
    (error) => error.code === "overlay_recovery_unavailable"
  );

  fixture.controller.setShortcutStatus(shortcutStatus(true));
  status = fixture.controller.toggleClickThrough();
  assert.equal(status.overlay.clickThrough, true);
  assert.equal(status.overlay.focusable, false);
  assert.equal(fixture.windows[0].ignoreMouseEvents, true);

  status = fixture.controller.show();
  assert.equal(status.overlay.clickThrough, false);
  assert.equal(status.overlay.focusable, true);
  assert.equal(fixture.windows[0].ignoreMouseEvents, false);

  status = fixture.controller.toggleClickThrough();
  assert.equal(status.overlay.clickThrough, true);

  fixture.controller.setShortcutStatus(shortcutStatus(false));
  status = fixture.controller.getStatus();
  assert.equal(status.overlay.clickThrough, false);
  assert.equal(fixture.windows[0].ignoreMouseEvents, false);
  assert.equal("clickThrough" in fixture.store.value, false);
});

test("only actual transcribing reveals without focus and stopped clears stale live content", async () => {
  let clock = 5_000;
  const fixture = createFixture({ now: () => clock });
  await fixture.controller.initialize();
  fixture.controller.beginSession("session-1");
  assert.equal(fixture.windows[0].visible, false);

  fixture.controller.setMeetingState("transcribing", { reveal: true });
  assert.equal(fixture.windows[0].visible, true);
  assert.equal(fixture.windows[0].showInactiveCalls, 1);
  assert.equal(fixture.windows[0].focusCalls, 0);

  clock = 8_250;
  fixture.controller.ingestBackendEvent({
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 0,
      end_ms: 3_000,
      track: "system",
      text: "What should we ship?",
      partial: false,
      final: true,
      speaker_id: "speaker-02"
    }
  });
  fixture.controller.ingestAssistEvent({
    type: "assist_started",
    requestId: "request-1",
    sessionId: "session-1",
    contextRevision: 1,
    sequence: 1
  });
  fixture.controller.ingestAssistEvent({
    type: "assist_item",
    requestId: "request-1",
    sessionId: "session-1",
    contextRevision: 1,
    sequence: 2,
    channel: "suggestion",
    text: "Lead with the measurable customer outcome.",
    citations: []
  });

  let status = fixture.controller.getStatus();
  assert.equal(status.meeting.elapsedMs, 3_250);
  assert.equal(status.meeting.sourceSummary, "System audio");
  assert.deepEqual(status.meeting.segments[0], {
    key: "segment-1",
    revision: 1,
    speaker: "Speaker 2",
    source: "System audio",
    text: "What should we ship?",
    translation: null
  });
  assert.equal(status.assist.suggestion.text, "Lead with the measurable customer outcome.");
  assert.equal(status.assist.suggestion.stale, false);

  fixture.controller.ingestBackendEvent({
    type: "session_stopped",
    session_id: "session-1",
    reason: "stopped"
  });
  status = fixture.controller.getStatus();
  assert.equal(status.meeting.recording, true);
  fixture.controller.setMeetingState("stopped");
  status = fixture.controller.getStatus();
  assert.equal(status.meeting.recording, false);
  assert.equal(status.meeting.elapsedMs, 0);
  assert.equal(status.meeting.sourceSummary, "Waiting for finalized audio");
  assert.deepEqual(status.meeting.segments, []);
  assert.equal(status.assist.suggestion, null);
});

test("overlay controls only reveal workspace, focus Copilot, hide, or cancel existing Assist", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.showMainWorkspace();
  fixture.controller.focusMainAssist();
  fixture.controller.cancelCurrentAssist();
  fixture.controller.show();
  fixture.controller.hide();

  assert.deepEqual(fixture.actions, ["workspace", "focus-assist", "cancel-assist"]);
  assert.equal(fixture.windows[0].visible, false);
  assert.equal(fixture.actions.includes("start-capture"), false);
});

test("bounds recover to an available display and debounced persistence keeps display identity", async () => {
  const timers = [];
  const fixture = createFixture({
    stored: {
      version: 1,
      mode: "accessible",
      opacity: 1,
      bounds: { x: 9_000, y: 9_000, width: 800, height: 600 },
      displayId: 99
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: () => {}
  });
  await fixture.controller.initialize();
  assert.deepEqual(fixture.windows[0].bounds, { x: 1120, y: 440, width: 800, height: 600 });

  fixture.windows[0].bounds = { x: 100, y: 120, width: 620, height: 400 };
  fixture.windows[0].emit("move");
  await timers.at(-1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.store.value.bounds, { x: 100, y: 120, width: 620, height: 400 });
  assert.equal(fixture.store.value.displayId, 1);
});

test("delayed display recovery merges only placement and cannot restore stale user preferences", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  const originalUpdate = fixture.store.update.bind(fixture.store);
  const recoveryEntered = createDeferred();
  const releaseRecovery = createDeferred();
  const placementPatches = [];

  fixture.store.update = async (patch) => {
    if ("bounds" in patch || "displayId" in patch) {
      placementPatches.push(structuredClone(patch));
      const staleResponse = pickPersisted({ ...fixture.store.value, ...patch });
      recoveryEntered.resolve();
      await releaseRecovery.promise;
      fixture.store.value = pickPersisted({ ...fixture.store.value, ...patch });
      return staleResponse;
    }
    return originalUpdate(patch);
  };

  const recovery = fixture.controller.recoverPlacement();
  await recoveryEntered.promise;
  fixture.controller.acknowledgePrivateMode({
    acknowledged: true,
    version: OVERLAY_DISCLOSURE_VERSION
  });
  await fixture.controller.updateSettings({ mode: "private", opacity: 0.7 });
  releaseRecovery.resolve();
  await recovery;

  assert.deepEqual(Object.keys(placementPatches[0]).sort(), ["bounds", "displayId"]);
  assert.equal(fixture.store.value.mode, "private");
  assert.equal(fixture.store.value.opacity, 0.7);
  assert.equal(fixture.controller.getStatus().settings.mode, "private");
  assert.equal(fixture.controller.getStatus().settings.opacity, 0.7);
});

test("final segment replacements stay chronological and the visible bound evicts by time", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.beginSession("session-order");

  ingestFinal(fixture.controller, "session-order", {
    id: "latest", revision: 1, start_ms: 300, end_ms: 400, text: "Latest"
  });
  ingestFinal(fixture.controller, "session-order", {
    id: "oldest", revision: 1, start_ms: 100, end_ms: 200, text: "Oldest"
  });
  ingestFinal(fixture.controller, "session-order", {
    id: "middle", revision: 1, start_ms: 200, end_ms: 300, text: "Middle"
  });

  let status = fixture.controller.getStatus();
  assert.deepEqual(status.meeting.segments.map(({ key }) => key), ["middle", "latest"]);
  assert.equal(status.meeting.contextRevision, 3);

  ingestFinal(fixture.controller, "session-order", {
    id: "middle", revision: 2, start_ms: 200, end_ms: 300, text: "Middle revised"
  });
  ingestFinal(fixture.controller, "session-order", {
    id: "middle", revision: 1, start_ms: 200, end_ms: 300, text: "Stale middle"
  });
  status = fixture.controller.getStatus();
  assert.deepEqual(status.meeting.segments.map(({ key }) => key), ["middle", "latest"]);
  assert.equal(status.meeting.segments[0].text, "Middle revised");
  assert.equal(status.meeting.contextRevision, 4);
});

test("suggestions carry frozen context identity, become stale, and cannot masquerade as a later request", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.beginSession("session-assist");
  ingestFinal(fixture.controller, "session-assist", {
    id: "first", revision: 1, start_ms: 0, end_ms: 100, text: "First context"
  });

  ingestAssist(fixture.controller, "assist_started", "request-1", 1, { sequence: 1 });
  ingestAssist(fixture.controller, "assist_delta", "request-1", 1, {
    sequence: 2,
    channel: "suggestion",
    delta: "Use the first "
  });
  ingestAssist(fixture.controller, "assist_delta", "request-1", 1, {
    sequence: 3,
    channel: "suggestion",
    delta: "answer."
  });
  ingestAssist(fixture.controller, "assist_completed", "request-1", 1, {
    sequence: 4,
    metrics: { timeToFirstTokenMs: 1, totalMs: 2, outputChars: 21 }
  });

  let status = fixture.controller.getStatus();
  assert.deepEqual(status.assist.suggestion, {
    channel: "suggestion",
    text: "Use the first answer.",
    requestId: "request-1",
    sessionId: "session-assist",
    contextRevision: 1,
    stale: false
  });

  ingestFinal(fixture.controller, "session-assist", {
    id: "second", revision: 1, start_ms: 100, end_ms: 200, text: "New context"
  });
  status = fixture.controller.getStatus();
  assert.equal(status.assist.state, "stale");
  assert.equal(status.assist.currentContextRevision, 2);
  assert.equal(status.assist.suggestion.stale, true);

  ingestAssist(fixture.controller, "assist_started", "request-2", 2, { sequence: 1 });
  status = fixture.controller.getStatus();
  assert.equal(status.assist.state, "working");
  assert.equal(status.assist.suggestion, null);
  ingestAssist(fixture.controller, "assist_error", "request-2", 2, {
    sequence: 2,
    error: { code: "provider_failure", message: "Failed", retryable: false }
  });
  status = fixture.controller.getStatus();
  assert.equal(status.assist.state, "error");
  assert.equal(status.assist.suggestion, null);

  ingestAssist(fixture.controller, "assist_started", "request-3", 2, { sequence: 1 });
  ingestAssist(fixture.controller, "assist_canceled", "request-3", 2, {
    sequence: 2,
    reason: "canceled"
  });
  status = fixture.controller.getStatus();
  assert.equal(status.assist.state, "idle");
  assert.equal(status.assist.suggestion, null);
});

test("recoverable backend issues stay separate from the authoritative recording state", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.beginSession("session-warning");
  fixture.controller.setMeetingState("transcribing");

  fixture.controller.ingestBackendEvent({
    type: "warning",
    source: "capture",
    code: "audio_gap",
    message: "Raw backend detail",
    recoverable: true
  });
  let status = fixture.controller.getStatus();
  assert.equal(status.meeting.state, "transcribing");
  assert.equal(status.meeting.recording, true);
  assert.deepEqual(status.meeting.issue, {
    level: "warning",
    code: "audio_gap",
    message: "A gap was detected in the incoming audio. Transcription is still running.",
    recoverable: true
  });
  assert.doesNotMatch(status.meeting.issue.message, /Raw backend detail/);

  fixture.controller.ingestBackendEvent({
    type: "error",
    source: "transcription",
    code: "inference_failed",
    message: "Segment failed",
    recoverable: true
  });
  status = fixture.controller.getStatus();
  assert.equal(status.meeting.recording, true);
  assert.equal(status.meeting.issue.level, "warning");
  assert.equal(status.meeting.issue.code, "inference_failed");
});

test("the start transition clears old issues but preserves setup warnings emitted before backend readiness", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.beginSession("old-session");
  fixture.controller.ingestBackendEvent({
    type: "warning",
    source: "capture",
    code: "audio_gap",
    message: "Old session warning",
    recoverable: true
  });

  fixture.controller.setMeetingState("error");
  fixture.controller.setMeetingState("preparing");
  assert.equal(fixture.controller.getStatus().meeting.issue, null);

  fixture.controller.ingestBackendEvent({
    type: "warning",
    source: "transcription",
    code: "translation_unavailable",
    message: "Setup warning before ready",
    recoverable: true
  });
  fixture.controller.beginSession("new-session");
  fixture.controller.setMeetingState("transcribing");

  const status = fixture.controller.getStatus();
  assert.equal(status.meeting.recording, true);
  assert.deepEqual(status.meeting.issue, {
    level: "warning",
    code: "translation_unavailable",
    message: "Translation is unavailable. Original-language transcription is still running.",
    recoverable: true
  });
});

test("fatal engine events cannot claim capture stopped before native cleanup reports it", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  fixture.controller.beginSession("session-fatal");
  fixture.controller.setMeetingState("transcribing");

  fixture.controller.ingestBackendEvent({
    type: "error",
    source: "transcription",
    code: "inference_backpressure",
    message: "Inference overloaded",
    recoverable: false
  });
  let status = fixture.controller.getStatus();
  assert.equal(status.meeting.state, "transcribing");
  assert.equal(status.meeting.recording, true);
  assert.equal(status.meeting.issue.level, "error");
  assert.equal(status.meeting.issue.recoverable, false);

  fixture.controller.ingestBackendEvent({
    type: "session_stopped",
    session_id: "session-fatal",
    reason: "inference_backpressure"
  });
  status = fixture.controller.getStatus();
  assert.equal(status.meeting.state, "transcribing");
  assert.equal(status.meeting.recording, true);
  assert.equal(status.meeting.issue.code, "backend_stopped");

  fixture.controller.setMeetingState("stopped");
  status = fixture.controller.getStatus();
  assert.equal(status.meeting.state, "stopped");
  assert.equal(status.meeting.recording, false);
  assert.equal(status.meeting.issue, null);
});

test("overlay navigation and IPC trust bind to the exact overlay main frame", async () => {
  const fixture = createFixture();
  await fixture.controller.initialize();
  const window = fixture.windows[0];
  const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
  window.webContents.emit("will-navigate", blocked, "https://example.com");
  assert.equal(blocked.prevented, true);
  assert.deepEqual(window.webContents.openHandler(), { action: "deny" });

  const trusted = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame
  };
  assert.equal(fixture.controller.isTrustedEvent(trusted), true);
  assert.equal(fixture.controller.isTrustedEvent({ ...trusted, senderFrame: { url: "file:///other" } }), false);
});

function createFixture({
  stored = {
    version: 1,
    mode: "accessible",
    opacity: 1,
    bounds: null,
    displayId: null
  },
  now = () => 0,
  setTimeoutFn = () => 1,
  clearTimeoutFn = () => {}
} = {}) {
  const windows = [];
  class BrowserWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }
  }
  const store = {
    value: structuredClone(stored),
    async load() { return structuredClone(this.value); },
    async save(value) {
      this.value = pickPersisted(value);
      return structuredClone(this.value);
    },
    async update(patch) {
      this.value = pickPersisted({ ...this.value, ...patch });
      if (this.value.mode === "accessible") this.value.opacity = 1;
      return structuredClone(this.value);
    }
  };
  const actions = [];
  const controller = createOverlayController({
    BrowserWindow,
    screen: {
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getPrimaryDisplay: () => ({ id: 1 }),
      getDisplayMatching: () => ({ id: 1 })
    },
    platform: "win32",
    rendererEntry: "C:\\app\\overlay.html",
    rendererUrl: "file:///C:/app/overlay.html",
    preloadEntry: "C:\\app\\overlay.cjs",
    icon: "C:\\app\\icon.png",
    settingsStore: store,
    showWorkspace: () => actions.push("workspace"),
    focusAssist: () => actions.push("focus-assist"),
    cancelAssist: () => {
      actions.push("cancel-assist");
      return true;
    },
    now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn,
    clearTimeoutFn
  });
  return { controller, windows, store, actions };
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height
    };
    this.visible = false;
    this.destroyed = false;
    this.focusCalls = 0;
    this.showInactiveCalls = 0;
    this.webContents = new FakeWebContents();
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; this.showInactiveCalls += 1; }
  hide() { this.visible = false; }
  focus() { this.focusCalls += 1; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setOpacity(value) { this.opacity = value; }
  setContentProtection(value) { this.contentProtection = value; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
  setFocusable(value) { this.focusable = value; }
  setIgnoreMouseEvents(value) { this.ignoreMouseEvents = value; }
  setBounds(value) { this.bounds = { ...value }; }
  getBounds() { return { ...this.bounds }; }
  loadFile(value) { this.loadedFile = value; return Promise.resolve(); }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.loading = false;
    this.mainFrame = { url: "file:///C:/app/overlay.html" };
  }
  isLoadingMainFrame() { return this.loading; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  send(channel, value) { this.lastSent = { channel, value }; }
}

function shortcutStatus(available) {
  return {
    version: 1,
    canEnableClickThrough: available,
    shortcuts: [{
      action: "showHide",
      label: "Show or hide overlay",
      accelerator: "CommandOrControl+Shift+Space",
      state: available ? "registered" : "unavailable",
      available,
      reason: available ? null : "registration_failed",
      message: available ? "Available" : "Unavailable"
    }]
  };
}

function ingestFinal(controller, sessionId, segment) {
  return controller.ingestBackendEvent({
    type: "final_segment",
    session_id: sessionId,
    segment: {
      track: "system",
      partial: false,
      final: true,
      speaker_id: null,
      ...segment
    }
  });
}

function ingestAssist(controller, type, requestId, contextRevision, payload) {
  return controller.ingestAssistEvent({
    type,
    requestId,
    sessionId: "session-assist",
    contextRevision,
    ...payload
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pickPersisted(value) {
  return {
    version: 1,
    mode: value.mode === "private" ? "private" : "accessible",
    opacity: value.mode === "private" ? value.opacity : 1,
    bounds: value.bounds ? { ...value.bounds } : null,
    displayId: value.displayId ?? null
  };
}
