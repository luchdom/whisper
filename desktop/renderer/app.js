import { CaptureController, CaptureStartCancelled, describeCaptureError } from "./capture-controller.js";
import { deriveTrayState, SessionState } from "./lib/session-state.js";
import { SessionEventGate } from "./lib/session-event-gate.js";
import { SerialTaskQueue } from "./lib/serial-task-queue.js";
import { StartAttemptCancelled, StartAttemptGate } from "./lib/start-attempt.js";
import { TranscriptStore, formatTimestamp, getTrackLabel } from "./lib/transcript-store.js";
import {
  formatDownloadBytes,
  getEffectiveLanguage,
  getTierLabel,
  groupCatalogModels,
  sanitizeCatalogDto
} from "./lib/model-presentation.js";

const DEFAULT_SETTINGS = Object.freeze({
  model: "small",
  language: "auto",
  diarization: true,
  translation: "off",
  transcriptDirectory: null,
  autoSave: false,
  closeBehavior: "quit",
  minimizeToTray: false,
  launchAtStartup: false,
  providerMode: "off",
  openAIModel: "gpt-5.6-luna"
});
const COMPONENT_LABELS = Object.freeze({
  meeting_transcriber: "Meeting Transcriber backend",
  faster_whisper: "faster-whisper",
  huggingface_hub: "Hugging Face Hub",
  sherpa_onnx: "sherpa-onnx"
});
const ENGINE_SETUP_STATES = Object.freeze([
  "ready",
  "python_missing",
  "python_unsupported",
  "components_missing",
  "components_broken",
  "resource_missing",
  "check_failed"
]);
const INITIAL_ENGINE_SETUP = Object.freeze({
  state: "checking",
  python: Object.freeze({ version: null, minimum: "3.12", supportedSeries: "3.12.x" }),
  components: Object.freeze({}),
  sourceSetupAvailable: false,
  platform: null
});
const bridge = window.meeting;
const state = new SessionState();
const eventGate = new SessionEventGate();
const startGate = new StartAttemptGate();
const autoSaveRefreshQueue = new SerialTaskQueue();
const transcript = new TranscriptStore();
const segmentNodes = new Map();
const announcedFinalIds = new Set();

const elements = {
  action: byId("session-action"),
  sessionDot: byId("session-dot"),
  sessionStatus: byId("session-status"),
  elapsed: byId("elapsed-time"),
  alert: byId("app-alert"),
  translationWarning: byId("translation-warning"),
  engineStatus: byId("engine-status"),
  modelProgress: byId("model-progress"),
  modelProgressLabel: byId("model-progress-label"),
  modelProgressBar: byId("model-progress-bar"),
  sourceSystem: byId("source-system"),
  sourceMicrophone: byId("source-microphone"),
  sourceSystemStatus: byId("source-system-status"),
  sourceMicrophoneStatus: byId("source-microphone-status"),
  model: byId("model-select"),
  modelHelper: byId("model-helper"),
  language: byId("language-select"),
  languageHelp: byId("language-help"),
  translationStatus: byId("translation-status"),
  transcriptScroll: byId("transcript-scroll"),
  transcriptContent: byId("transcript-content"),
  transcriptAnnouncement: byId("transcript-announcement"),
  emptyTranscript: byId("empty-transcript"),
  privacyNote: byId("privacy-note"),
  copy: byId("copy-transcript"),
  save: byId("save-transcript"),
  settingsButton: byId("open-settings"),
  settingsDialog: byId("settings-dialog"),
  settingsCloseTop: byId("close-settings-top"),
  settingsClose: byId("close-settings"),
  diarization: byId("diarization-toggle"),
  translation: byId("translation-toggle"),
  translationAvailability: byId("translation-availability"),
  translationDisclosure: byId("translation-disclosure"),
  folder: byId("transcript-folder"),
  chooseFolder: byId("choose-transcript-folder"),
  clearFolder: byId("clear-transcript-folder"),
  autoSave: byId("autosave-toggle"),
  settingsLockNote: byId("settings-lock-note"),
  appBehaviorLockNote: byId("app-behavior-lock-note"),
  closeBehaviorQuit: byId("close-behavior-quit"),
  closeBehaviorTray: byId("close-behavior-tray"),
  minimizeToTray: byId("minimize-to-tray"),
  launchAtStartup: byId("launch-at-startup"),
  startupAvailability: byId("startup-availability"),
  providerModeOff: byId("provider-mode-off"),
  providerModeOpenAI: byId("provider-mode-openai"),
  providerModeLocal: byId("provider-mode-local"),
  providerCard: byId("openai-provider-card"),
  providerModel: byId("provider-model-select"),
  providerCredentialStatus: byId("provider-credential-status"),
  importProviderCredential: byId("import-provider-credential"),
  revokeProviderCredential: byId("revoke-provider-credential"),
  providerDisclosureTitle: byId("provider-disclosure-title"),
  providerDisclosureSummary: byId("provider-disclosure-summary"),
  providerDisclosureLinks: byId("provider-disclosure-links"),
  providerFeedback: byId("provider-feedback"),
  providerLockNote: byId("provider-lock-note"),
  trayLocationLabels: document.querySelectorAll("[data-tray-location]"),
  engineSetupCard: byId("engine-setup-card"),
  engineSetupTitle: byId("engine-setup-title"),
  engineSetupMessage: byId("engine-setup-message"),
  engineSetupFeedback: byId("engine-setup-feedback"),
  openPythonDownload: byId("open-python-download"),
  copySetupCommand: byId("copy-setup-command"),
  checkEngineSetup: byId("check-engine-setup")
};

let settings = { ...DEFAULT_SETTINGS };
let modelCatalog = null;
let modelById = new Map();
let translationRuntimeState = "off";
let engineSetup = { ...INITIAL_ENGINE_SETUP, python: { ...INITIAL_ENGINE_SETUP.python }, components: {} };
let settingsReady = false;
let settingsBusy = false;
let settingsOperationPromise = Promise.resolve();
let providerStatus = null;
let providerStatusPromise = null;
let providerBusy = false;
let setupCheckPromise = null;
let setupActionBusy = false;
let setupFeedback = null;
let timer = null;
let recordingStartedAt = 0;
let frozenElapsedMs = 0;
let stopPromise = null;
let pendingStopFailure = null;
let startPromise = null;
let backendSessionStarted = false;
let autoSaveCreated = false;
let editingSegmentId = null;
let editingSpeakerId = null;
let autoSaveRefreshPending = 0;
let platformInfo = { startupSupported: false, trayLocation: "notification area" };
let lastReportedTrayState = null;

const capture = new CaptureController({
  bridge,
  onSourceState: setSourceState,
  onActivityChange: () => renderSession(),
  onInterruption: (track, error) => void interruptSession(track, error)
});

elements.action.addEventListener("click", () => {
  if (state.phase === "recording") void stopSession();
  else if (!state.active && !isEngineSetupReady()) openSettings();
  else if (!state.active) void beginStartSession();
});
elements.copy.addEventListener("click", () => void copyTranscript());
elements.save.addEventListener("click", () => void saveTranscriptCopy());
elements.sourceSystem.addEventListener("change", handleSourceSelection);
elements.sourceMicrophone.addEventListener("change", handleSourceSelection);
elements.model.addEventListener("change", () => void changeModel());
elements.language.addEventListener("change", () => void persistSettings({ language: elements.language.value }));
elements.diarization.addEventListener("change", () => void persistSettings({ diarization: elements.diarization.checked }));
elements.translation.addEventListener("change", () => void persistSettings({
  translation: elements.translation.checked ? "en_to_pt_br" : "off"
}));
elements.autoSave.addEventListener("change", () => void persistSettings({ autoSave: elements.autoSave.checked }));
elements.closeBehaviorQuit.addEventListener("change", () => {
  if (elements.closeBehaviorQuit.checked) void persistSettings({ closeBehavior: "quit" });
});
elements.closeBehaviorTray.addEventListener("change", () => {
  if (elements.closeBehaviorTray.checked) void persistSettings({ closeBehavior: "tray" });
});
elements.minimizeToTray.addEventListener("change", () => void persistSettings({
  minimizeToTray: elements.minimizeToTray.checked
}));
elements.launchAtStartup.addEventListener("change", () => void persistSettings({
  launchAtStartup: elements.launchAtStartup.checked
}));
elements.providerModeOff.addEventListener("change", () => {
  if (elements.providerModeOff.checked) void persistProviderSettings({ providerMode: "off" });
});
elements.providerModeOpenAI.addEventListener("change", () => {
  if (elements.providerModeOpenAI.checked) void persistProviderSettings({ providerMode: "openai" });
});
elements.providerModel.addEventListener("change", () => void persistProviderSettings({
  openAIModel: elements.providerModel.value
}));
elements.importProviderCredential.addEventListener("click", () => void importProviderCredential());
elements.revokeProviderCredential.addEventListener("click", () => void revokeProviderCredential());
elements.settingsButton.addEventListener("click", () => openSettings());
elements.settingsCloseTop.addEventListener("click", closeSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.chooseFolder.addEventListener("click", () => void chooseTranscriptFolder());
elements.clearFolder.addEventListener("click", () => void clearTranscriptFolder());
elements.openPythonDownload.addEventListener("click", () => void openPythonDownloadPage());
elements.copySetupCommand.addEventListener("click", () => void copySetupCommand());
elements.checkEngineSetup.addEventListener("click", () => void checkEngineSetup());
elements.settingsDialog.addEventListener("close", () => elements.settingsButton.focus());
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter" && !elements.action.disabled && !elements.settingsDialog.open) {
    event.preventDefault();
    elements.action.click();
  }
});

bridge.onBackendEvent(handleBackendEvent);
bridge.onTrayAction((action) => void handleTrayAction(action));
bridge.onBeforeClose(() => {
  void stopForClose().finally(() => bridge.notifyCloseReady());
});

renderSession();
renderTranscript();
void initialize();

async function initialize() {
  const [platformResult, settingsResult, setupResult] = await Promise.allSettled([
    bridge.getPlatform(),
    bridge.getSettings(),
    bridge.getEnginePrerequisites()
  ]);

  if (platformResult.status === "fulfilled") applyPlatform(platformResult.value);
  if (settingsResult.status === "fulfilled" && settingsResult.value?.ok) {
    const catalog = sanitizeCatalogDto(settingsResult.value.catalog);
    if (catalog) {
      applyCatalog(catalog);
      applySettings(settingsResult.value.settings);
    } else {
      applyCatalog(null);
      applySettings(DEFAULT_SETTINGS);
      showAlert("Model catalog unavailable.", "error");
    }
  } else {
    applyCatalog(null);
    applySettings(DEFAULT_SETTINGS);
    showAlert(
      settingsResult.status === "fulfilled" && settingsResult.value?.error === "Model catalog unavailable."
        ? "Model catalog unavailable."
        : "Settings could not be loaded. Restart the app and try again.",
      "error"
    );
  }
  if (setupResult.status === "fulfilled") {
    applyEnginePrerequisiteResult(setupResult.value);
  } else {
    applyEngineCheckFailure();
  }
  settingsReady = true;
  renderSession();
}

function applyPlatform(platform) {
  platformInfo = {
    startupSupported: platform?.startupSupported === true,
    trayLocation: platform?.trayLocation === "menu bar" ? "menu bar" : "notification area"
  };
  for (const label of elements.trayLocationLabels) label.textContent = platformInfo.trayLocation;
  if (!platform?.systemAudioSupported) {
    elements.sourceSystem.checked = false;
    elements.sourceSystem.disabled = true;
    elements.sourceSystem.dataset.unsupported = "true";
    setSourceState("system", "error", platform?.systemAudioRequirement || "Meeting audio is unavailable.");
  }
}

function beginStartSession() {
  if (!isEngineSetupReady()) {
    openSettings();
    return null;
  }
  if (startPromise || settingsBusy || autoSaveRefreshPending > 0) return startPromise;
  const generation = startGate.begin();
  startPromise = startSession(generation).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function startSession(generation) {
  const startSignal = startGate.signalFor(generation);
  const speakerRefreshPromise = settleSpeakerRenameBeforeTransition();
  eventGate.beginStart();
  if (state.phase === "error") state.resetError();
  const selection = selectedSources();
  if (!state.begin(selection)) {
    await speakerRefreshPromise;
    await autoSaveRefreshQueue.whenIdle();
    showAlert(state.error.message, "error");
    renderSession();
    return;
  }

  const previousTranscript = transcript.snapshot();
  const previousTranslationRuntimeState = translationRuntimeState;
  let transcriptReplaced = false;
  hideAlert();
  hideTranslationWarning();
  setTranslationRuntimeState(settings.translation === "en_to_pt_br" ? "on" : "off");
  frozenElapsedMs = 0;
  renderSession();
  updateSelectedSourceStates(selection, "idle", "Waiting for the local model");

  try {
    await speakerRefreshPromise;
    await autoSaveRefreshQueue.whenIdle();
    assertCurrentStart(generation);
    const startResult = await bridge.start({
      model: settings.model,
      language: settings.language,
      diarization: settings.diarization,
      translation: settings.translation
    });
    assertCurrentStart(generation);
    if (!startResult?.ok) throw new MeetingUiError("model_unavailable", startResult?.error);
    backendSessionStarted = true;
    autoSaveCreated = false;
    eventGate.activate(startResult.engine?.session_id);
    transcript.reset();
    announcedFinalIds.clear();
    transcriptReplaced = true;
    renderTranscript();
    await capture.start(selection, { signal: startSignal });
    assertCurrentStart(generation);
    state.markRecording();
    recordingStartedAt = performance.now();
    startTimer();
    renderSession();
  } catch (error) {
    await capture.stop().catch(() => {});
    if (backendSessionStarted) await bridge.stop().catch(() => {});
    backendSessionStarted = false;
    eventGate.clear();
    hideModelProgress();
    if (transcriptReplaced) {
      transcript.restore(previousTranscript);
      announcedFinalIds.clear();
      renderTranscript();
    }
    setTranslationRuntimeState(previousTranslationRuntimeState);
    if (error instanceof StartAttemptCancelled || error instanceof CaptureStartCancelled || startGate.closing) {
      if (state.phase === "starting") {
        state.beginStop();
        state.finishStop();
      }
      renderSession();
      return;
    }
    const issue = describeStartError(error);
    state.fail(issue.code, issue.message);
    showAlert(issue.message, "error");
    renderSession();
  }
}

function stopSession({ failure = null } = {}) {
  if (failure && !pendingStopFailure) pendingStopFailure = failure;
  if (stopPromise) return stopPromise;
  stopPromise = performStop().finally(() => {
    stopPromise = null;
    pendingStopFailure = null;
  });
  return stopPromise;
}

async function performStop() {
  await settleSpeakerRenameBeforeTransition();
  freezeTimer();
  state.beginStop();
  renderSession();
  renderTranscript();
  let stopError = null;
  let stopCompleted = false;
  let stoppedSuccessfully = false;

  try {
    // Capture stops and drains its final PCM packet before the backend receives stop.
    await capture.stop();
  } catch (error) {
    stopError = error;
  } finally {
    // Never replace the overt recording indicator while capture still owns
    // active tracks, including when stopping throws partway through cleanup.
    reportTrayState(capture.active ? "transcribing" : "stopped");
  }

  if (backendSessionStarted) {
    const result = await bridge.stop().catch(() => ({
      ok: false,
      error: "The transcript could not be finalized normally."
    }));
    backendSessionStarted = false;
    stopCompleted = Boolean(result?.ok);
    stoppedSuccessfully = Boolean(result?.ok && result?.successful !== false);
    if (!result?.ok && !stopError) stopError = new Error(result?.error);
    if (result?.ok && result?.successful === false && !stopError) {
      stopError = new MeetingUiError(
        "incomplete_transcript",
        result?.message || "The transcript did not finalize completely. Review the visible text; Save copy exports completed segments only."
      );
    }
  }

  let autoSaveResult = null;
  if (stopCompleted) {
    // Main relays final events before resolving stop. Leave one renderer turn
    // for those queued events and keep the active session gate open until the
    // final snapshot is visible, including when final inference was incomplete.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (stoppedSuccessfully && !pendingStopFailure && !stopError && transcript.hasFinalized()) {
    autoSaveResult = await saveFinalTranscriptAutomatically().catch(() => ({
      ok: false,
      error: "The transcript could not be saved automatically. It is still open here—choose another folder or save a copy."
    }));
  }
  eventGate.clear();

  state.finishStop();
  const issue = pendingStopFailure ?? (stopError ? describeStartError(stopError) : null);
  if (issue) {
    state.fail(issue.code, issue.message);
    showAlert(issue.message, "error");
  } else if (autoSaveResult?.ok && !autoSaveResult.skipped) {
    showAlert(`Transcript saved to ${autoSaveResult.fileName}.`, "success");
  } else if (autoSaveResult && !autoSaveResult.ok) {
    showAlert(
      autoSaveResult.error || "The transcript could not be saved automatically. It is still open here—choose another folder or save a copy.",
      "error"
    );
  }
  renderSession();
}

async function interruptSession(track, error) {
  if (!state.active || state.phase === "stopping") return;
  const issue = describeCaptureError(error, track);
  await stopSession({ failure: issue });
  setSourceState(track, "error", issue.message);
}

async function stopForClose() {
  startGate.cancelAll();
  const speakerRefreshPromise = settleSpeakerRenameBeforeTransition();
  const cancelStartPromise = startPromise
    ? bridge.cancelStart().catch(() => ({ ok: false }))
    : Promise.resolve({ ok: true, canceled: false });
  const captureStopPromise = capture.stop().catch(() => {});
  await cancelStartPromise;
  if (startPromise) await startPromise.catch(() => {});
  await captureStopPromise;
  await speakerRefreshPromise;
  await autoSaveRefreshQueue.whenIdle();
  await settingsOperationPromise;
  if (stopPromise) return stopPromise;
  if (state.active || backendSessionStarted || capture.active) return stopSession();
}

async function handleTrayAction(action) {
  if (action === "focus-start") {
    if (elements.settingsDialog.open) closeSettings();
    requestAnimationFrame(() => elements.action.focus());
    return;
  }
  if (action !== "stop") return;

  if (state.phase === "starting") {
    startGate.cancelCurrent();
    const cancelBackend = bridge.cancelStart().catch(() => ({ ok: false }));
    const stopCapture = capture.stop().catch(() => {});
    await cancelBackend;
    await stopCapture;
    if (startPromise) await startPromise.catch(() => {});
    return;
  }
  if (state.phase === "recording") await stopSession();
}

function reportTrayState(nextState) {
  if (lastReportedTrayState === nextState) return;
  lastReportedTrayState = nextState;
  try {
    bridge.reportTrayState({ state: nextState });
  } catch {
    // The in-window recording indicator remains authoritative if the native
    // tray becomes unavailable during shutdown.
  }
}

function assertCurrentStart(generation) {
  startGate.assertCurrent(generation);
}

function handleBackendEvent(event) {
  if (event.type === "engine_status") {
    const display = {
      configured: ["Configured", "idle"],
      loading: ["Loading local model…", "loading"],
      ready: [formatReadyEngine(event), "ready"],
      flushed: ["Transcript finalized", "ready"],
      shutdown: ["Stopped", "idle"],
      unavailable: ["Model unavailable", "error"]
    }[event.status];
    if (display) {
      if (state.active) setEngineState(display[0], display[1]);
      else renderEngineSetupSummary();
    }
    if (event.status === "loading") showModelProgress("loading", settings.model);
    else if (display) hideModelProgress();
    if (
      event.status === "ready"
      && settings.translation === "en_to_pt_br"
      && translationRuntimeState !== "original_only"
    ) setTranslationRuntimeState("ready");
    return;
  }

  if (event.type === "model_progress") {
    const display = {
      checking_cache: ["Checking model", "loading"],
      downloading: ["Downloading model", "loading"],
      verifying: ["Verifying model", "loading"],
      initializing: ["Preparing model", "loading"],
      preparing_speakers: ["Preparing speakers", "loading"],
      checking_translation_cache: ["Checking translation", "loading"],
      downloading_translation: ["Downloading translation", "loading"],
      verifying_translation: ["Verifying translation", "loading"],
      converting_translation: ["Converting translation", "loading"],
      initializing_translation: ["Preparing translation", "loading"]
    }[event.phase];
    if (display) {
      setEngineState(display[0], display[1]);
      showModelProgress(event.phase, settings.model);
      if (event.phase.endsWith("_translation") || event.phase === "checking_translation_cache") {
        setTranslationRuntimeState("on");
      }
    }
    return;
  }

  if (event.type === "partial_transcript" || event.type === "final_segment") {
    if (!eventGate.accepts(event)) return;
    const reconciled = transcript.reconcile(event);
    if (reconciled) {
      renderTranscript();
      if (event.type === "final_segment" && !announcedFinalIds.has(event.segment.id)) {
        announcedFinalIds.add(event.segment.id);
        announceFinalSegment(event.segment);
      }
    }
    return;
  }

  if (event.type === "warning" || event.type === "error") {
    const issue = describeBackendIssue(event);
    if (event.code === "translation_unavailable") {
      setTranslationRuntimeState("original_only");
      showTranslationWarning(issue.message);
    } else {
      showAlert(issue.message, event.type === "warning" ? "warning" : "error");
    }
    if (event.type === "error" && !event.recoverable && state.active) {
      void stopSession({ failure: { code: event.code, message: issue.message } });
    }
    return;
  }

  if (event.type === "session_stopped" && eventGate.accepts(event) && state.phase === "recording") {
    void stopSession({
      failure: {
        code: "backend_stopped",
        message: "The local transcription engine ended the session. Start a new transcription."
      }
    });
  }
}

function renderSession() {
  let presentation = {
    idle: { text: "Ready to start", dot: "neutral", action: "Start transcription", disabled: false, mode: "start" },
    starting: { text: "Preparing local model", dot: "working", action: "Preparing…", disabled: true, mode: "start" },
    recording: { text: "Recording", dot: "recording", action: "Stop transcription", disabled: false, mode: "stop" },
    stopping: { text: "Finalizing transcript", dot: "working", action: "Finalizing…", disabled: true, mode: "stop" },
    stopped: { text: "Stopped", dot: "neutral", action: "Start transcription", disabled: false, mode: "start" },
    error: { text: "Needs attention", dot: "recording", action: "Try again", disabled: false, mode: "start" }
  }[state.phase];

  if (!state.active && !isEngineSetupReady()) {
    const setupPresentation = describeEngineSetup();
    presentation = {
      text: setupPresentation.mainStatus,
      dot: setupPresentation.mainDot,
      action: "Open setup",
      disabled: false,
      mode: "setup"
    };
  } else if (!state.active && !modelCatalog) {
    presentation = {
      text: "Model catalog unavailable",
      dot: "recording",
      action: "Start unavailable",
      disabled: true,
      mode: "start"
    };
  }

  elements.sessionStatus.textContent = presentation.text;
  elements.sessionDot.className = `status-dot ${presentation.dot}`;
  elements.action.textContent = presentation.action;
  elements.action.disabled = presentation.disabled
    || !settingsReady
    || settingsBusy
    || autoSaveRefreshPending > 0
    || (presentation.mode === "start" && !modelCatalog);
  elements.action.dataset.mode = presentation.mode;
  const locked = state.active;
  elements.sourceSystem.disabled = locked || elements.sourceSystem.dataset.unsupported === "true";
  elements.sourceMicrophone.disabled = locked;
  for (const button of elements.transcriptContent.querySelectorAll(".speaker-label-button")) {
    button.disabled = isSpeakerEditingLocked();
  }
  if (!state.active) renderEngineSetupSummary();
  reportTrayState(deriveTrayState({
    phase: state.phase,
    captureActive: capture.active,
    settingsReady,
    engineReady: isEngineSetupReady(),
    catalogReady: Boolean(modelCatalog)
  }));
  renderSettingsAvailability();
}

function renderSettingsAvailability() {
  const locked = state.active || settingsBusy;
  const selectedModel = modelById.get(settings.model);
  const englishOnly = selectedModel?.languageMode === "english_only";
  const translationAvailable = modelCatalog?.translation.available === true;
  elements.model.disabled = locked || !settingsReady || !modelCatalog;
  elements.language.disabled = locked || englishOnly || !settingsReady || !modelCatalog;
  elements.languageHelp.hidden = !englishOnly;
  elements.settingsButton.disabled = state.active || !settingsReady;
  elements.diarization.disabled = locked;
  elements.translation.disabled = locked || !translationAvailable;
  elements.translationAvailability.hidden = translationAvailable;
  elements.translationDisclosure.hidden = !translationAvailable || !elements.translation.checked;
  elements.chooseFolder.disabled = locked;
  elements.clearFolder.disabled = locked;
  elements.autoSave.disabled = locked || !settings.transcriptDirectory;
  elements.closeBehaviorQuit.disabled = locked;
  elements.closeBehaviorTray.disabled = locked;
  elements.minimizeToTray.disabled = locked;
  elements.launchAtStartup.disabled = locked || !platformInfo.startupSupported;
  elements.startupAvailability.hidden = platformInfo.startupSupported;
  elements.providerModeOff.disabled = locked || providerBusy;
  elements.providerModeOpenAI.disabled = locked
    || providerBusy
    || providerStatus?.encryptionAvailable === false;
  elements.providerModeLocal.disabled = true;
  elements.providerModel.disabled = locked
    || providerBusy
    || !providerStatus
    || settings.providerMode !== "openai";
  elements.importProviderCredential.disabled = locked
    || providerBusy
    || settings.providerMode !== "openai"
    || providerStatus?.encryptionAvailable !== true
    || ["invalid", "unreadable"].includes(providerStatus?.credentialState);
  elements.revokeProviderCredential.disabled = locked || providerBusy;
  elements.providerLockNote.hidden = !state.active;
  elements.appBehaviorLockNote.hidden = !state.active;
  elements.settingsLockNote.hidden = !state.active;
  renderSelectedModelHelper();
  renderTranslationStatus();
  renderEngineSetup();
  renderProviderSettings();
}

function renderTranscript() {
  const segments = transcript.getAll();
  const nearBottom = elements.transcriptScroll.scrollHeight - elements.transcriptScroll.scrollTop
    - elements.transcriptScroll.clientHeight < 80;
  const activeIds = new Set(segments.map(({ id }) => id));

  for (const [id, node] of segmentNodes) {
    if (!activeIds.has(id)) {
      node.remove();
      segmentNodes.delete(id);
    }
  }

  for (const segment of segments) {
    let node = segmentNodes.get(segment.id);
    if (!node) {
      node = createSegmentNode(segment.id);
      segmentNodes.set(segment.id, node);
    }
    const speakerLabel = transcript.getSpeakerLabel(segment);
    node.classList.toggle("partial", segment.partial);
    renderSegmentSpeaker(node, segment, speakerLabel);
    node.querySelector(".segment-source").textContent = getTrackLabel(segment.track);
    node.querySelector(".segment-time").textContent = formatTimestamp(segment.start_ms);
    const originalText = node.querySelector(".segment-text");
    originalText.textContent = segment.text;
    setLanguageAttribute(originalText, segment.language);
    const hasTranslation = !segment.partial
      && typeof segment.translated_text === "string"
      && segment.translated_language === "pt-BR";
    const originalLabel = node.querySelector(".segment-original-label");
    originalLabel.hidden = !hasTranslation;
    originalLabel.textContent = hasTranslation
      ? `Original · ${formatLanguageLabel(segment.language)}`
      : "";
    const translation = node.querySelector(".segment-translation");
    translation.hidden = !hasTranslation;
    translation.querySelector(".segment-translation-text").textContent = hasTranslation
      ? segment.translated_text
      : "";
    node.removeAttribute("aria-label");
    elements.transcriptContent.append(node);
  }

  elements.emptyTranscript.hidden = segments.length > 0;
  elements.transcriptContent.hidden = segments.length === 0;
  const hasFinalized = transcript.hasFinalized();
  elements.copy.disabled = !hasFinalized;
  elements.save.disabled = !hasFinalized;
  if (nearBottom) elements.transcriptScroll.scrollTop = elements.transcriptScroll.scrollHeight;
}

function createSegmentNode(id) {
  const article = document.createElement("article");
  article.className = "transcript-segment";
  article.dataset.segmentId = id;
  const meta = document.createElement("div");
  meta.className = "segment-meta";
  const label = document.createElement("span");
  label.className = "segment-label";
  const source = document.createElement("span");
  source.className = "segment-source";
  const time = document.createElement("time");
  time.className = "segment-time";
  const marker = document.createElement("span");
  marker.className = "partial-marker";
  marker.textContent = "Draft";
  const text = document.createElement("p");
  text.className = "segment-text";
  const body = document.createElement("div");
  body.className = "segment-body";
  const originalLabel = document.createElement("span");
  originalLabel.className = "segment-original-label";
  originalLabel.hidden = true;
  const translation = document.createElement("div");
  translation.className = "segment-translation";
  translation.hidden = true;
  const translationLabel = document.createElement("span");
  translationLabel.className = "segment-translation-label";
  translationLabel.textContent = "Brazilian Portuguese";
  const translationText = document.createElement("p");
  translationText.className = "segment-translation-text";
  translationText.lang = "pt-BR";
  translation.append(translationLabel, translationText);
  meta.append(label, source, time, marker);
  body.append(originalLabel, text, translation);
  article.append(meta, body);
  return article;
}

function renderSegmentSpeaker(node, segment, speakerLabel) {
  const host = node.querySelector(".segment-label");
  const canRename = segment.track === "system" && segment.speaker_id !== null;
  if (!canRename) {
    host.textContent = speakerLabel;
    return;
  }

  if (editingSegmentId === segment.id && editingSpeakerId === String(segment.speaker_id)) {
    let input = host.querySelector(".speaker-name-input");
    if (!input) {
      input = document.createElement("input");
      input.className = "speaker-name-input";
      input.type = "text";
      input.maxLength = 64;
      input.value = speakerLabel;
      input.setAttribute("aria-label", `Rename ${speakerLabel}`);
      input.addEventListener("keydown", handleSpeakerInputKeydown);
      input.addEventListener("blur", handleSpeakerInputBlur);
      host.replaceChildren(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    }
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "speaker-label-button";
  button.textContent = speakerLabel;
  button.title = speakerLabel;
  button.disabled = isSpeakerEditingLocked();
  button.setAttribute("aria-label", `Rename ${speakerLabel}`);
  button.addEventListener("click", () => beginSpeakerRename(segment));
  host.replaceChildren(button);
}

function beginSpeakerRename(segment) {
  if (isSpeakerEditingLocked()) return;
  editingSegmentId = segment.id;
  editingSpeakerId = String(segment.speaker_id);
  renderTranscript();
}

async function settleSpeakerRenameBeforeTransition() {
  if (editingSegmentId === null || editingSpeakerId === null) return;
  const input = segmentNodes.get(editingSegmentId)?.querySelector(".speaker-name-input");
  const value = input?.value;
  let renamed = false;
  if (typeof value === "string" && value.trim()) {
    try {
      transcript.renameSpeaker(editingSpeakerId, value);
      renamed = true;
    } catch {
      // Keep the last valid alias when an unfinished edit is invalid.
    }
  }
  editingSegmentId = null;
  editingSpeakerId = null;
  renderTranscript();
  if (renamed) await refreshAutoSaveAfterSpeakerRename();
}

function isSpeakerEditingLocked() {
  return ["starting", "stopping"].includes(state.phase) || autoSaveRefreshPending > 0;
}

function handleSpeakerInputKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    void commitSpeakerRename(event.currentTarget.value);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelSpeakerRename();
  }
}

function handleSpeakerInputBlur(event) {
  if (editingSegmentId === null) return;
  if (event.currentTarget.value.trim()) {
    void commitSpeakerRename(event.currentTarget.value);
  } else {
    showAlert("Name can't be blank.", "error");
    queueMicrotask(() => event.currentTarget.focus());
  }
}

async function commitSpeakerRename(value) {
  const segmentId = editingSegmentId;
  const speakerId = editingSpeakerId;
  if (!segmentId || !speakerId) return;
  const previousAlias = transcript.getSpeakerAlias(speakerId);
  let nextAlias;
  try {
    nextAlias = transcript.renameSpeaker(speakerId, value);
  } catch (error) {
    showAlert(error.message, "error");
    return;
  }

  editingSegmentId = null;
  editingSpeakerId = null;
  renderTranscript();
  segmentNodes.get(segmentId)?.querySelector(".speaker-label-button")?.focus();
  elements.transcriptAnnouncement.textContent = `${previousAlias} renamed to ${nextAlias}.`;

  await refreshAutoSaveAfterSpeakerRename();
}

async function refreshAutoSaveAfterSpeakerRename() {
  if (state.active || !autoSaveCreated) return;
  autoSaveRefreshPending += 1;
  renderSession();
  try {
    const markdown = transcript.toMarkdown();
    const result = await autoSaveRefreshQueue.enqueue(() => bridge.refreshAutoSave(markdown));
    if (!result?.ok) {
      showAlert(result?.error || "The saved transcript could not be refreshed after the speaker rename.", "error");
    }
  } catch (error) {
    showAlert(error?.message || "The saved transcript could not be refreshed after the speaker rename.", "error");
  } finally {
    autoSaveRefreshPending -= 1;
    renderSession();
  }
}

function cancelSpeakerRename() {
  const segmentId = editingSegmentId;
  editingSegmentId = null;
  editingSpeakerId = null;
  renderTranscript();
  segmentNodes.get(segmentId)?.querySelector(".speaker-label-button")?.focus();
}

function announceFinalSegment(segment) {
  const translationNotice = segment.translated_text && segment.translated_language === "pt-BR"
    ? " Brazilian Portuguese translation available."
    : "";
  elements.transcriptAnnouncement.textContent = `${transcript.getSpeakerLabel(segment)}: ${segment.text}${translationNotice}`;
}

async function copyTranscript() {
  const result = await bridge.copy(transcript.toMarkdown());
  if (!result?.ok) {
    showAlert(result?.error || "The finalized transcript could not be copied.", "error");
    return;
  }
  showAlert("Finalized transcript copied.", "success");
}

async function saveTranscriptCopy() {
  const result = await bridge.saveCopy(transcript.toMarkdown());
  if (!result?.ok) {
    showAlert(result?.error || "The transcript copy could not be saved.", "error");
    return;
  }
  if (!result.canceled) showAlert(`Transcript copy saved as ${result.fileName}.`, "success");
}

async function saveFinalTranscriptAutomatically() {
  const result = await bridge.autoSave(transcript.toMarkdown());
  if (result?.ok && !result.skipped) autoSaveCreated = true;
  return result;
}

function openSettings() {
  if (state.active || elements.settingsDialog.open) return;
  elements.settingsDialog.showModal();
  void refreshProviderStatus();
  queueMicrotask(() => {
    focusEngineSetupRemediation();
  });
}

function closeSettings() {
  elements.settingsDialog.close();
}

function checkEngineSetup() {
  if (state.active || setupCheckPromise) return setupCheckPromise;
  setupFeedback = null;
  engineSetup = { ...engineSetup, state: "checking" };
  renderSession();

  const operation = (async () => {
    try {
      applyEnginePrerequisiteResult(await bridge.getEnginePrerequisites());
    } catch {
      applyEngineCheckFailure();
    }
  })();
  setupCheckPromise = operation.finally(() => {
    setupCheckPromise = null;
    renderSession();
  });
  return setupCheckPromise;
}

function openPythonDownloadPage() {
  if (!["python_missing", "python_unsupported"].includes(engineSetup.state)) return Promise.resolve();
  return runSetupAction(
    () => bridge.openPythonDownloadPage(),
    "Python download page opened. Install the supported version, then return here and check again.",
    "The Python download page could not be opened. Try again or open python.org in your browser."
  );
}

function copySetupCommand() {
  const sourceComponentProblem = ["components_missing", "components_broken"].includes(engineSetup.state)
    && engineSetup.sourceSetupAvailable;
  if (!sourceComponentProblem) return Promise.resolve();
  return runSetupAction(
    () => bridge.copyBootstrapCommand(),
    "Setup command copied. Run it in a terminal, then check again.",
    "The setup command could not be copied. Try again."
  );
}

async function runSetupAction(action, successMessage, failureMessage) {
  if (state.active || setupActionBusy) return;
  setupActionBusy = true;
  setupFeedback = null;
  renderEngineSetup();
  try {
    const result = await action();
    if (result?.ok === false) throw new Error("setup_action_failed");
    setupFeedback = { message: successMessage, tone: "success" };
  } catch {
    setupFeedback = { message: failureMessage, tone: "error" };
  } finally {
    setupActionBusy = false;
    renderEngineSetup();
  }
}

function applyEnginePrerequisiteResult(result) {
  const setup = result?.ok ? result.setup : null;
  if (!setup || !ENGINE_SETUP_STATES.includes(setup.state)) {
    applyEngineCheckFailure();
    return;
  }

  const components = {};
  for (const component of Object.keys(COMPONENT_LABELS)) {
    const componentState = setup.components?.[component];
    components[component] = ["ready", "missing", "broken", "unknown"].includes(componentState)
      ? componentState
      : "unknown";
  }
  engineSetup = {
    state: setup.state,
    python: {
      version: typeof setup.python?.version === "string" ? setup.python.version : null,
      minimum: typeof setup.python?.minimum === "string" ? setup.python.minimum : INITIAL_ENGINE_SETUP.python.minimum,
      supportedSeries: typeof setup.python?.supportedSeries === "string" ? setup.python.supportedSeries : null
    },
    components,
    sourceSetupAvailable: setup.sourceSetupAvailable === true,
    platform: typeof setup.platform === "string" ? setup.platform : null
  };
  setupFeedback = null;
  renderSession();
}

function applyEngineCheckFailure() {
  engineSetup = {
    ...INITIAL_ENGINE_SETUP,
    state: "check_failed",
    python: { ...INITIAL_ENGINE_SETUP.python },
    components: {}
  };
  setupFeedback = null;
  renderSession();
}

function isEngineSetupReady() {
  return engineSetup.state === "ready";
}

function describeEngineSetup() {
  const pythonLabel = supportedPythonLabel();
  const problemComponents = formatProblemComponents(engineSetup.state);
  const sourceSetup = engineSetup.sourceSetupAvailable;
  return {
    checking: {
      title: "Checking local engine…",
      message: "This check only inspects this device. It will not install or download anything.",
      summary: "Checking setup",
      summaryState: "checking",
      mainStatus: "Checking local engine",
      mainDot: "working"
    },
    ready: {
      title: "Local engine is ready",
      message: engineSetup.python.version
        ? `Python ${engineSetup.python.version} and all required components are available.`
        : "All required local engine components are available.",
      summary: "Ready",
      summaryState: "ready",
      mainStatus: "Ready to start",
      mainDot: "neutral"
    },
    python_missing: {
      title: "Python isn't installed",
      message: `${pythonLabel} is required. Install it, then return here and check again.`,
      summary: "Python required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    python_unsupported: {
      title: "Python version isn't supported",
      message: engineSetup.python.version
        ? `Python ${engineSetup.python.version} was found. This app currently supports ${pythonLabel}. Install it, then check again.`
        : `This app currently supports ${pythonLabel}. Install it, then check again.`,
      summary: "Unsupported Python",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    components_missing: {
      title: "Engine components are missing",
      message: sourceSetup
        ? `This source checkout is missing ${problemComponents}. Copy and run the setup command, then check again.`
        : `This developer build does not bundle a standalone local runtime yet. Unavailable components: ${problemComponents}. Use a source checkout and its bootstrap script.`,
      summary: "Setup required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    components_broken: {
      title: "Engine components need repair",
      message: sourceSetup
        ? `${problemComponents} could not be loaded. Copy and run the setup command to repair the source checkout, then check again.`
        : `${problemComponents} could not be loaded, and this developer build cannot repair its runtime. Use a source checkout and its bootstrap script.`,
      summary: "Repair required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    resource_missing: {
      title: "Engine resources are missing",
      message: "Required local engine resources could not be found. Reinstall the app or restore the source checkout, then check again.",
      summary: "Resources missing",
      summaryState: "error",
      mainStatus: "Local engine unavailable",
      mainDot: "recording"
    },
    check_failed: {
      title: "Local engine check failed",
      message: "The app could not verify the local engine. Try again. If this continues, restart the app.",
      summary: "Check failed",
      summaryState: "error",
      mainStatus: "Local engine unavailable",
      mainDot: "recording"
    }
  }[engineSetup.state] || {
    title: "Local engine check failed",
    message: "The app could not verify the local engine. Try again.",
    summary: "Check failed",
    summaryState: "error",
    mainStatus: "Local engine unavailable",
    mainDot: "recording"
  };
}

function supportedPythonLabel() {
  if (engineSetup.python.supportedSeries) return `Python ${engineSetup.python.supportedSeries}`;
  if (engineSetup.python.minimum) return `Python ${engineSetup.python.minimum} or later`;
  return "a supported Python version";
}

function formatProblemComponents(setupState) {
  const componentState = setupState === "components_broken" ? "broken" : "missing";
  const labels = Object.entries(engineSetup.components)
    .filter(([, value]) => value === componentState)
    .map(([component]) => COMPONENT_LABELS[component]);
  if (labels.length === 0) return "one or more required components";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function renderEngineSetup() {
  const display = describeEngineSetup();
  const pythonProblem = ["python_missing", "python_unsupported"].includes(engineSetup.state);
  const sourceComponentProblem = ["components_missing", "components_broken"].includes(engineSetup.state)
    && engineSetup.sourceSetupAvailable;
  const locked = state.active || setupActionBusy;
  elements.engineSetupCard.dataset.state = engineSetup.state;
  elements.engineSetupTitle.textContent = display.title;
  elements.engineSetupMessage.textContent = display.message;
  elements.openPythonDownload.hidden = !pythonProblem;
  elements.openPythonDownload.disabled = locked;
  elements.copySetupCommand.hidden = !sourceComponentProblem;
  elements.copySetupCommand.disabled = locked;
  elements.checkEngineSetup.disabled = locked || engineSetup.state === "checking";
  elements.engineSetupFeedback.hidden = !setupFeedback;
  elements.engineSetupFeedback.textContent = setupFeedback?.message || "";
  elements.engineSetupFeedback.dataset.tone = setupFeedback?.tone || "";
}

function renderEngineSetupSummary() {
  const display = describeEngineSetup();
  setEngineState(display.summary, display.summaryState);
}

function focusEngineSetupRemediation() {
  const target = [elements.openPythonDownload, elements.copySetupCommand, elements.checkEngineSetup]
    .find((button) => !button.hidden && !button.disabled);
  (target || elements.engineSetupCard).focus();
}

function refreshProviderStatus() {
  if (providerStatusPromise) return providerStatusPromise;
  clearProviderFeedback();
  renderProviderSettings();
  const operation = (async () => {
    try {
      const result = await bridge.getProviderStatus();
      if (!result?.ok) throw new Error(result?.error || "Secure provider status could not be checked.");
      applyProviderStatus(result.provider);
    } catch (error) {
      providerStatus = null;
      setProviderFeedback(error.message || "Secure provider status could not be checked.", "error");
    }
  })();
  providerStatusPromise = operation.finally(() => {
    providerStatusPromise = null;
    renderSettingsAvailability();
  });
  renderProviderSettings();
  return providerStatusPromise;
}

function importProviderCredential() {
  return runProviderOperation(async () => {
    const result = await bridge.importProviderCredential();
    if (!result?.ok) throw new Error(result?.error || "The OpenAI API key could not be imported.");
    applyProviderStatus(result.provider);
    setProviderFeedback("OpenAI API key imported into operating-system encrypted storage. No connection test was made.", "success");
  });
}

function revokeProviderCredential() {
  if (!window.confirm("Remove the saved OpenAI API key from this device? AI assistance will be turned Off.")) {
    return Promise.resolve();
  }
  return runProviderOperation(async () => {
    const result = await bridge.revokeProviderCredential();
    if (result?.settings) applySettings(result.settings);
    if (result?.provider) applyProviderStatus(result.provider);
    if (!result?.ok) throw new Error(result?.error || "The saved OpenAI API key could not be removed.");
    setProviderFeedback("Saved OpenAI API key removed. AI assistance is Off.", "success");
  });
}

function runProviderOperation(task) {
  if (state.active || providerBusy) return Promise.resolve();
  providerBusy = true;
  clearProviderFeedback();
  renderSettingsAvailability();
  return (async () => {
    try {
      await task();
    } catch (error) {
      setProviderFeedback(error.message || "Secure provider settings could not be updated.", "error");
    } finally {
      providerBusy = false;
      renderSettingsAvailability();
    }
  })();
}

function applyProviderStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Secure provider status could not be checked.");
  }
  const models = Array.isArray(value.catalog?.openAIModels)
    ? value.catalog.openAIModels.filter((model) => (
      model && model.id === "gpt-5.6-luna" && typeof model.label === "string"
    ))
    : [];
  const credentialState = ["absent", "configured", "invalid", "unreadable"].includes(value.credentialState)
    ? value.credentialState
    : null;
  const links = Array.isArray(value.disclosure?.links)
    ? value.disclosure.links.filter((link) => (
      link
      && ["privacy", "data-controls", "usage"].includes(link.id)
      && typeof link.label === "string"
    ))
    : [];
  if (!credentialState
    || value.configured !== (credentialState === "configured")
    || value.removable !== (credentialState !== "absent")
    || models.length === 0
    || typeof value.disclosure?.title !== "string"
    || typeof value.disclosure?.summary !== "string"
    || typeof value.disclosure?.version !== "string") {
    throw new Error("Secure provider status could not be checked.");
  }
  providerStatus = {
    credentialState,
    configured: credentialState === "configured",
    removable: credentialState !== "absent",
    encryptionAvailable: value.encryptionAvailable === true,
    models,
    disclosure: {
      title: value.disclosure.title,
      summary: value.disclosure.summary,
      version: value.disclosure.version,
      links
    }
  };
  elements.providerModel.replaceChildren(...models.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    return option;
  }));
  elements.providerModel.value = settings.openAIModel;
  renderProviderSettings();
}

function renderProviderSettings() {
  elements.providerModeOff.checked = settings.providerMode === "off";
  elements.providerModeOpenAI.checked = settings.providerMode === "openai";
  elements.providerCard.hidden = settings.providerMode !== "openai"
    && providerStatus?.removable !== true;
  if (providerStatus) elements.providerModel.value = settings.openAIModel;

  if (providerStatusPromise) {
    elements.providerCredentialStatus.textContent = "Checking operating-system encrypted credential storage…";
  } else if (!providerStatus) {
    elements.providerCredentialStatus.textContent = "Secure credential status has not been checked.";
  } else if (providerStatus.credentialState === "invalid") {
    elements.providerCredentialStatus.textContent = "A saved credential is invalid and needs removal.";
  } else if (providerStatus.credentialState === "unreadable") {
    elements.providerCredentialStatus.textContent = "A saved credential cannot be read and needs removal.";
  } else if (!providerStatus.encryptionAvailable) {
    elements.providerCredentialStatus.textContent = "Operating-system encrypted credential storage is unavailable.";
  } else if (providerStatus.credentialState === "configured") {
    elements.providerCredentialStatus.textContent = "API key saved in operating-system encrypted storage.";
  } else {
    elements.providerCredentialStatus.textContent = "No API key saved.";
  }
  elements.revokeProviderCredential.hidden = providerStatus?.removable !== true;

  if (providerStatus?.disclosure) {
    elements.providerDisclosureTitle.textContent = providerStatus.disclosure.title;
    elements.providerDisclosureSummary.textContent = providerStatus.disclosure.summary;
    elements.providerDisclosureLinks.replaceChildren(...providerStatus.disclosure.links.map((link) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-link-button";
      button.textContent = link.label;
      button.addEventListener("click", () => void openProviderLink(link.id));
      return button;
    }));
  }
}

async function openProviderLink(linkId) {
  const result = await bridge.openProviderLink(linkId);
  if (!result?.ok) {
    setProviderFeedback(result?.error || "The provider information page could not be opened.", "error");
  }
}

function setProviderFeedback(message, tone) {
  elements.providerFeedback.textContent = message;
  elements.providerFeedback.dataset.tone = tone;
  elements.providerFeedback.setAttribute("role", tone === "error" ? "alert" : "status");
  elements.providerFeedback.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
}

function clearProviderFeedback() {
  elements.providerFeedback.textContent = "";
  elements.providerFeedback.dataset.tone = "";
  elements.providerFeedback.setAttribute("role", "status");
  elements.providerFeedback.setAttribute("aria-live", "polite");
}

async function changeModel() {
  const model = elements.model.value;
  await persistSettings({ model });
}

function persistSettings(patch) {
  return runSettingsOperation(async () => {
    const previous = settings;
    try {
      const result = await bridge.updateSettings(patch);
      if (!result?.ok) throw new Error(result?.error || "Settings could not be saved.");
      applySettings(result.settings);
      hideAlert();
    } catch (error) {
      applySettings(previous);
      showAlert(error.message || "Settings could not be saved.", "error");
    }
  });
}

function persistProviderSettings(patch) {
  return runSettingsOperation(async () => {
    const previous = settings;
    clearProviderFeedback();
    try {
      const result = await bridge.updateSettings(patch);
      if (!result?.ok) throw new Error(result?.error || "AI assistance settings could not be saved.");
      applySettings(result.settings);
    } catch (error) {
      applySettings(previous);
      setProviderFeedback(error.message || "AI assistance settings could not be saved.", "error");
    }
  });
}

function chooseTranscriptFolder() {
  return runSettingsOperation(async () => {
    try {
      const result = await bridge.chooseTranscriptFolder();
      if (!result?.ok) throw new Error(result?.error || "The transcript folder could not be selected.");
      applySettings(result.settings);
      if (!result.canceled) showAlert("Transcript folder selected. Automatic saving is on.", "success");
    } catch (error) {
      showAlert(error.message || "The transcript folder could not be selected.", "error");
    }
  });
}

function clearTranscriptFolder() {
  return runSettingsOperation(async () => {
    try {
      const result = await bridge.clearTranscriptFolder();
      if (!result?.ok) throw new Error(result?.error || "The transcript folder setting could not be cleared.");
      applySettings(result.settings);
      showAlert("Transcript folder cleared. Automatic saving is off.", "success");
    } catch (error) {
      showAlert(error.message || "The transcript folder setting could not be cleared.", "error");
    }
  });
}

function runSettingsOperation(task) {
  if (state.active || settingsBusy) return settingsOperationPromise;
  settingsBusy = true;
  renderSession();
  const operation = (async () => {
    try {
      await task();
    } finally {
      settingsBusy = false;
      renderSession();
    }
  })();
  settingsOperationPromise = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function applyCatalog(value) {
  modelCatalog = value;
  modelById = new Map(value?.models.map((model) => [model.id, model]) ?? []);
  elements.model.replaceChildren();
  if (!value) {
    elements.modelHelper.textContent = "Model catalog unavailable.";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groupCatalogModels(value)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const model of group.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      optgroup.append(option);
    }
    fragment.append(optgroup);
  }
  elements.model.append(fragment);
}

function applySettings(value) {
  const requestedModel = modelById.has(value?.model)
    ? value.model
    : modelCatalog?.defaultModelId ?? DEFAULT_SETTINGS.model;
  const requestedLanguage = ["auto", "en", "pt"].includes(value?.language)
    ? value.language
    : DEFAULT_SETTINGS.language;
  const translationAvailable = modelCatalog?.translation.available === true;
  settings = {
    model: requestedModel,
    language: requestedLanguage,
    diarization: typeof value?.diarization === "boolean" ? value.diarization : DEFAULT_SETTINGS.diarization,
    translation: translationAvailable && value?.translation === "en_to_pt_br" ? "en_to_pt_br" : "off",
    transcriptDirectory: value?.transcriptDirectory || null,
    autoSave: Boolean(value?.transcriptDirectory && value?.autoSave),
    closeBehavior: value?.closeBehavior === "tray" ? "tray" : "quit",
    minimizeToTray: value?.minimizeToTray === true,
    launchAtStartup: value?.launchAtStartup === true,
    providerMode: value?.providerMode === "openai" ? "openai" : "off",
    openAIModel: value?.openAIModel === "gpt-5.6-luna"
      ? "gpt-5.6-luna"
      : DEFAULT_SETTINGS.openAIModel
  };
  elements.model.value = settings.model;
  elements.language.value = getEffectiveLanguage(modelById.get(settings.model), settings.language);
  elements.diarization.checked = settings.diarization;
  elements.translation.checked = settings.translation === "en_to_pt_br";
  elements.autoSave.checked = settings.autoSave;
  elements.closeBehaviorQuit.checked = settings.closeBehavior === "quit";
  elements.closeBehaviorTray.checked = settings.closeBehavior === "tray";
  elements.minimizeToTray.checked = settings.minimizeToTray;
  elements.launchAtStartup.checked = settings.launchAtStartup;
  elements.providerModeOff.checked = settings.providerMode === "off";
  elements.providerModeOpenAI.checked = settings.providerMode === "openai";
  if (providerStatus) elements.providerModel.value = settings.openAIModel;
  elements.folder.textContent = settings.transcriptDirectory || "Not set — choose a location when you save.";
  elements.folder.title = settings.transcriptDirectory || "Not set";
  elements.folder.setAttribute(
    "aria-label",
    settings.transcriptDirectory
      ? `Default transcript folder: ${settings.transcriptDirectory}`
      : "Default transcript folder is not set"
  );
  elements.clearFolder.hidden = !settings.transcriptDirectory;
  elements.privacyNote.textContent = settings.autoSave
    ? "Audio is never saved. Final text is saved automatically when this meeting ends."
    : "Audio is never saved. Final text stays here until you save it or start another meeting.";
  elements.translationDisclosure.textContent = translationAvailable
    ? `The verified local translation model is checked when you start. First use may download about ${formatDownloadBytes(modelCatalog.translation.downloadBytes)}. It then runs locally.`
    : "";
  if (!state.active) {
    setTranslationRuntimeState(settings.translation === "en_to_pt_br" ? "on" : "off");
    if (settings.translation === "off") hideTranslationWarning();
  }
  renderSettingsAvailability();
}

function renderSelectedModelHelper() {
  const model = modelById.get(settings.model);
  if (!model) {
    elements.modelHelper.textContent = "Model catalog unavailable.";
    return;
  }
  const separator = model.helper.indexOf(" · ");
  const guidance = separator >= 0 ? model.helper.slice(separator + 3) : model.helper;
  elements.modelHelper.textContent = `${getTierLabel(model.tier)} · About ${formatDownloadBytes(model.downloadBytes)} download · ${guidance}`;
}

function setSourceState(track, sourceState, message) {
  const target = track === "system" ? elements.sourceSystemStatus : elements.sourceMicrophoneStatus;
  target.dataset.state = sourceState;
  const dot = target.querySelector(".mini-dot");
  target.replaceChildren(dot, document.createTextNode(` ${message}`));
}

function setEngineState(message, engineState) {
  elements.engineStatus.textContent = message;
  elements.engineStatus.dataset.state = engineState;
}

function setTranslationRuntimeState(nextState) {
  if (!["off", "on", "ready", "original_only"].includes(nextState)) return;
  translationRuntimeState = nextState;
  renderTranslationStatus();
}

function renderTranslationStatus() {
  const display = {
    off: null,
    on: ["Translation on", "checking"],
    ready: ["Translation ready", "ready"],
    original_only: ["Original only", "warning"]
  }[translationRuntimeState];
  elements.translationStatus.hidden = !display;
  elements.translationStatus.textContent = display?.[0] ?? "";
  elements.translationStatus.dataset.state = display?.[1] ?? "";
}

function showTranslationWarning(message) {
  elements.translationWarning.textContent = message;
  elements.translationWarning.hidden = false;
}

function hideTranslationWarning() {
  elements.translationWarning.hidden = true;
  elements.translationWarning.textContent = "";
}

function showModelProgress(phase, model) {
  const modelLabel = modelById.get(model)?.label || "the selected model";
  elements.modelProgressLabel.textContent = {
    checking_cache: `Checking ${modelLabel} on this device…`,
    downloading: `Downloading ${modelLabel}…`,
    verifying: `Verifying ${modelLabel}…`,
    initializing: `Opening ${modelLabel} locally…`,
    preparing_speakers: "Preparing anonymous speaker detection…",
    checking_translation_cache: "Checking the translation model on this device…",
    downloading_translation: "Downloading the Brazilian Portuguese translation model…",
    verifying_translation: "Verifying the translation model…",
    converting_translation: "Converting the verified translation model locally…",
    initializing_translation: "Opening translation locally…",
    loading: "Preparing the selected local model…"
  }[phase] || "Preparing the selected local model…";
  elements.modelProgressBar.removeAttribute("value");
  elements.modelProgress.hidden = false;
}

function hideModelProgress() {
  elements.modelProgress.hidden = true;
  elements.modelProgressBar.removeAttribute("value");
}

function formatReadyEngine(event) {
  const runtime = [event.device?.toUpperCase(), event.compute].filter(Boolean).join("/");
  return runtime ? `Ready · ${runtime}` : "Model ready";
}

function setLanguageAttribute(element, language) {
  if (typeof language === "string" && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) {
    element.lang = language;
  } else {
    element.removeAttribute("lang");
  }
}

function formatLanguageLabel(language) {
  if (language === "en") return "English";
  if (language === "pt" || language === "pt-BR") return "Portuguese";
  return typeof language === "string" && language ? language.toUpperCase() : "Source language";
}

function updateSelectedSourceStates(selection, sourceState, message) {
  if (selection.system) setSourceState("system", sourceState, message);
  if (selection.microphone) setSourceState("microphone", sourceState, message);
}

function handleSourceSelection() {
  if (state.phase === "error" && state.error?.code === "no_source_selected") state.resetError();
  hideAlert();
  renderSession();
}

function selectedSources() {
  return {
    system: elements.sourceSystem.checked && !elements.sourceSystem.disabled,
    microphone: elements.sourceMicrophone.checked && !elements.sourceMicrophone.disabled
  };
}

function startTimer() {
  stopTimer();
  updateTimer();
  timer = setInterval(updateTimer, 500);
}

function freezeTimer() {
  if (state.phase === "recording") frozenElapsedMs = performance.now() - recordingStartedAt;
  stopTimer();
  updateTimer();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function updateTimer() {
  const elapsed = state.phase === "recording" ? performance.now() - recordingStartedAt : frozenElapsedMs;
  const totalSeconds = Math.max(0, Math.floor(elapsed / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  elements.elapsed.textContent = [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  elements.elapsed.dateTime = `PT${hours}H${minutes}M${seconds}S`;
}

function showAlert(message, tone) {
  elements.alert.textContent = message;
  elements.alert.dataset.tone = tone;
  elements.alert.setAttribute("role", tone === "error" ? "alert" : "status");
  elements.alert.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  elements.alert.hidden = false;
}

function hideAlert() {
  elements.alert.hidden = true;
  elements.alert.textContent = "";
}

function describeStartError(error) {
  if (error instanceof MeetingUiError) {
    return {
      code: error.code,
      message: error.message || "The local transcription model could not start. Check the selected model and try again."
    };
  }
  if (error?.code && error?.message) return error;
  return {
    code: "session_failed",
    message: "The transcription could not start or finish. Check the local model and try again."
  };
}

function describeBackendIssue(event) {
  if (event.code === "diarization_unavailable") {
    return {
      message: "Speaker detection is unavailable. Transcription will continue with audio-source labels."
    };
  }
  if (event.code === "translation_unavailable") {
    return {
      message: "Brazilian Portuguese translation is unavailable for this meeting. Original English will continue. Translation will be retried next time."
    };
  }
  if (event.type === "warning") {
    return { message: "The local engine reported a recoverable issue. Transcription will continue." };
  }
  return { message: "The local transcription engine reported an error. Stop and try again." };
}

class MeetingUiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing renderer element: ${id}`);
  return element;
}
