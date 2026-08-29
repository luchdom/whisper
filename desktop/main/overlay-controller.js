import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_DISCLOSURE_VERSION,
  OVERLAY_OPACITY_RANGE,
  createOverlayResetDto,
  createOverlayWindowPolicy,
  getContentProtectionDisclosure,
  resolveOverlayPlacement,
  validateOverlaySettingsPatch
} from "./overlay-policy.js";
import { isExactRendererIpcEvent } from "./platform.js";

const MEETING_STATES = new Set(["ready", "preparing", "transcribing", "error", "stopped"]);
const MAX_VISIBLE_SEGMENTS = 2;
const MAX_SEGMENT_CHARS = 2_000;
const MAX_SUGGESTION_CHARS = 4_000;
const BOUNDS_WRITE_DELAY_MS = 300;
const ELAPSED_TICK_MS = 1_000;
const OPACITY_STEP = 0.05;
const PROVIDER_DISCLOSURE = "OpenAI assistance uses meeting data only after explicit approval for the current meeting.";

export class OverlayControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OverlayControllerError";
    this.code = code;
  }
}

export function createOverlayController({
  BrowserWindow,
  screen,
  platform,
  rendererEntry,
  rendererUrl,
  preloadEntry,
  icon,
  settingsStore,
  showWorkspace,
  focusAssist,
  cancelAssist,
  shouldAllowClose = () => false,
  onStatusChange = () => {},
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  assertDependencies({
    BrowserWindow,
    screen,
    platform,
    rendererEntry,
    rendererUrl,
    preloadEntry,
    settingsStore,
    showWorkspace,
    focusAssist,
    cancelAssist,
    shouldAllowClose,
    onStatusChange,
    now,
    setIntervalFn,
    clearIntervalFn,
    setTimeoutFn,
    clearTimeoutFn
  });

  let overlayWindow = null;
  let settings = DEFAULT_OVERLAY_SETTINGS;
  let shortcutStatus = createEmptyShortcutStatus();
  let privateAcknowledgement = null;
  let clickThroughRequested = false;
  let meetingState = "ready";
  let activeSessionId = null;
  let recordingStartedAt = null;
  let elapsedTimer = null;
  let boundsWriteTimer = null;
  let observedTracks = new Set();
  let finalSegments = [];
  let segmentRevisions = new Map();
  let transcriptContextRevision = 0;
  let latestMeetingIssue = null;
  let assistState = "idle";
  let activeAssistRequest = null;
  let latestSuggestion = null;
  let providerStatus = Object.freeze({
    mode: "off",
    configured: false,
    consentGranted: false,
    inFlight: false
  });
  let destroyed = false;

  async function initialize() {
    assertActive();
    try {
      settings = await settingsStore.load();
    } catch {
      settings = DEFAULT_OVERLAY_SETTINGS;
    }
    const placement = resolvePlacement(settings);
    await persistPlacement(placement);
    createWindow(placement.bounds);
    applyWindowPolicy();
    emitStatus();
    return getStatus();
  }

  function createWindow(initialBounds) {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
    overlayWindow = new BrowserWindow({
      ...initialBounds,
      minWidth: 420,
      minHeight: 300,
      show: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      title: "Meeting Transcriber companion",
      icon,
      backgroundColor: "#0b0f17",
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadEntry,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false
      }
    });
    overlayWindow.setAlwaysOnTop(true, "floating");
    overlayWindow.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    overlayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlayWindow.webContents.on("will-navigate", (event, navigationUrl) => {
      if (navigationUrl !== rendererUrl) event.preventDefault();
    });
    overlayWindow.webContents.on("did-finish-load", emitStatus);
    overlayWindow.on("close", (event) => {
      if (destroyed || shouldAllowClose()) return;
      event.preventDefault();
      overlayWindow?.hide();
      emitStatus();
    });
    overlayWindow.on("move", scheduleBoundsPersistence);
    overlayWindow.on("resize", scheduleBoundsPersistence);
    overlayWindow.on("closed", () => {
      overlayWindow = null;
    });
    void overlayWindow.loadFile(rendererEntry);
    return overlayWindow;
  }

  function show({ focus = true } = {}) {
    assertActive();
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createWindow(resolvePlacement(settings).bounds);
      applyWindowPolicy();
    }
    if (clickThroughRequested) {
      clickThroughRequested = false;
      applyWindowPolicy();
    }
    const policy = getWindowPolicy();
    if (!focus || !policy.focusable) overlayWindow.showInactive?.();
    else {
      overlayWindow.show();
      overlayWindow.focus();
    }
    emitStatus();
    return getStatus();
  }

  function hide() {
    assertActive();
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    emitStatus();
    return getStatus();
  }

  function toggleVisibility() {
    if (isVisible()) return hide();
    return show({ focus: true });
  }

  function showMainWorkspace() {
    showWorkspace();
    return Object.freeze({ ok: true });
  }

  function focusMainAssist() {
    focusAssist();
    return Object.freeze({ ok: true });
  }

  function cancelCurrentAssist() {
    return Boolean(cancelAssist());
  }

  function acknowledgePrivateMode(value) {
    const input = requireExactRecord(value, ["acknowledged", "version"]);
    if (input.acknowledged !== true || input.version !== OVERLAY_DISCLOSURE_VERSION) {
      throw new OverlayControllerError(
        "overlay_disclosure_mismatch",
        "Review and acknowledge the current private-mode disclosure before continuing."
      );
    }
    privateAcknowledgement = OVERLAY_DISCLOSURE_VERSION;
    return Object.freeze({
      acknowledged: true,
      disclosure: getContentProtectionDisclosure(platform)
    });
  }

  async function updateSettings(value) {
    assertActive();
    const patch = validateOverlaySettingsPatch(value);
    if (patch.mode === "private"
      && settings.mode !== "private"
      && privateAcknowledgement !== OVERLAY_DISCLOSURE_VERSION) {
      throw new OverlayControllerError(
        "overlay_acknowledgement_required",
        "Review and acknowledge the private-mode disclosure before enabling it."
      );
    }
    const saved = await settingsStore.update(patch);
    settings = mergeSettingsPatch(settings, saved, patch);
    if (settings.mode !== "private") {
      clickThroughRequested = false;
      privateAcknowledgement = null;
    }
    applyWindowPolicy();
    emitStatus();
    return getStatus();
  }

  async function reset() {
    assertActive();
    const resetDto = createOverlayResetDto(displayOptions());
    privateAcknowledgement = null;
    clickThroughRequested = false;
    settings = await settingsStore.save(resetDto.settings);
    applyPlacement(resetDto.placement.bounds);
    applyWindowPolicy();
    show({ focus: true });
    return getStatus();
  }

  async function recoverPlacement() {
    assertActive();
    const placement = resolvePlacement(settings);
    await persistPlacement(placement);
    applyPlacement(placement.bounds);
    applyWindowPolicy();
    emitStatus();
    return getStatus();
  }

  async function adjustOpacity(direction) {
    if (!["up", "down"].includes(direction)) {
      throw new TypeError("The opacity direction is invalid.");
    }
    if (settings.mode !== "private") return getStatus();
    const delta = direction === "up" ? OPACITY_STEP : -OPACITY_STEP;
    const opacity = Math.min(
      OVERLAY_OPACITY_RANGE.maximum,
      Math.max(OVERLAY_OPACITY_RANGE.minimum, roundOpacity(settings.opacity + delta))
    );
    return updateSettings({ opacity });
  }

  function toggleClickThrough() {
    assertActive();
    if (settings.mode !== "private") {
      clickThroughRequested = false;
      applyWindowPolicy();
      emitStatus();
      return getStatus();
    }
    if (!shortcutStatus.canEnableClickThrough) {
      clickThroughRequested = false;
      applyWindowPolicy();
      emitStatus();
      throw new OverlayControllerError(
        "overlay_recovery_unavailable",
        "Click-through requires the Show or hide overlay recovery shortcut."
      );
    }
    clickThroughRequested = !clickThroughRequested;
    applyWindowPolicy();
    emitStatus();
    return getStatus();
  }

  function setShortcutStatus(value) {
    shortcutStatus = sanitizeShortcutStatus(value);
    if (!shortcutStatus.canEnableClickThrough && clickThroughRequested) {
      clickThroughRequested = false;
      applyWindowPolicy();
    }
    emitStatus();
    return getStatus();
  }

  function beginSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.length > 256) {
      throw new TypeError("The overlay session identifier is invalid.");
    }
    const startIssue = meetingState === "preparing" ? latestMeetingIssue : null;
    activeSessionId = sessionId;
    observedTracks = new Set();
    finalSegments = [];
    segmentRevisions = new Map();
    transcriptContextRevision = 0;
    // Setup warnings can arrive before backend.startSession resolves. The
    // preparing transition cleared any prior-session issue, so retain only a
    // warning observed during this exact start transition.
    latestMeetingIssue = startIssue;
    activeAssistRequest = null;
    latestSuggestion = null;
    assistState = "idle";
    setMeetingState("preparing");
  }

  function setMeetingState(value, { reveal = false } = {}) {
    if (!MEETING_STATES.has(value)) throw new TypeError("The overlay meeting state is invalid.");
    const wasTranscribing = meetingState === "transcribing";
    if (value === "preparing" && meetingState !== "preparing") latestMeetingIssue = null;
    meetingState = value;
    if (value === "transcribing" && !wasTranscribing) {
      recordingStartedAt = now();
      startElapsedTimer();
      if (reveal) show({ focus: false });
    } else if (value !== "transcribing" && wasTranscribing) {
      stopElapsedTimer();
      recordingStartedAt = null;
    }
    if (value === "ready" || value === "stopped") clearLiveMeetingData();
    emitStatus();
    return getStatus();
  }

  function ingestBackendEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    if (event.type === "final_segment") {
      if (!activeSessionId || event.session_id !== activeSessionId || !event.segment?.final) return false;
      ingestFinalSegment(event.segment);
      emitStatus();
      return true;
    }
    if (event.type === "warning" || event.type === "error") {
      latestMeetingIssue = createMeetingIssue(event);
      emitStatus();
      return true;
    }
    if (event.type === "session_stopped") {
      if (activeSessionId && event.session_id && event.session_id !== activeSessionId) return false;
      if (meetingState === "transcribing") {
        // The backend owns inference, not native capture. Keep the overt
        // recording indicator until the renderer reports that its capture
        // tracks have actually stopped.
        latestMeetingIssue = createMeetingIssue({
          type: "error",
          code: "backend_stopped",
          recoverable: false
        });
        emitStatus();
      }
      return true;
    }
    return false;
  }

  function ingestAssistEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const identity = normalizeAssistIdentity(event);
    if (!identity || identity.sessionId !== activeSessionId) return false;

    if (event.type === "assist_started") {
      activeAssistRequest = identity;
      assistState = "working";
      // Never present a completed answer as output from a newer request.
      latestSuggestion = null;
    } else if (!sameAssistRequest(activeAssistRequest, identity)) {
      return false;
    } else if (event.type === "assist_delta") {
      if (event.channel === "suggestion" && typeof event.delta === "string") {
        const previousText = latestSuggestion?.text ?? "";
        latestSuggestion = Object.freeze({
          channel: "suggestion",
          text: boundText(`${previousText}${event.delta}`, MAX_SUGGESTION_CHARS),
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          contextRevision: identity.contextRevision,
          stale: transcriptContextRevision > identity.contextRevision
        });
      }
      assistState = "working";
    } else if (event.type === "assist_item" && typeof event.text === "string") {
      if (event.channel === "suggestion") {
        latestSuggestion = Object.freeze({
          channel: normalizeAssistChannel(event.channel),
          text: boundText(event.text, MAX_SUGGESTION_CHARS),
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          contextRevision: identity.contextRevision,
          stale: transcriptContextRevision > identity.contextRevision
        });
        assistState = latestSuggestion.stale ? "stale" : "ready";
      }
    } else if (event.type === "assist_error") {
      assistState = "error";
      activeAssistRequest = null;
      latestSuggestion = null;
    } else if (event.type === "assist_completed") {
      activeAssistRequest = null;
      assistState = latestSuggestion
        ? latestSuggestion.stale ? "stale" : "ready"
        : "idle";
    } else if (event.type === "assist_canceled") {
      activeAssistRequest = null;
      assistState = "idle";
      latestSuggestion = null;
    } else return false;
    emitStatus();
    return true;
  }

  function setProviderStatus(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    providerStatus = Object.freeze({
      mode: input.mode === "openai" ? "openai" : "off",
      configured: input.configured === true,
      consentGranted: input.consentGranted === true,
      inFlight: input.inFlight === true
    });
    emitStatus();
    return getStatus();
  }

  function getStatus() {
    const policy = getWindowPolicy();
    return Object.freeze({
      version: 1,
      meeting: Object.freeze({
        state: meetingState,
        label: meetingLabel(meetingState),
        recording: meetingState === "transcribing",
        elapsedMs: meetingState === "transcribing" && recordingStartedAt !== null
          ? Math.max(0, Math.round(now() - recordingStartedAt))
          : 0,
        contextRevision: transcriptContextRevision,
        sourceSummary: sourceSummary(observedTracks),
        issue: latestMeetingIssue ? Object.freeze({ ...latestMeetingIssue }) : null,
        segments: Object.freeze(finalSegments.map(createVisibleSegmentDto))
      }),
      assist: Object.freeze({
        state: assistState,
        currentContextRevision: transcriptContextRevision,
        suggestion: latestSuggestion ? Object.freeze({ ...latestSuggestion }) : null
      }),
      provider: createProviderDto(providerStatus, assistState),
      overlay: Object.freeze({
        visible: isVisible(),
        mode: settings.mode,
        opacity: policy.opacity,
        clickThrough: policy.clickThrough,
        focusable: policy.focusable,
        contentProtection: policy.contentProtection,
        skipTaskbar: policy.skipTaskbar,
        recoveryAvailable: shortcutStatus.canEnableClickThrough
      }),
      settings: Object.freeze({
        version: settings.version,
        mode: settings.mode,
        opacity: settings.opacity
      }),
      disclosure: getContentProtectionDisclosure(platform),
      shortcuts: shortcutStatus
    });
  }

  function isTrustedEvent(event) {
    return Boolean(
      overlayWindow
        && !overlayWindow.isDestroyed()
        && isExactRendererIpcEvent(event, overlayWindow.webContents, rendererUrl)
    );
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopElapsedTimer();
    if (boundsWriteTimer !== null) clearTimeoutFn(boundsWriteTimer);
    boundsWriteTimer = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
  }

  function getWindowPolicy() {
    return createOverlayWindowPolicy(settings, {
      platform,
      clickThroughRequested,
      recoveryShortcutAvailable: shortcutStatus.canEnableClickThrough
    });
  }

  function applyWindowPolicy() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const policy = getWindowPolicy();
    overlayWindow.setOpacity(policy.opacity);
    overlayWindow.setContentProtection?.(policy.contentProtection);
    overlayWindow.setSkipTaskbar(policy.skipTaskbar);
    overlayWindow.setFocusable(policy.focusable);
    overlayWindow.setIgnoreMouseEvents(policy.clickThrough, { forward: true });
  }

  function applyPlacement(bounds) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setBounds(bounds, false);
  }

  function resolvePlacement(value) {
    return resolveOverlayPlacement(value, displayOptions());
  }

  function displayOptions() {
    const displays = screen.getAllDisplays().map(({ id, workArea }) => ({ id, workArea }));
    return {
      displays,
      primaryDisplayId: screen.getPrimaryDisplay().id,
      platform
    };
  }

  async function persistPlacement(placement) {
    const patch = Object.freeze({
      bounds: placement.bounds,
      displayId: placement.displayId
    });
    try {
      const saved = await settingsStore.update(patch);
      // A delayed placement response must never restore an older mode or
      // opacity over a newer user preference. Only placement fields belong to
      // this operation.
      settings = mergeSettingsPatch(settings, saved, patch);
    } catch {
      // Placement persistence is fail-soft; the in-memory policy remains safe.
    }
    return settings;
  }

  function scheduleBoundsPersistence() {
    if (destroyed || !overlayWindow || overlayWindow.isDestroyed()) return;
    if (boundsWriteTimer !== null) clearTimeoutFn(boundsWriteTimer);
    boundsWriteTimer = setTimeoutFn(() => {
      boundsWriteTimer = null;
      if (destroyed || !overlayWindow || overlayWindow.isDestroyed()) return;
      const bounds = overlayWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const placement = { bounds, displayId: display.id };
      void persistPlacement(placement)
        .then(() => {
          emitStatus();
        })
        .catch(() => {});
    }, BOUNDS_WRITE_DELAY_MS);
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    elapsedTimer = setIntervalFn(emitStatus, ELAPSED_TICK_MS);
  }

  function stopElapsedTimer() {
    if (elapsedTimer !== null) clearIntervalFn(elapsedTimer);
    elapsedTimer = null;
  }

  function clearLiveMeetingData() {
    activeSessionId = null;
    observedTracks = new Set();
    finalSegments = [];
    segmentRevisions = new Map();
    transcriptContextRevision = 0;
    latestMeetingIssue = null;
    assistState = "idle";
    activeAssistRequest = null;
    latestSuggestion = null;
  }

  function ingestFinalSegment(segment) {
    const track = segment.track === "microphone" ? "microphone" : "system";
    const key = boundText(segment.id, 256).trim();
    const revision = Number.isSafeInteger(segment.revision) && segment.revision >= 0
      ? segment.revision
      : 0;
    const text = boundText(segment.text, MAX_SEGMENT_CHARS);
    if (!key || !text.trim()) return false;
    const currentRevision = segmentRevisions.get(key);
    if (currentRevision !== undefined && currentRevision >= revision) return false;

    const startMs = normalizeSegmentTime(segment.start_ms);
    const endMs = Math.max(startMs, normalizeSegmentTime(segment.end_ms));
    const normalized = Object.freeze({
      key,
      revision,
      startMs,
      endMs,
      speaker: speakerLabel(segment.speaker_id, track),
      source: track === "microphone" ? "Microphone" : "System audio",
      text,
      translation: typeof segment.translated_text === "string"
        ? boundText(segment.translated_text, MAX_SEGMENT_CHARS)
        : null
    });
    segmentRevisions.set(key, revision);
    transcriptContextRevision += 1;
    observedTracks.add(track);
    const existingIndex = finalSegments.findIndex(({ key }) => key === normalized.key);
    if (existingIndex >= 0) finalSegments.splice(existingIndex, 1);
    finalSegments.push(normalized);
    finalSegments.sort(compareVisibleSegments);
    finalSegments = finalSegments.slice(-MAX_VISIBLE_SEGMENTS);
    if (latestSuggestion
      && latestSuggestion.sessionId === activeSessionId
      && latestSuggestion.contextRevision < transcriptContextRevision
      && !latestSuggestion.stale) {
      latestSuggestion = Object.freeze({ ...latestSuggestion, stale: true });
      if (assistState === "ready") assistState = "stale";
    }
    return true;
  }

  function emitStatus() {
    if (destroyed) return;
    const status = getStatus();
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.webContents.isLoadingMainFrame()) {
      try {
        overlayWindow.webContents.send("overlay:status", status);
      } catch {
        // Overlay rendering is informational and never affects capture.
      }
    }
    try {
      onStatusChange(status);
    } catch {
      // A disappearing workspace cannot affect the companion lifecycle.
    }
  }

  function isVisible() {
    return Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
  }

  function assertActive() {
    if (destroyed) throw new Error("The overlay controller has been destroyed.");
  }

  return Object.freeze({
    initialize,
    show,
    hide,
    toggleVisibility,
    showMainWorkspace,
    focusMainAssist,
    cancelCurrentAssist,
    acknowledgePrivateMode,
    updateSettings,
    reset,
    recoverPlacement,
    adjustOpacity,
    toggleClickThrough,
    setShortcutStatus,
    beginSession,
    setMeetingState,
    ingestBackendEvent,
    ingestAssistEvent,
    setProviderStatus,
    getStatus,
    isTrustedEvent,
    destroy
  });
}

function createProviderDto(status, assistState) {
  const state = status.mode === "off"
    ? "off"
    : !status.configured
      ? "setup_required"
      : !status.consentGranted
        ? "approval_required"
        : status.inFlight || assistState === "working"
          ? "working"
          : "ready";
  const labels = {
    off: "Local transcript only",
    setup_required: "OpenAI setup required",
    approval_required: "OpenAI approval required",
    working: "OpenAI is responding",
    ready: "OpenAI ready"
  };
  return Object.freeze({ state, label: labels[state], disclosure: PROVIDER_DISCLOSURE });
}

function mergeSettingsPatch(current, saved, patch) {
  const next = { ...current };
  if ("mode" in patch) {
    next.mode = saved.mode;
    // Mode changes can normalize opacity (Accessible is always fully opaque).
    next.opacity = saved.opacity;
  } else if ("opacity" in patch) {
    next.opacity = saved.opacity;
  }
  if ("bounds" in patch) next.bounds = saved.bounds;
  if ("displayId" in patch) next.displayId = saved.displayId;
  return Object.freeze(next);
}

function createVisibleSegmentDto(segment) {
  return Object.freeze({
    key: segment.key,
    revision: segment.revision,
    speaker: segment.speaker,
    source: segment.source,
    text: segment.text,
    translation: segment.translation
  });
}

function compareVisibleSegments(left, right) {
  return left.startMs - right.startMs
    || left.endMs - right.endMs
    || left.key.localeCompare(right.key);
}

function normalizeSegmentTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeAssistIdentity(event) {
  const requestId = normalizeAssistIdentifier(event.requestId);
  const sessionId = normalizeAssistIdentifier(event.sessionId);
  if (!requestId || !sessionId
    || !Number.isSafeInteger(event.contextRevision)
    || event.contextRevision < 0) {
    return null;
  }
  return Object.freeze({
    requestId,
    sessionId,
    contextRevision: event.contextRevision
  });
}

function normalizeAssistIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0
    || normalized.length > 256
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function sameAssistRequest(left, right) {
  return Boolean(left
    && right
    && left.requestId === right.requestId
    && left.sessionId === right.sessionId
    && left.contextRevision === right.contextRevision);
}

function createMeetingIssue(event) {
  const recoverable = event.recoverable === true || event.type === "warning";
  const code = boundText(event.code, 128) || "engine_issue";
  const messages = {
    audio_gap: "A gap was detected in the incoming audio. Transcription is still running.",
    non_monotonic_audio: "An out-of-order audio block was skipped. Transcription is still running.",
    inference_failed: "A local audio segment could not be transcribed. Recording is still running.",
    diarization_unavailable: "Speaker detection is unavailable. Transcription is still running with source labels.",
    translation_unavailable: "Translation is unavailable. Original-language transcription is still running.",
    backend_stopped: "The transcription engine stopped. Recording will remain indicated until capture cleanup completes."
  };
  return Object.freeze({
    level: recoverable ? "warning" : "error",
    code,
    message: messages[code] ?? (recoverable
      ? "The local engine reported a recoverable issue. Transcription is still running."
      : "The transcription engine needs to stop. Recording will remain indicated until capture cleanup completes."),
    recoverable
  });
}

function createEmptyShortcutStatus() {
  return Object.freeze({ version: 1, canEnableClickThrough: false, shortcuts: Object.freeze([]) });
}

function sanitizeShortcutStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || typeof value.canEnableClickThrough !== "boolean"
    || !Array.isArray(value.shortcuts)) {
    return createEmptyShortcutStatus();
  }
  return Object.freeze({
    version: 1,
    canEnableClickThrough: value.canEnableClickThrough,
    shortcuts: Object.freeze(value.shortcuts.map((shortcut) => Object.freeze({
      action: boundText(shortcut.action, 64),
      label: boundText(shortcut.label, 128),
      accelerator: boundText(shortcut.accelerator, 128),
      state: ["registered", "unavailable", "blocked", "unregistered"].includes(shortcut.state)
        ? shortcut.state
        : "unavailable",
      available: shortcut.available === true,
      reason: typeof shortcut.reason === "string" ? boundText(shortcut.reason, 128) : null,
      message: boundText(shortcut.message, 240)
    })))
  });
}

function meetingLabel(state) {
  return {
    ready: "Ready — not recording",
    preparing: "Preparing — not recording",
    transcribing: "Recording and transcribing",
    error: "Needs attention",
    stopped: "Stopped — not recording"
  }[state];
}

function sourceSummary(tracks) {
  if (tracks.has("system") && tracks.has("microphone")) return "System audio + microphone";
  if (tracks.has("system")) return "System audio";
  if (tracks.has("microphone")) return "Microphone";
  return "Waiting for finalized audio";
}

function speakerLabel(value, track) {
  if (typeof value === "string") {
    const match = /^speaker[-_ ]?0*(\d+)$/iu.exec(value.trim());
    if (match) return `Speaker ${Number.parseInt(match[1], 10)}`;
  }
  return track === "microphone" ? "You" : "Meeting";
}

function normalizeAssistChannel(value) {
  return ["suggestion", "supporting_point", "follow_up_question", "caveat"].includes(value)
    ? value
    : "suggestion";
}

function boundText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maximum);
}

function roundOpacity(value) {
  return Math.round(value * 100) / 100;
}

function requireExactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The private-mode acknowledgement is invalid.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("The private-mode acknowledgement is invalid.");
  }
  return value;
}

function assertDependencies(value) {
  if (typeof value.BrowserWindow !== "function") throw new TypeError("BrowserWindow is required.");
  if (typeof value.screen?.getAllDisplays !== "function"
    || typeof value.screen?.getPrimaryDisplay !== "function"
    || typeof value.screen?.getDisplayMatching !== "function") {
    throw new TypeError("Electron screen APIs are required.");
  }
  if (typeof value.platform !== "string" || value.platform.length === 0) {
    throw new TypeError("The overlay platform is required.");
  }
  for (const field of ["rendererEntry", "rendererUrl", "preloadEntry"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TypeError(`${field} is required.`);
    }
  }
  for (const method of ["load", "save", "update"]) {
    if (typeof value.settingsStore?.[method] !== "function") {
      throw new TypeError(`settingsStore.${method} is required.`);
    }
  }
  for (const callback of [
    "showWorkspace", "focusAssist", "cancelAssist", "shouldAllowClose", "onStatusChange",
    "now", "setIntervalFn", "clearIntervalFn", "setTimeoutFn", "clearTimeoutFn"
  ]) {
    if (typeof value[callback] !== "function") throw new TypeError(`${callback} is required.`);
  }
}
