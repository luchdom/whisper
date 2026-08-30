import { CaptureController, CaptureStartCancelled, describeCaptureError } from "./capture-controller.js";
import { deriveTrayState, SessionState } from "./lib/session-state.js";
import {
  AssistRequestAttempt,
  AssistRequestCanceledError,
  AssistRequestGate,
  AssistStatusGenerationGate,
  AssistTerminalDeliveryTimeoutError
} from "./lib/assist-request-gate.js";
import { SessionEventGate } from "./lib/session-event-gate.js";
import { SerialTaskQueue } from "./lib/serial-task-queue.js";
import { StartAttemptCancelled, StartAttemptGate } from "./lib/start-attempt.js";
import { TranscriptStore, formatTimestamp, getTrackLabel } from "./lib/transcript-store.js";
import { DEBRIEF_SECTION_IDS, DebriefStore } from "./lib/debrief-store.js";
import { isDebriefExtractDerivedFromOriginal } from "../shared/debrief-text.js";
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
const ASSIST_QUESTION_MAX_CHARS = 1_000;
const CONTEXT_PACK_MAX_SELECTED = 12;
const CONTEXT_PACK_KINDS = new Set([
  "objective",
  "talking_points",
  "job_description",
  "resume",
  "product_facts",
  "presentation_notes",
  "custom_notes"
]);
const CONTEXT_KIND_LABELS = Object.freeze({
  objective: "Meeting objective",
  talking_points: "Talking points",
  job_description: "Role or job description",
  resume: "Resume or experience",
  product_facts: "Product facts",
  presentation_notes: "Presentation notes",
  custom_notes: "Custom notes"
});
const ASSIST_PROVIDER_LINK_IDS = new Set(["privacy", "data-controls", "usage"]);
const ASSIST_CREDENTIAL_STATES = new Set(["absent", "configured", "invalid", "unreadable"]);
const DEBRIEF_SECTION_PRESENTATION = Object.freeze({
  summary: Object.freeze({ title: "Summary", empty: "No extractive summary was identified." }),
  decisions: Object.freeze({ title: "Decisions", empty: "No explicit decisions were identified." }),
  actions: Object.freeze({ title: "Action items", empty: "No explicit action items were identified." }),
  open_questions_risks: Object.freeze({ title: "Open questions and risks", empty: "No explicit open questions or risks were identified." }),
  objections: Object.freeze({ title: "Important objections and questions", empty: "No explicit objections or important questions were identified." }),
  coaching: Object.freeze({ title: "Coaching observations", empty: "No local coaching observation was available." })
});
const DEBRIEF_STATE_PRESENTATION = Object.freeze({
  empty: Object.freeze({ label: "No debrief yet", tone: "empty" }),
  manual: Object.freeze({ label: "Local draft", tone: "manual" }),
  generating: Object.freeze({ label: "Generating", tone: "generating" }),
  ready: Object.freeze({ label: "Ready for review", tone: "ready" }),
  partial: Object.freeze({ label: "Partial — review coverage", tone: "partial" }),
  failed: Object.freeze({ label: "Couldn’t create debrief", tone: "failed" })
});
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
const assistEventGate = new AssistRequestGate();
const assistStatusGate = new AssistStatusGenerationGate();
const startGate = new StartAttemptGate();
const autoSaveRefreshQueue = new SerialTaskQueue();
const transcript = new TranscriptStore();
const debrief = new DebriefStore();
const segmentNodes = new Map();
const announcedFinalIds = new Set();

const elements = {
  action: byId("session-action"),
  ribbonStatusDot: byId("ribbon-status-dot"),
  ribbonStatus: byId("ribbon-status"),
  ribbonSummary: byId("ribbon-summary"),
  ribbonElapsed: byId("ribbon-elapsed"),
  setupRailToggle: byId("toggle-setup-rail"),
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
  clearedTranscript: byId("cleared-transcript"),
  privacyNote: byId("privacy-note"),
  copy: byId("copy-transcript"),
  save: byId("save-transcript"),
  clearTranscriptView: byId("clear-transcript-view"),
  settingsButton: byId("open-settings"),
  overlayToggle: byId("toggle-overlay"),
  settingsDialog: byId("settings-dialog"),
  settingsCloseTop: byId("close-settings-top"),
  settingsClose: byId("close-settings"),
  overlaySettingsSection: byId("overlay-settings-section"),
  overlayStatus: byId("overlay-status"),
  overlayAccessible: byId("overlay-mode-accessible"),
  overlayPrivate: byId("overlay-mode-private"),
  overlayOpacityRow: byId("overlay-opacity-row"),
  overlayOpacity: byId("overlay-opacity"),
  overlayOpacityValue: byId("overlay-opacity-value"),
  overlayDisclosure: byId("overlay-mode-disclosure"),
  overlayAcknowledged: byId("overlay-disclosure-acknowledged"),
  overlayShortcutList: byId("overlay-shortcut-list"),
  showOverlay: byId("show-overlay"),
  resetOverlay: byId("reset-overlay"),
  retryOverlayShortcuts: byId("retry-overlay-shortcuts"),
  resetOverlayShortcuts: byId("reset-overlay-shortcuts"),
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
  meetingProfile: byId("meeting-profile-select"),
  meetingProfileName: byId("meeting-profile-name"),
  meetingProfileDescription: byId("meeting-profile-description"),
  meetingProfileLimitations: byId("meeting-profile-limitations"),
  selectedContextPacks: byId("selected-context-packs"),
  manageContextPacks: byId("manage-context-packs"),
  meetingContextLockNote: byId("meeting-context-lock-note"),
  contextPacksDialog: byId("context-packs-dialog"),
  contextPacksCloseTop: byId("close-context-packs-top"),
  contextPacksClose: byId("close-context-packs"),
  contextPackStorageWarning: byId("context-pack-storage-warning"),
  contextPackList: byId("context-pack-list"),
  contextPackListEmpty: byId("context-pack-list-empty"),
  newContextPack: byId("new-context-pack"),
  contextPackForm: byId("context-pack-form"),
  contextPackId: byId("context-pack-id"),
  contextPackRevision: byId("context-pack-revision"),
  contextPackKind: byId("context-pack-kind"),
  contextPackName: byId("context-pack-name"),
  contextPackContent: byId("context-pack-content"),
  contextPackFeedback: byId("context-pack-feedback"),
  contextPackCancelEdit: byId("cancel-context-pack-edit"),
  contextPackSave: byId("save-context-pack"),
  assistPanel: byId("assist-panel"),
  assistStateBadge: byId("assist-state-badge"),
  assistEmpty: byId("assist-empty"),
  assistEmptyMessage: byId("assist-empty-message"),
  assistCollapsed: byId("assist-collapsed"),
  assistExpand: byId("expand-assist"),
  assistDismissCollapsed: byId("dismiss-assist-collapsed"),
  assistExpanded: byId("assist-expanded"),
  assistContextSummary: byId("assist-context-summary"),
  assistQuickActions: byId("assist-quick-actions"),
  assistReviewContext: byId("review-assist-context"),
  assistProviderAvailability: byId("assist-provider-availability"),
  assistProviderMessage: byId("assist-provider-message"),
  assistOpenSettings: byId("open-assist-settings"),
  assistQuestion: byId("assist-question"),
  assistQuestionCount: byId("assist-question-count"),
  assistQuestionValidation: byId("assist-question-validation"),
  assistConsent: byId("assist-consent"),
  assistDisclosure: byId("assist-disclosure"),
  assistRequestPreview: byId("assist-request-preview"),
  assistPolicyVersion: byId("assist-policy-version"),
  assistProviderLinks: byId("assist-provider-links"),
  assistProgress: byId("assist-progress"),
  assistMessage: byId("assist-message"),
  assistResult: byId("assist-result"),
  assistResultContext: byId("assist-result-context"),
  assistResultState: byId("assist-result-state"),
  assistStale: byId("assist-stale"),
  assistUseLatestContext: byId("use-latest-assist-context"),
  assistKeepAnswer: byId("keep-assist-answer"),
  assistResultContent: byId("assist-result-content"),
  assistCopySuggestion: byId("copy-assist-suggestion"),
  assistResetRequest: byId("reset-assist-request"),
  assistClearResponse: byId("clear-assist-response"),
  assistDismiss: byId("dismiss-assist"),
  assistCancel: byId("cancel-assist"),
  assistSend: byId("send-assist"),
  assistContextDialog: byId("assist-context-dialog"),
  assistContextDialogSummary: byId("assist-context-dialog-summary"),
  assistContextPrivateSummary: byId("assist-context-private-summary"),
  assistContextList: byId("assist-context-list"),
  assistContextDialogEmpty: byId("assist-context-dialog-empty"),
  assistContextCloseTop: byId("close-assist-context-top"),
  assistContextBack: byId("back-assist-context"),
  assistContextUse: byId("use-assist-context"),
  workspaceTabs: [byId("workspace-tab-copilot"), byId("workspace-tab-debrief")],
  workspaceCopilotPanel: byId("workspace-panel-copilot"),
  workspaceDebriefPanel: byId("workspace-panel-debrief"),
  debriefTabIndicator: byId("debrief-tab-indicator"),
  debriefStateBadge: byId("debrief-state-badge"),
  debriefStatus: byId("debrief-status"),
  debriefStatusMessage: byId("debrief-status-message"),
  debriefGenerate: byId("generate-debrief"),
  debriefCopy: byId("copy-debrief"),
  debriefSave: byId("save-debrief"),
  debriefClear: byId("clear-debrief"),
  debriefDeleteSourceData: byId("delete-debrief-source-data"),
  debriefSections: byId("debrief-sections"),
  localDeleteDialog: byId("local-delete-dialog"),
  localDeleteTitle: byId("local-delete-title"),
  localDeleteMessage: byId("local-delete-message"),
  localDeleteCancel: byId("cancel-local-delete"),
  localDeleteConfirm: byId("confirm-local-delete"),
  sessionConsentDialog: byId("session-consent-dialog"),
  sessionConsentCloseTop: byId("close-session-consent-top"),
  sessionConsentCancel: byId("cancel-session-consent"),
  sessionConsentConfirm: byId("confirm-session-consent"),
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
let assistLibrary = createEmptyAssistLibrary();
let assistSelection = createDefaultAssistSelection();
let activeAssistSelection = null;
let contextPackBusy = false;
let assistStatus = null;
let assistStatusRequest = null;
let assistStatusRefreshTimer = null;
let assistExpanded = false;
let assistDismissedSessionId = null;
let assistConsentChecked = false;
let assistConsentPromise = null;
let assistRequestContext = null;
let assistRequestPromise = null;
let assistRequestAttempt = null;
let assistDeliveryBlockedContext = null;
let assistCancelPending = false;
let assistOutput = null;
let assistMessage = null;
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
let activeWorkspaceTab = "copilot";
let sessionConsentReturnTarget = null;
let overlayStatus = null;
let overlayStatusPromise = null;
let overlayBusy = false;
let overlayFeedback = null;
let setupRailCollapsed = false;
let transcriptViewCleared = false;
let transcriptSessionId = null;
let debriefContextAvailable = false;
let debriefGenerationPromise = null;
let debriefFeedback = null;
let debriefSourceHighlightTimer = null;
let localDeleteRequest = null;

const capture = new CaptureController({
  bridge,
  onSourceState: setSourceState,
  onActivityChange: () => renderSession(),
  onInterruption: (track, error) => void interruptSession(track, error)
});

elements.action.addEventListener("click", () => {
  if (state.phase === "recording") void stopSession();
  else if (!state.active && !isEngineSetupReady()) openSettings();
  else if (!state.active) openSessionConsent();
});
elements.copy.addEventListener("click", () => void copyTranscript());
elements.save.addEventListener("click", () => void saveTranscriptCopy());
elements.clearTranscriptView.addEventListener("click", () => void toggleTranscriptView());
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
elements.meetingProfile.addEventListener("change", handleMeetingProfileChange);
elements.manageContextPacks.addEventListener("click", openContextPacksDialog);
elements.contextPacksCloseTop.addEventListener("click", closeContextPacksDialog);
elements.contextPacksClose.addEventListener("click", closeContextPacksDialog);
elements.newContextPack.addEventListener("click", () => beginContextPackEdit());
elements.contextPackCancelEdit.addEventListener("click", cancelContextPackEdit);
elements.contextPackForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveContextPack();
});
elements.importProviderCredential.addEventListener("click", () => void importProviderCredential());
elements.revokeProviderCredential.addEventListener("click", () => void revokeProviderCredential());
elements.assistExpand.addEventListener("click", () => void revealAssist({ focusQuestion: true }));
elements.assistDismissCollapsed.addEventListener("click", dismissAssistForMeeting);
elements.assistDismiss.addEventListener("click", dismissAssistForMeeting);
elements.assistReviewContext.addEventListener("click", () => void openAssistContextReview());
elements.assistOpenSettings.addEventListener("click", () => openSettings());
elements.assistQuestion.addEventListener("input", handleAssistQuestionInput);
elements.assistConsent.addEventListener("change", () => void handleAssistConsentChange());
elements.assistSend.addEventListener("click", () => void sendAssistRequest());
elements.assistCancel.addEventListener("click", () => void cancelAssistRequest());
elements.assistUseLatestContext.addEventListener("click", () => void useLatestAssistContext());
elements.assistKeepAnswer.addEventListener("click", keepAssistAnswer);
elements.assistCopySuggestion.addEventListener("click", () => void copyAssistSuggestion());
elements.assistResetRequest.addEventListener("click", resetAssistRequest);
elements.assistClearResponse.addEventListener("click", () => void clearAssistResponse());
elements.assistContextCloseTop.addEventListener("click", closeAssistContextReview);
elements.assistContextBack.addEventListener("click", closeAssistContextReview);
elements.assistContextUse.addEventListener("click", useReviewedAssistContext);
for (const tab of elements.workspaceTabs) {
  tab.addEventListener("click", () => setWorkspaceTab(tab.id.endsWith("debrief") ? "debrief" : "copilot"));
  tab.addEventListener("keydown", handleWorkspaceTabKeydown);
}
elements.debriefGenerate.addEventListener("click", () => void generateLocalDebrief());
elements.debriefCopy.addEventListener("click", () => void copyDebriefMarkdown());
elements.debriefSave.addEventListener("click", () => void saveDebriefMarkdown());
elements.debriefClear.addEventListener("click", () => void clearDebrief());
elements.debriefDeleteSourceData.addEventListener("click", () => void deleteDebriefSourceData());
elements.localDeleteCancel.addEventListener("click", () => resolveLocalDeleteRequest(false));
elements.localDeleteConfirm.addEventListener("click", () => resolveLocalDeleteRequest(true));
elements.settingsButton.addEventListener("click", () => openSettings());
elements.overlayToggle.addEventListener("click", () => void toggleOverlayVisibility());
elements.setupRailToggle.addEventListener("click", toggleSetupRail);
elements.settingsCloseTop.addEventListener("click", closeSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.overlayAccessible.addEventListener("change", () => void updateOverlaySettingsFromForm());
elements.overlayPrivate.addEventListener("change", () => void updateOverlaySettingsFromForm());
elements.overlayOpacity.addEventListener("change", () => void updateOverlaySettingsFromForm());
elements.overlayAcknowledged.addEventListener("change", renderOverlaySettings);
elements.showOverlay.addEventListener("click", () => void runOverlayAction("showOverlay"));
elements.resetOverlay.addEventListener("click", () => void runOverlayAction("resetOverlay"));
elements.retryOverlayShortcuts.addEventListener("click", () => void runOverlayAction("retryOverlayShortcuts"));
elements.resetOverlayShortcuts.addEventListener("click", () => void runOverlayAction("resetOverlayShortcuts"));
elements.sessionConsentCloseTop.addEventListener("click", closeSessionConsent);
elements.sessionConsentCancel.addEventListener("click", closeSessionConsent);
elements.sessionConsentConfirm.addEventListener("click", confirmSessionConsent);
elements.chooseFolder.addEventListener("click", () => void chooseTranscriptFolder());
elements.clearFolder.addEventListener("click", () => void clearTranscriptFolder());
elements.openPythonDownload.addEventListener("click", () => void openPythonDownloadPage());
elements.copySetupCommand.addEventListener("click", () => void copySetupCommand());
elements.checkEngineSetup.addEventListener("click", () => void checkEngineSetup());
elements.settingsDialog.addEventListener("close", () => elements.settingsButton.focus());
elements.sessionConsentDialog.addEventListener("close", () => {
  const returnTarget = sessionConsentReturnTarget;
  sessionConsentReturnTarget = null;
  if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
});
elements.contextPacksDialog.addEventListener("close", () => elements.manageContextPacks.focus());
elements.localDeleteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveLocalDeleteRequest(false);
});
elements.localDeleteDialog.addEventListener("close", () => {
  if (localDeleteRequest) resolveLocalDeleteRequest(false, { close: false });
});
elements.assistContextDialog.addEventListener("close", () => {
  if (assistExpanded && !elements.assistReviewContext.disabled) elements.assistReviewContext.focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && event.target === elements.assistQuestion) {
    event.preventDefault();
    if (canSendAssistRequest()) void sendAssistRequest();
    return;
  }
  if (event.ctrlKey
    && event.key === "Enter"
    && !isEditableShortcutTarget(event.target)
    && !event.target?.closest?.("dialog")
    && !elements.action.disabled) {
    event.preventDefault();
    elements.action.click();
  }
});

bridge.onBackendEvent(handleBackendEvent);
bridge.onTrayAction((action) => void handleTrayAction(action));
bridge.onAssistEvent(handleAssistEvent);
bridge.onAssistShortcut(() => void revealAssist({ focusQuestion: true }));
if (typeof bridge?.onAssistPrefill === "function") {
  bridge.onAssistPrefill((value) => prefillCopilotQuestion(value));
}
if (typeof bridge?.onOverlayStatus === "function") {
  bridge.onOverlayStatus((value) => {
    overlayStatus = sanitizeOverlayStatus(value);
    renderOverlaySettings();
  });
}
bridge.onBeforeClose(() => {
  void stopForClose().finally(() => bridge.notifyCloseReady());
});

renderSession();
renderTranscript();
renderAssist();
renderDebrief();
void initialize();

async function initialize() {
  const [platformResult, settingsResult, setupResult, libraryResult] = await Promise.allSettled([
    bridge.getPlatform(),
    bridge.getSettings(),
    bridge.getEnginePrerequisites(),
    bridge.getAssistLibrary()
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
  if (libraryResult.status === "fulfilled" && libraryResult.value?.ok) {
    applyAssistLibrary(libraryResult.value.library);
  } else {
    applyAssistLibrary(null);
  }
  settingsReady = true;
  renderSession();
  if (hasOverlayBridge()) void refreshOverlayStatus();
  void refreshAssistStatus();
}

function createEmptyAssistLibrary() {
  return Object.freeze({
    profiles: Object.freeze({ schemaVersion: 1, defaultProfileId: "general", profiles: Object.freeze([]) }),
    secureStorageAvailable: false,
    contextPacksAvailable: false,
    contextPacks: Object.freeze([])
  });
}

function createDefaultAssistSelection() {
  return Object.freeze({
    profile: Object.freeze({ profileId: "general", profileVersion: 1 }),
    contextPacks: Object.freeze([])
  });
}

function applyAssistLibrary(value) {
  let nextLibrary;
  try {
    nextLibrary = sanitizeAssistLibrary(value);
  } catch {
    nextLibrary = createEmptyAssistLibrary();
  }
  assistLibrary = nextLibrary;
  assistSelection = reconcileAssistSelection(assistSelection, nextLibrary);
  renderMeetingContextSetup();
  if (elements.contextPacksDialog.open) renderContextPacksDialog();
}

function sanitizeAssistLibrary(value) {
  if (!isPlainRendererRecord(value)
    || typeof value.secureStorageAvailable !== "boolean"
    || typeof value.contextPacksAvailable !== "boolean"
    || !Array.isArray(value.contextPacks)
    || value.contextPacks.length > 24) {
    throw new Error("Meeting assistance library is invalid.");
  }
  const profiles = sanitizeMeetingProfileCatalog(value.profiles);
  const contextPacks = value.contextPacks.map(sanitizeContextPack);
  const ids = new Set();
  for (const pack of contextPacks) {
    if (ids.has(pack.id)) throw new Error("Meeting assistance library is invalid.");
    ids.add(pack.id);
  }
  if ((!value.secureStorageAvailable || !value.contextPacksAvailable) && contextPacks.length > 0) {
    throw new Error("Meeting assistance library is invalid.");
  }
  return Object.freeze({
    profiles,
    secureStorageAvailable: value.secureStorageAvailable,
    contextPacksAvailable: value.contextPacksAvailable,
    contextPacks: Object.freeze(contextPacks)
  });
}

function sanitizeMeetingProfileCatalog(value) {
  if (!isPlainRendererRecord(value)
    || value.schemaVersion !== 1
    || typeof value.defaultProfileId !== "string"
    || !Array.isArray(value.profiles)
    || value.profiles.length === 0
    || value.profiles.length > 24) {
    throw new Error("Meeting profiles are invalid.");
  }
  const profiles = value.profiles.map(sanitizeMeetingProfile);
  const ids = new Set(profiles.map(({ id }) => id));
  if (ids.size !== profiles.length || !ids.has(value.defaultProfileId)) {
    throw new Error("Meeting profiles are invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    defaultProfileId: value.defaultProfileId,
    profiles: Object.freeze(profiles)
  });
}

function sanitizeMeetingProfile(value) {
  if (!isPlainRendererRecord(value)
    || !isSafeRendererIdentifier(value.id)
    || !Number.isSafeInteger(value.version)
    || value.version <= 0
    || !Array.isArray(value.allowedContextKinds)
    || value.allowedContextKinds.length === 0
    || !Array.isArray(value.quickActions)
    || value.quickActions.length > 8
    || !Array.isArray(value.limitations)
    || value.limitations.length === 0
    || value.limitations.length > 8) {
    throw new Error("Meeting profile is invalid.");
  }
  const allowedContextKinds = value.allowedContextKinds.map((kind) => {
    if (!CONTEXT_PACK_KINDS.has(kind)) throw new Error("Meeting profile is invalid.");
    return kind;
  });
  if (new Set(allowedContextKinds).size !== allowedContextKinds.length) {
    throw new Error("Meeting profile is invalid.");
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    name: requireRendererText(value.name, 120),
    description: requireRendererText(value.description, 500),
    responseStyle: requireRendererText(value.responseStyle, 1_000),
    allowedContextKinds: Object.freeze(allowedContextKinds),
    quickActions: Object.freeze(value.quickActions.map((action) => {
      if (!isPlainRendererRecord(action) || !isSafeRendererIdentifier(action.id)) {
        throw new Error("Meeting profile quick action is invalid.");
      }
      return Object.freeze({
        id: action.id,
        label: requireRendererText(action.label, 80),
        prompt: requireRendererText(action.prompt, ASSIST_QUESTION_MAX_CHARS)
      });
    })),
    limitations: Object.freeze(value.limitations.map((item) => requireRendererText(item, 500)))
  });
}

function sanitizeContextPack(value) {
  if (!isPlainRendererRecord(value)
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
    || !Number.isSafeInteger(value.revision)
    || value.revision <= 0
    || !CONTEXT_PACK_KINDS.has(value.kind)) {
    throw new Error("Meeting context pack is invalid.");
  }
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    kind: value.kind,
    name: requireRendererText(value.name, 120),
    content: requireRendererText(value.content, 32_000)
  });
}

function requireRendererText(value, maxLength) {
  if (typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("Meeting assistance text is invalid.");
  }
  return value;
}

function isPlainRendererRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSafeRendererIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z][a-z0-9_]*$/u.test(value);
}

function reconcileAssistSelection(previous, library) {
  const catalog = library.profiles;
  const requestedProfile = previous?.profile;
  const profile = catalog.profiles.find((candidate) => (
    candidate.id === requestedProfile?.profileId
      && candidate.version === requestedProfile?.profileVersion
  )) ?? catalog.profiles.find(({ id }) => id === catalog.defaultProfileId) ?? null;
  if (!profile) return createDefaultAssistSelection();

  const allowedKinds = new Set(profile.allowedContextKinds);
  const requestedPackIds = new Set((previous?.contextPacks ?? []).map(({ id }) => id));
  const contextPacks = library.contextPacks
    .filter((pack) => requestedPackIds.has(pack.id) && allowedKinds.has(pack.kind))
    .slice(0, CONTEXT_PACK_MAX_SELECTED)
    .map((pack) => Object.freeze({ id: pack.id, revision: pack.revision }));
  return Object.freeze({
    profile: Object.freeze({ profileId: profile.id, profileVersion: profile.version }),
    contextPacks: Object.freeze(contextPacks)
  });
}

function getMeetingProfile(selection = state.active ? activeAssistSelection : assistSelection) {
  const reference = selection?.profile;
  return assistLibrary.profiles.profiles.find((profile) => (
    profile.id === reference?.profileId && profile.version === reference?.profileVersion
  )) ?? null;
}

function buildAssistSelectionForStart() {
  const profile = getMeetingProfile(assistSelection);
  if (!profile) throw new Error("Meeting profiles are unavailable. Restart the app and try again.");
  const allowedKinds = new Set(profile.allowedContextKinds);
  const byId = new Map(assistLibrary.contextPacks.map((pack) => [pack.id, pack]));
  const contextPacks = assistSelection.contextPacks.map((reference) => {
    const pack = byId.get(reference.id);
    if (!pack || pack.revision !== reference.revision || !allowedKinds.has(pack.kind)) {
      throw new Error("Selected private context changed. Review it before starting the meeting.");
    }
    return Object.freeze({ id: pack.id, revision: pack.revision });
  });
  return Object.freeze({
    profile: Object.freeze({ profileId: profile.id, profileVersion: profile.version }),
    contextPacks: Object.freeze(contextPacks)
  });
}

function handleMeetingProfileChange() {
  if (state.active) return;
  const profile = assistLibrary.profiles.profiles.find(({ id }) => id === elements.meetingProfile.value);
  if (!profile) return;
  assistSelection = reconcileAssistSelection({
    profile: { profileId: profile.id, profileVersion: profile.version },
    contextPacks: assistSelection.contextPacks
  }, assistLibrary);
  renderMeetingContextSetup();
  if (elements.contextPacksDialog.open) renderContextPacksDialog();
  renderAssist();
}

function renderMeetingContextSetup() {
  const profile = getMeetingProfile();
  const locked = state.active;
  const profiles = assistLibrary.profiles.profiles;
  const expectedValues = profiles.map(({ id }) => id).join("\u0000");
  const currentValues = [...elements.meetingProfile.options].map(({ value }) => value).join("\u0000");
  if (expectedValues !== currentValues) {
    elements.meetingProfile.replaceChildren(...profiles.map((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.name;
      return option;
    }));
  }
  if (profile) elements.meetingProfile.value = profile.id;
  elements.meetingProfile.disabled = locked || profiles.length === 0;
  elements.meetingProfileName.textContent = profile?.name ?? "Meeting profiles unavailable";
  elements.meetingProfileDescription.textContent = profile?.description
    ?? "Restart the app to reload the built-in meeting profiles.";
  elements.meetingProfileLimitations.textContent = profile?.limitations.join(" • ")
    ?? "No meeting profile is available.";

  const selection = locked ? activeAssistSelection : assistSelection;
  const selectedIds = new Set((selection?.contextPacks ?? []).map(({ id }) => id));
  const selected = assistLibrary.contextPacks.filter(({ id }) => selectedIds.has(id));
  elements.selectedContextPacks.textContent = selected.length === 0
    ? "No context packs selected for this meeting."
    : `${selected.length} selected · ${selected.map(({ name }) => name).join(", ")}`;
  elements.manageContextPacks.disabled = locked;
  elements.meetingContextLockNote.hidden = !locked;
}

function renderAssistQuickActions() {
  const profile = getMeetingProfile();
  const disabled = elements.assistQuestion.disabled || Boolean(assistOutput);
  elements.assistQuickActions.replaceChildren(...(profile?.quickActions ?? []).map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-action";
    button.textContent = action.label;
    button.disabled = disabled;
    button.title = "Prefill the question. This does not send anything.";
    button.addEventListener("click", () => {
      elements.assistQuestion.value = action.prompt;
      handleAssistQuestionInput();
      elements.assistQuestion.focus();
    });
    return button;
  }));
}

function openContextPacksDialog() {
  if (state.active || elements.contextPacksDialog.open) return;
  cancelContextPackEdit();
  renderContextPacksDialog();
  elements.contextPacksDialog.showModal();
}

function closeContextPacksDialog() {
  cancelContextPackEdit();
  if (elements.contextPacksDialog.open) elements.contextPacksDialog.close();
}

function renderContextPacksDialog() {
  const profile = getMeetingProfile(assistSelection);
  const allowedKinds = new Set(profile?.allowedContextKinds ?? []);
  const selectedIds = new Set(assistSelection.contextPacks.map(({ id }) => id));
  const locked = state.active || contextPackBusy;
  const secure = assistLibrary.secureStorageAvailable;
  const available = secure && assistLibrary.contextPacksAvailable;
  elements.contextPackStorageWarning.hidden = available;
  elements.contextPackStorageWarning.textContent = !secure
    ? "Secure operating-system storage is unavailable. Private context cannot be created or loaded on this device."
    : available
      ? ""
      : "Saved private context could not be loaded and was left untouched. Profiles and local transcription remain available, but pack changes are disabled.";
  elements.contextPackListEmpty.hidden = !available || assistLibrary.contextPacks.length > 0;
  elements.newContextPack.disabled = locked || !available;

  elements.contextPackList.replaceChildren(...assistLibrary.contextPacks.map((pack) => {
    const row = document.createElement("div");
    row.className = "context-pack-row";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(pack.id);
    const allowed = allowedKinds.has(pack.kind);
    checkbox.disabled = locked
      || !available
      || !allowed
      || (!checkbox.checked && selectedIds.size >= CONTEXT_PACK_MAX_SELECTED);
    checkbox.setAttribute("aria-label", `Use ${pack.name} for the next meeting`);
    checkbox.addEventListener("change", () => toggleContextPackSelection(pack, checkbox.checked));
    const copy = document.createElement("span");
    copy.className = "context-pack-row-copy";
    const name = document.createElement("strong");
    name.textContent = pack.name;
    const meta = document.createElement("span");
    meta.textContent = `${CONTEXT_KIND_LABELS[pack.kind]} · ${formatContextBytes(new TextEncoder().encode(pack.content).byteLength)}${allowed ? "" : ` · Not used by ${profile?.name ?? "this profile"}`}`;
    copy.append(name, meta);
    label.append(checkbox, copy);

    const actions = document.createElement("div");
    actions.className = "context-pack-row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "assist-text-action";
    edit.textContent = "Edit";
    edit.disabled = locked || !available;
    edit.addEventListener("click", () => beginContextPackEdit(pack));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "assist-text-action";
    remove.textContent = "Delete";
    remove.disabled = locked || !available;
    remove.addEventListener("click", () => void deleteContextPack(pack));
    actions.append(edit, remove);
    row.append(label, actions);
    return row;
  }));
}

function toggleContextPackSelection(pack, selected) {
  if (state.active || contextPackBusy) return;
  const profile = getMeetingProfile(assistSelection);
  if (!profile?.allowedContextKinds.includes(pack.kind)) return;
  const current = assistSelection.contextPacks.filter(({ id }) => id !== pack.id);
  if (selected) {
    if (current.length >= CONTEXT_PACK_MAX_SELECTED) {
      setContextPackFeedback("Select no more than twelve private context packs.", "error");
      renderContextPacksDialog();
      return;
    }
    current.push(Object.freeze({ id: pack.id, revision: pack.revision }));
  }
  assistSelection = Object.freeze({
    profile: assistSelection.profile,
    contextPacks: Object.freeze(current)
  });
  clearContextPackFeedback();
  renderMeetingContextSetup();
  renderContextPacksDialog();
}

function beginContextPackEdit(pack = null) {
  if (state.active
    || contextPackBusy
    || !assistLibrary.secureStorageAvailable
    || !assistLibrary.contextPacksAvailable) return;
  elements.contextPackId.value = pack?.id ?? "";
  elements.contextPackRevision.value = pack ? String(pack.revision) : "";
  elements.contextPackKind.value = pack?.kind ?? "objective";
  elements.contextPackName.value = pack?.name ?? "";
  elements.contextPackContent.value = pack?.content ?? "";
  elements.contextPackForm.hidden = false;
  elements.contextPackSave.textContent = pack ? "Save changes" : "Save pack";
  clearContextPackFeedback();
  requestAnimationFrame(() => elements.contextPackName.focus());
}

function cancelContextPackEdit() {
  elements.contextPackForm.hidden = true;
  elements.contextPackForm.reset();
  elements.contextPackId.value = "";
  elements.contextPackRevision.value = "";
  elements.contextPackSave.textContent = "Save pack";
  clearContextPackFeedback();
}

async function saveContextPack() {
  if (state.active
    || contextPackBusy
    || !assistLibrary.secureStorageAvailable
    || !assistLibrary.contextPacksAvailable) return;
  const kind = elements.contextPackKind.value;
  const name = elements.contextPackName.value.trim();
  const content = elements.contextPackContent.value;
  if (!CONTEXT_PACK_KINDS.has(kind) || !name || content.trim().length === 0) {
    setContextPackFeedback("Choose a category and enter both a name and local context.", "error");
    return;
  }
  const id = elements.contextPackId.value;
  const revision = Number(elements.contextPackRevision.value);
  contextPackBusy = true;
  renderContextPacksDialog();
  elements.contextPackSave.disabled = true;
  try {
    const result = id
      ? await bridge.updateContextPack({ id, revision, kind, name, content })
      : await bridge.createContextPack({ kind, name, content });
    if (!result?.ok) throw new Error(result?.error || "Meeting context could not be saved.");
    applyAssistLibrary(result.library);
    cancelContextPackEdit();
  } catch (error) {
    setContextPackFeedback(error?.message || "Meeting context could not be saved.", "error");
  } finally {
    contextPackBusy = false;
    elements.contextPackSave.disabled = false;
    renderContextPacksDialog();
  }
}

async function deleteContextPack(pack) {
  if (state.active
    || contextPackBusy
    || !assistLibrary.secureStorageAvailable
    || !assistLibrary.contextPacksAvailable) return;
  if (!window.confirm(`Delete “${pack.name}” from this device? This cannot be undone.`)) return;
  contextPackBusy = true;
  renderContextPacksDialog();
  try {
    const result = await bridge.deleteContextPack({ id: pack.id, revision: pack.revision });
    if (!result?.ok) throw new Error(result?.error || "Meeting context could not be deleted.");
    applyAssistLibrary(result.library);
    if (elements.contextPackId.value === pack.id) cancelContextPackEdit();
  } catch (error) {
    setContextPackFeedback(error?.message || "Meeting context could not be deleted.", "error");
  } finally {
    contextPackBusy = false;
    renderContextPacksDialog();
  }
}

function setContextPackFeedback(message, tone = "status") {
  elements.contextPackFeedback.textContent = message;
  elements.contextPackFeedback.dataset.tone = tone;
  elements.contextPackFeedback.setAttribute("role", tone === "error" ? "alert" : "status");
  elements.contextPackFeedback.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
}

function clearContextPackFeedback() {
  setContextPackFeedback("", "status");
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

function openSessionConsent() {
  if (state.active || startPromise || elements.sessionConsentDialog.open) return;
  sessionConsentReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : elements.action;
  elements.sessionConsentDialog.showModal();
  queueMicrotask(() => elements.sessionConsentConfirm.focus());
}

function closeSessionConsent() {
  if (elements.sessionConsentDialog.open) elements.sessionConsentDialog.close();
}

function confirmSessionConsent() {
  closeSessionConsent();
  void beginStartSession();
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
  const previousTranscriptViewCleared = transcriptViewCleared;
  const previousTranscriptSessionId = transcriptSessionId;
  const previousTranslationRuntimeState = translationRuntimeState;
  let transcriptReplaced = false;
  let assistSessionId = null;
  let requestedAssistSelection = null;
  hideAlert();
  hideTranslationWarning();
  setTranslationRuntimeState(settings.translation === "en_to_pt_br" ? "on" : "off");
  frozenElapsedMs = 0;

  try {
    requestedAssistSelection = buildAssistSelectionForStart();
    activeAssistSelection = requestedAssistSelection;
    renderSession();
    updateSelectedSourceStates(selection, "idle", "Waiting for the local model");
    await speakerRefreshPromise;
    await autoSaveRefreshQueue.whenIdle();
    assertCurrentStart(generation);
    const startResult = await bridge.start({
      model: settings.model,
      language: settings.language,
      diarization: settings.diarization,
      translation: settings.translation
    }, requestedAssistSelection);
    assertCurrentStart(generation);
    if (!startResult?.ok) throw new MeetingUiError("model_unavailable", startResult?.error);
    backendSessionStarted = true;
    autoSaveCreated = false;
    assistSessionId = startResult.engine?.session_id;
    eventGate.activate(assistSessionId);
    beginAssistMeeting(assistSessionId);
    debrief.clear();
    debriefContextAvailable = false;
    debriefFeedback = null;
    transcriptSessionId = typeof assistSessionId === "string" ? assistSessionId : null;
    transcript.reset();
    // Main has accepted a new backend-owned meeting and replaced its retained
    // debrief context. Do not show the previous meeting's draft beside the new
    // transcript, even if native capture later fails and the transcript view
    // itself is restored for recovery.
    debrief.clear();
    debriefFeedback = null;
    transcriptViewCleared = false;
    announcedFinalIds.clear();
    transcriptReplaced = true;
    renderTranscript();
    renderDebrief();
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
    if (assistSessionId) endAssistMeeting(assistSessionId);
    activeAssistSelection = null;
    if (transcriptReplaced) {
      transcript.restore(previousTranscript);
      transcriptViewCleared = previousTranscriptViewCleared;
      transcriptSessionId = previousTranscriptSessionId;
      announcedFinalIds.clear();
      renderTranscript();
      renderDebrief();
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
  const shouldGenerateDebrief = backendSessionStarted;

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
  } else if (shouldGenerateDebrief) {
    // An ambiguous or incomplete backend stop can still have queued finalized
    // segments. Let those renderer events reconcile before asking main for the
    // bounded local draft.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (shouldGenerateDebrief) debriefContextAvailable = true;
  if (stoppedSuccessfully && !pendingStopFailure && !stopError && transcript.hasFinalized()) {
    autoSaveResult = await saveFinalTranscriptAutomatically().catch(() => ({
      ok: false,
      error: "The transcript could not be saved automatically. It is still open here—choose another folder or save a copy."
    }));
  }
  eventGate.clear();
  if (assistEventGate.sessionId) endAssistMeeting(assistEventGate.sessionId);
  activeAssistSelection = null;

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
  renderDebrief();
  void refreshAssistStatus();
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
      if (event.type === "final_segment") scheduleAssistStatusRefresh();
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
  elements.ribbonStatus.textContent = presentation.text;
  elements.ribbonStatusDot.className = `status-dot ${presentation.dot}`;
  const selectedModel = modelById.get(settings.model);
  const sourceCount = Number(elements.sourceSystem.checked) + Number(elements.sourceMicrophone.checked);
  const sourceLabel = sourceCount === 2 ? "Meeting audio + microphone" : sourceCount === 1
    ? (elements.sourceSystem.checked ? "Meeting audio" : "Microphone")
    : "No source selected";
  elements.ribbonSummary.textContent = `${sourceLabel} · ${selectedModel?.label ?? "Local model"}`;
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
  renderMeetingContextSetup();
  renderAssist();
}

function renderSettingsAvailability() {
  const locked = state.active || settingsBusy;
  const selectedModel = modelById.get(settings.model);
  const englishOnly = selectedModel?.languageMode === "english_only";
  const translationAvailable = modelCatalog?.translation.available === true;
  elements.model.disabled = locked || !settingsReady || !modelCatalog;
  elements.language.disabled = locked || englishOnly || !settingsReady || !modelCatalog;
  elements.languageHelp.hidden = !englishOnly;
  elements.settingsButton.disabled = !settingsReady;
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
  renderOverlaySettings();
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

  elements.emptyTranscript.hidden = segments.length > 0 || transcriptViewCleared;
  elements.clearedTranscript.hidden = !transcriptViewCleared;
  elements.transcriptContent.hidden = segments.length === 0 || transcriptViewCleared;
  const hasFinalized = transcript.hasFinalized();
  elements.copy.disabled = !hasFinalized;
  elements.save.disabled = !hasFinalized;
  elements.clearTranscriptView.disabled = segments.length === 0;
  elements.clearTranscriptView.textContent = transcriptViewCleared
    ? "Restore transcript view"
    : "Clear transcript view…";
  elements.clearTranscriptView.setAttribute("aria-pressed", String(transcriptViewCleared));
  if (nearBottom) elements.transcriptScroll.scrollTop = elements.transcriptScroll.scrollHeight;
}

function createSegmentNode(id) {
  const article = document.createElement("article");
  article.className = "transcript-segment";
  article.dataset.segmentId = id;
  article.tabIndex = -1;
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
  if (renamed) {
    renderDebrief();
  }
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
  renderDebrief();
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

async function toggleTranscriptView() {
  if (transcriptViewCleared) {
    transcriptViewCleared = false;
    renderTranscript();
    showAlert("Transcript view restored.", "success");
    return;
  }

  const confirmed = await confirmLocalDeletion({
    title: "Clear transcript view?",
    message: "This hides transcript text in this window without deleting the underlying local text used by debrief sources. The debrief, Copilot response, private context packs, and any saved Markdown files remain unchanged.",
    confirmLabel: "Clear view"
  });
  if (!confirmed) return;
  transcriptViewCleared = true;
  renderTranscript();
  showAlert("Transcript text is hidden from this view. Use Restore transcript view to show it again.", "success");
}

async function generateLocalDebrief() {
  if (debriefGenerationPromise || !debriefContextAvailable || state.active) {
    return debriefGenerationPromise;
  }
  const currentDocument = debrief.snapshot();
  if (shouldConfirmDebriefRegeneration(currentDocument)) {
    const confirmed = await confirmLocalDeletion({
      title: "Replace this debrief?",
      message: "Generating again replaces the current local debrief, including edits and removed items. The transcript, retained local source data, Copilot response, private context packs, and any Markdown files you already saved remain unchanged.",
      confirmLabel: "Replace and generate"
    });
    if (!confirmed) return null;
    if (debriefGenerationPromise || !debriefContextAvailable || state.active) {
      return debriefGenerationPromise;
    }
  }
  const sourceIndex = createTranscriptSourceIndex();
  debriefFeedback = null;
  debrief.beginGeneration("Creating a local debrief from finalized original transcript text.");
  renderDebrief();

  const operation = (async () => {
    try {
      if (typeof bridge?.generateLocalDebrief !== "function") {
        throw new Error("Local debrief generation is unavailable in this build.");
      }
      const result = await bridge.generateLocalDebrief();
      if (!result?.ok || !result.debrief) {
        throw new Error(result?.error || "The local meeting debrief could not be generated.");
      }
      assertOriginalOnlyLocalDebrief(result.debrief, sourceIndex);
      debrief.loadDraft(result.debrief, {
        sourceValidator: (segmentId) => presentDebriefSource(sourceIndex.get(String(segmentId)))
      });
      debriefFeedback = null;
    } catch (error) {
      const message = error?.message || "The local meeting debrief could not be generated.";
      debrief.markFailed(message);
      debriefFeedback = { text: message, tone: "error" };
    }
  })();

  debriefGenerationPromise = operation.finally(() => {
    debriefGenerationPromise = null;
    renderDebrief();
  });
  return debriefGenerationPromise;
}

function shouldConfirmDebriefRegeneration(document) {
  return document.sessionId !== null
    || DEBRIEF_SECTION_IDS.some((sectionId) => document.sections[sectionId].items.length > 0);
}

function createTranscriptSourceIndex() {
  return new Map(transcript.getFinalized().map((segment) => [String(segment.id), {
    id: String(segment.id),
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    label: transcript.getSpeakerLabel(segment),
    originalText: segment.text
  }]));
}

function presentDebriefSource(source) {
  return source
    ? {
        id: source.id,
        start_ms: source.start_ms,
        end_ms: source.end_ms,
        label: source.label
      }
    : null;
}

function resolveTranscriptDebriefSource(segmentId) {
  const debriefSessionId = debrief.snapshot().sessionId;
  if (debriefSessionId !== null && debriefSessionId !== transcriptSessionId) return null;
  const segment = transcript.getFinalized().find(({ id }) => String(id) === String(segmentId));
  return segment
    ? {
        id: String(segment.id),
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        label: transcript.getSpeakerLabel(segment)
      }
    : null;
}

function resolveDebriefSource(segmentId) {
  return resolveTranscriptDebriefSource(segmentId);
}

function assertOriginalOnlyLocalDebrief(value, sourceIndex) {
  if (!value || typeof value !== "object" || !value.sections || typeof value.sections !== "object") {
    throw new TypeError("The local debrief response is invalid.");
  }
  if (typeof value.sessionId !== "string" || value.sessionId !== transcriptSessionId) {
    throw new TypeError("The local debrief does not match the current transcript session.");
  }
  for (const sectionId of DEBRIEF_SECTION_IDS) {
    const items = value.sections[sectionId]?.items;
    if (!Array.isArray(items)) throw new TypeError(`The local debrief section is invalid: ${sectionId}`);
    for (const item of items) {
      if (!item || typeof item.text !== "string" || !["local_extractive", "local_observation"].includes(item.provenance)) {
        throw new TypeError("The debrief response was not produced by the local extractor.");
      }
      if (item.provenance !== "local_extractive") continue;
      const linkedToOriginal = Array.isArray(item.sources) && item.sources.some((source) => {
        const segment = sourceIndex.get(String(source?.segment_id));
        return segment && isDebriefExtractDerivedFromOriginal(item.text, segment.originalText);
      });
      if (!linkedToOriginal) {
        throw new TypeError("A local debrief claim could not be verified against original transcript text.");
      }
    }
  }
}

function renderDebrief() {
  const document = debrief.snapshot();
  const presentation = DEBRIEF_STATE_PRESENTATION[document.state] ?? DEBRIEF_STATE_PRESENTATION.failed;
  const generating = document.state === "generating";
  const hasDebriefContent = debrief.hasItems();
  const hasGeneratedDocument = document.sessionId !== null;
  const readyForFirstGeneration = document.state === "empty"
    && debriefContextAvailable
    && !hasGeneratedDocument;
  const canGenerate = debriefContextAvailable && document.state !== "generating" && !state.active;

  elements.debriefStateBadge.textContent = presentation.label;
  elements.debriefStateBadge.dataset.state = presentation.tone;
  elements.debriefStatusMessage.textContent = debriefFeedback?.text
    ?? (readyForFirstGeneration
      ? "Finalized local source data is available. Choose Generate local debrief when you are ready."
      : null)
    ?? (document.state === "empty"
      ? hasGeneratedDocument
        ? document.message
        : "Debrief is available after transcription stops."
      : document.message ?? presentation.label);
  elements.debriefStatus.dataset.tone = debriefFeedback?.tone ?? presentation.tone;
  elements.debriefStatus.setAttribute("role", debriefFeedback?.tone === "error" ? "alert" : "status");
  elements.debriefStatus.setAttribute("aria-live", debriefFeedback?.tone === "error" ? "assertive" : "polite");
  elements.debriefSections.setAttribute("aria-busy", String(document.state === "generating"));
  elements.debriefGenerate.disabled = !canGenerate;
  elements.debriefCopy.disabled = generating || !hasDebriefContent;
  elements.debriefSave.disabled = generating || !hasDebriefContent;
  elements.debriefClear.disabled = ["empty", "generating"].includes(document.state)
    || backendSessionStarted;
  elements.debriefClear.title = backendSessionStarted
    ? "Stop the meeting before clearing its local debrief buffer."
    : "Clear only the visible local debrief draft.";
  elements.debriefDeleteSourceData.disabled = !debriefContextAvailable
    || document.state === "generating"
    || backendSessionStarted;
  elements.debriefDeleteSourceData.title = backendSessionStarted
    ? "Stop the meeting before deleting retained local debrief source data."
    : "Delete the retained local source data used to generate this meeting debrief.";

  const hasAvailability = debriefContextAvailable
    || ["ready", "partial", "manual", "failed"].includes(document.state);
  elements.debriefTabIndicator.hidden = !hasAvailability || activeWorkspaceTab === "debrief";
  const availabilityLabel = readyForFirstGeneration
    ? "Available"
    : presentation.label;
  elements.debriefTabIndicator.textContent = availabilityLabel;
  elements.debriefTabIndicator.title = availabilityLabel;

  const sections = DEBRIEF_SECTION_IDS.map((sectionId) => (
    createDebriefSectionNode(sectionId, document.sections[sectionId], document.state === "generating")
  ));
  elements.debriefSections.replaceChildren(...sections);
}

function createDebriefSectionNode(sectionId, section, generating) {
  const presentation = DEBRIEF_SECTION_PRESENTATION[sectionId];
  const container = document.createElement("section");
  container.className = "debrief-section";
  container.dataset.section = sectionId;

  const header = document.createElement("header");
  header.className = "debrief-section-header";
  const title = document.createElement("h3");
  title.textContent = presentation.title;
  header.append(title);
  container.append(header);

  if (section.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "debrief-section-empty";
    empty.textContent = section.state === "not_requested"
      ? "Optional coaching was not requested for this meeting."
      : presentation.empty;
    container.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "debrief-item-list";
    for (const item of section.items) list.append(createDebriefItemNode(sectionId, item, generating));
    container.append(list);
  }

  if (section.truncated) {
    const truncated = document.createElement("p");
    truncated.className = "debrief-section-warning";
    truncated.textContent = "This local section reached its evidence limit. Review the transcript for omitted context.";
    container.append(truncated);
  }
  return container;
}

function createDebriefItemNode(sectionId, item, generating) {
  const card = document.createElement("article");
  card.className = "debrief-item";
  card.dataset.itemId = item.id;

  const meta = document.createElement("div");
  meta.className = "debrief-item-meta";
  const provenance = document.createElement("span");
  provenance.className = "debrief-provenance";
  provenance.textContent = formatDebriefProvenance(item);
  meta.append(provenance);

  const text = document.createElement("textarea");
  text.className = "debrief-item-text";
  text.rows = Math.min(6, Math.max(2, Math.ceil(item.text.length / 52)));
  text.maxLength = 4_000;
  text.value = item.text;
  text.disabled = generating;
  text.setAttribute("aria-label", `Edit ${DEBRIEF_SECTION_PRESENTATION[sectionId].title} item`);

  card.append(meta, text);
  if (sectionId === "actions") card.append(createDebriefActionFields(item, generating));

  const sources = document.createElement("div");
  sources.className = "debrief-sources";
  sources.setAttribute("aria-label", "Transcript sources");
  if (item.sources.length === 0) {
    const noSource = document.createElement("span");
    noSource.className = "debrief-no-source";
    noSource.textContent = "No transcript source · manual item";
    sources.append(noSource);
  } else {
    for (const source of item.sources) sources.append(createDebriefSourceChip(source));
  }
  card.append(sources);

  const actions = document.createElement("div");
  actions.className = "debrief-item-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "secondary-action";
  save.textContent = "Save edits";
  save.disabled = generating;
  save.addEventListener("click", () => saveDebriefItemEdits(sectionId, item.id, card));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "debrief-text-action danger-action";
  remove.textContent = "Remove";
  remove.disabled = generating;
  remove.addEventListener("click", () => void removeDebriefItem(sectionId, item.id));
  actions.append(save, remove);
  card.append(actions);
  return card;
}

function createDebriefActionFields(item, generating) {
  const fields = document.createElement("div");
  fields.className = "debrief-action-fields";
  fields.append(
    createDebriefActionField("owner", "Owner", item.owner, generating),
    createDebriefActionField("due", "Due", item.due, generating)
  );
  return fields;
}

function createDebriefActionField(fieldId, labelText, field, generating) {
  const label = document.createElement("label");
  label.className = "debrief-action-field";
  const title = document.createElement("span");
  title.textContent = labelText;
  const controls = document.createElement("span");
  controls.className = "debrief-action-field-controls";
  const certainty = document.createElement("select");
  certainty.className = `debrief-${fieldId}-state`;
  certainty.disabled = generating;
  certainty.setAttribute("aria-label", `${labelText} certainty: stated, proposed, or not stated`);
  for (const [value, text] of [["stated", "Stated"], ["proposed", "Proposed"], ["unknown", "Not stated"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = field.state === value;
    certainty.append(option);
  }
  const value = document.createElement("input");
  value.className = `debrief-${fieldId}-value`;
  value.type = "text";
  value.maxLength = 128;
  value.value = field.value ?? "";
  value.placeholder = fieldId === "owner" ? "Name" : "Date or timing";
  value.disabled = generating || field.state === "unknown";
  value.setAttribute("aria-label", `${labelText} value`);
  certainty.addEventListener("change", () => {
    value.disabled = certainty.value === "unknown";
    if (certainty.value === "unknown") value.value = "";
  });
  controls.append(certainty, value);
  label.append(title, controls);
  return label;
}

function createDebriefSourceChip(source) {
  const resolved = resolveDebriefSource(source.segment_id);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "debrief-source-chip";
  if (!resolved) {
    button.disabled = true;
    button.textContent = `${formatTimestamp(source.start_ms)} · Source unavailable`;
    button.setAttribute("aria-label", `Transcript source at ${formatTimestamp(source.start_ms)} is unavailable`);
    return button;
  }
  const time = resolved.end_ms > resolved.start_ms
    ? `${formatTimestamp(resolved.start_ms)}–${formatTimestamp(resolved.end_ms)}`
    : formatTimestamp(resolved.start_ms);
  button.textContent = `${time} · ${resolved.label}`;
  button.title = `Open ${resolved.label} in the transcript at ${time}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => focusDebriefSource(resolved.id));
  return button;
}

function formatDebriefProvenance(item) {
  const base = {
    local_extractive: "Local extract",
    local_observation: "Local observation",
    manual: "Edited by you",
    hosted_generated: "Hosted draft"
  }[item.provenance] ?? "Local draft";
  return item.edited && item.provenance !== "manual" ? `${base} · Edited` : base;
}

function saveDebriefItemEdits(sectionId, itemId, card) {
  const patch = { text: card.querySelector(".debrief-item-text").value };
  if (sectionId === "actions") {
    patch.owner = readDebriefActionField(card, "owner");
    patch.due = readDebriefActionField(card, "due");
  }
  try {
    debrief.updateItem(sectionId, itemId, patch, { sourceValidator: resolveDebriefSource });
    debriefFeedback = { text: "Local debrief edits saved.", tone: "success" };
  } catch (error) {
    debriefFeedback = { text: error?.message || "The debrief edit could not be saved.", tone: "error" };
  }
  renderDebrief();
}

function readDebriefActionField(card, fieldId) {
  const state = card.querySelector(`.debrief-${fieldId}-state`).value;
  const value = card.querySelector(`.debrief-${fieldId}-value`).value.trim();
  return { state, value: state === "unknown" ? null : value };
}

async function removeDebriefItem(sectionId, itemId) {
  const confirmed = await confirmLocalDeletion({
    title: "Remove debrief item?",
    message: "This removes only this item from the local debrief. The transcript, Copilot response, private context packs, and saved Markdown files remain unchanged.",
    confirmLabel: "Remove item"
  });
  if (!confirmed) return;
  debrief.removeItem(sectionId, itemId);
  debriefFeedback = { text: "Debrief item removed from this view.", tone: "success" };
  renderDebrief();
}

function focusDebriefSource(segmentId) {
  const node = segmentNodes.get(String(segmentId));
  if (!node) return;
  transcriptViewCleared = false;
  renderTranscript();
  requestAnimationFrame(() => {
    const sourceNode = segmentNodes.get(String(segmentId));
    if (!sourceNode) return;
    if (debriefSourceHighlightTimer) clearTimeout(debriefSourceHighlightTimer);
    for (const segmentNode of segmentNodes.values()) segmentNode.classList.remove("source-highlight");
    sourceNode.classList.add("source-highlight");
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    sourceNode.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    sourceNode.focus({ preventScroll: true });
    debriefSourceHighlightTimer = setTimeout(() => {
      sourceNode.classList.remove("source-highlight");
      debriefSourceHighlightTimer = null;
    }, 2_400);
  });
}

function buildDebriefMarkdown() {
  return debrief.toMarkdown({ sourceResolver: resolveDebriefSource });
}

async function copyDebriefMarkdown() {
  if (["empty", "generating"].includes(debrief.snapshot().state)) return;
  try {
    const result = await bridge.copyDebrief(buildDebriefMarkdown());
    if (!result?.ok) throw new Error(result?.error || "The meeting debrief could not be copied.");
    debriefFeedback = { text: "Debrief Markdown copied.", tone: "success" };
  } catch (error) {
    debriefFeedback = { text: error?.message || "The meeting debrief could not be copied.", tone: "error" };
  }
  renderDebrief();
}

async function saveDebriefMarkdown() {
  if (["empty", "generating"].includes(debrief.snapshot().state)) return;
  try {
    const result = await bridge.saveDebrief(buildDebriefMarkdown());
    if (!result?.ok) throw new Error(result?.error || "The meeting debrief could not be exported.");
    if (!result.canceled) {
      debriefFeedback = {
        text: result.fileName ? `Debrief exported as ${result.fileName}.` : "Debrief Markdown exported.",
        tone: "success"
      };
    }
  } catch (error) {
    debriefFeedback = { text: error?.message || "The meeting debrief could not be exported.", tone: "error" };
  }
  renderDebrief();
}

async function clearDebrief() {
  if (["empty", "generating"].includes(debrief.snapshot().state)) return;
  const confirmed = await confirmLocalDeletion({
    title: "Clear this debrief?",
    message: "This clears only the visible local debrief draft. Retained local source data stays available so you can generate it again. The transcript, Copilot response, private context packs, and any Markdown files you already saved remain unchanged.",
    confirmLabel: "Clear debrief"
  });
  if (!confirmed) return;
  debrief.clear();
  debriefFeedback = {
    text: debriefContextAvailable
      ? "Debrief draft cleared. Retained local source data is still available to generate again."
      : "Debrief draft cleared.",
    tone: "success"
  };
  renderDebrief();
}

async function deleteDebriefSourceData() {
  if (!debriefContextAvailable || debriefGenerationPromise || backendSessionStarted) return;
  const confirmed = await confirmLocalDeletion({
    title: "Delete debrief source data?",
    message: "This permanently deletes the retained local source data used to generate this meeting debrief and clears the visible draft. You will not be able to regenerate it for this meeting. The transcript, Copilot response, private context packs, and any Markdown files you already saved remain unchanged.",
    confirmLabel: "Delete source data"
  });
  if (!confirmed) return;
  try {
    const result = await bridge.clearLocalDebrief();
    if (!result?.ok) throw new Error(result?.error || "The retained local debrief source data could not be deleted.");
    debrief.clear();
    debriefContextAvailable = false;
    debriefFeedback = {
      text: "Retained local debrief source data deleted. Transcript, Copilot response, and saved Markdown files remain unchanged.",
      tone: "success"
    };
  } catch (error) {
    debriefFeedback = {
      text: error?.message || "The retained local debrief source data could not be deleted.",
      tone: "error"
    };
  }
  renderDebrief();
}

function confirmLocalDeletion({ title, message, confirmLabel }) {
  if (localDeleteRequest || elements.localDeleteDialog.open) return Promise.resolve(false);
  const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  elements.localDeleteTitle.textContent = title;
  elements.localDeleteMessage.textContent = message;
  elements.localDeleteConfirm.textContent = confirmLabel;
  elements.localDeleteDialog.showModal();
  queueMicrotask(() => elements.localDeleteCancel.focus());
  return new Promise((resolve) => {
    localDeleteRequest = { resolve, returnTarget };
  });
}

function resolveLocalDeleteRequest(confirmed, { close = true } = {}) {
  const request = localDeleteRequest;
  if (!request) return;
  localDeleteRequest = null;
  if (close && elements.localDeleteDialog.open) elements.localDeleteDialog.close();
  request.resolve(confirmed);
  queueMicrotask(() => {
    if (request.returnTarget && document.contains(request.returnTarget)) request.returnTarget.focus();
  });
}

function openSettings() {
  if (elements.settingsDialog.open) return;
  elements.settingsDialog.showModal();
  void refreshProviderStatus();
  queueMicrotask(() => {
    focusEngineSetupRemediation();
  });
}

function closeSettings() {
  elements.settingsDialog.close();
}

function hasOverlayBridge() {
  return typeof bridge?.getOverlayStatus === "function";
}

function sanitizeOverlayStatus(value) {
  const status = value?.status && typeof value.status === "object" ? value.status : value;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const raw = status.overlay && typeof status.overlay === "object" ? status.overlay : status;
  const settings = status.settings && typeof status.settings === "object" ? status.settings : raw.settings;
  const mode = settings?.mode === "private" || raw.mode === "private" ? "private" : "accessible";
  const opacityValue = settings?.opacity ?? raw.opacity;
  const opacity = Number.isFinite(opacityValue) ? Math.min(1, Math.max(0.6, opacityValue)) : 1;
  const shortcutValues = Array.isArray(status.shortcuts?.shortcuts)
    ? status.shortcuts.shortcuts
    : Array.isArray(status.shortcuts)
      ? status.shortcuts
      : Array.isArray(raw.shortcuts)
        ? raw.shortcuts
        : [];
  const shortcuts = shortcutValues
    .filter((shortcut) => shortcut && typeof shortcut === "object")
    .map((shortcut) => ({
      label: typeof shortcut.label === "string" ? shortcut.label : "Shortcut",
      accelerator: formatShortcutAccelerator(shortcut.accelerator),
      registered: shortcut.available === true || shortcut.registered === true || shortcut.state === "registered",
      message: typeof shortcut.message === "string" ? shortcut.message : ""
    }));
  const disclosureValue = status.disclosure && typeof status.disclosure === "object"
    ? status.disclosure
    : raw.disclosure;
  const disclosure = disclosureValue
    && typeof disclosureValue.version === "string"
    && typeof disclosureValue.body === "string"
    ? Object.freeze({
        version: disclosureValue.version,
        title: typeof disclosureValue.title === "string" ? disclosureValue.title : "Private overlay mode",
        body: disclosureValue.body,
        supported: disclosureValue.supported === true
      })
    : null;
  return Object.freeze({
    visible: raw.visible === true,
    mode,
    opacity,
    shortcuts: Object.freeze(shortcuts),
    disclosure
  });
}

function formatShortcutAccelerator(value) {
  if (typeof value !== "string" || value.length === 0) return "Not assigned";
  return value.replace("CommandOrControl", "Ctrl/Cmd");
}

function renderOverlaySettings() {
  const available = hasOverlayBridge();
  elements.overlaySettingsSection.hidden = !available;
  elements.overlayToggle.hidden = !available || (typeof bridge?.showOverlay !== "function" && typeof bridge?.hideOverlay !== "function");
  if (!available) return;
  const mode = overlayStatus?.mode ?? "accessible";
  const opacity = Math.round((overlayStatus?.opacity ?? 1) * 100);
  elements.overlayAccessible.checked = mode !== "private";
  elements.overlayPrivate.checked = mode === "private";
  elements.overlayOpacity.value = String(opacity);
  elements.overlayOpacityValue.textContent = `${opacity}%`;
  elements.overlayDisclosure.textContent = overlayStatus?.disclosure?.body
    ?? "Private mode is unavailable until the app can provide its current screen-capture disclosure.";
  elements.overlayOpacityRow.hidden = mode !== "private";
  elements.overlayToggle.textContent = overlayStatus?.visible ? "Hide overlay" : "Overlay";
  const statusMessage = overlayStatusPromise
    ? "Checking overlay and shortcut status…"
    : overlayStatus
      ? `${overlayStatus.visible ? "Overlay visible" : "Overlay hidden"} · ${mode === "private" ? "Private mode" : "Accessible mode"}`
      : "Overlay status is unavailable. The main meeting workspace remains available.";
  elements.overlayStatus.textContent = overlayFeedback?.message ?? statusMessage;
  elements.overlayStatus.dataset.tone = overlayFeedback?.tone ?? "status";
  elements.overlayStatus.setAttribute("role", overlayFeedback?.tone === "error" ? "alert" : "status");
  elements.overlayStatus.setAttribute("aria-live", overlayFeedback?.tone === "error" ? "assertive" : "polite");
  const shortcuts = overlayStatus?.shortcuts ?? [];
  elements.overlayShortcutList.replaceChildren(...shortcuts.map((shortcut) => {
    const item = document.createElement("div");
    item.className = "overlay-shortcut";
    const status = shortcut.registered ? "Available" : "Unavailable";
    item.textContent = `${shortcut.label}: ${shortcut.accelerator} · ${shortcut.message || status}`;
    return item;
  }));
  if (shortcuts.length === 0 && !overlayStatusPromise) {
    const item = document.createElement("div");
    item.className = "overlay-shortcut";
    item.textContent = "Shortcut status will appear when the overlay is available.";
    elements.overlayShortcutList.replaceChildren(item);
  }
  const privateUnacknowledged = mode === "private" && !elements.overlayAcknowledged.checked;
  const settingsMutable = typeof bridge?.updateOverlaySettings === "function";
  elements.overlayPrivate.disabled = overlayBusy || !settingsMutable;
  elements.overlayAccessible.disabled = overlayBusy || !settingsMutable;
  elements.overlayOpacity.disabled = overlayBusy || !settingsMutable || mode !== "private" || privateUnacknowledged;
  elements.showOverlay.disabled = overlayBusy || typeof bridge?.showOverlay !== "function";
  elements.resetOverlay.disabled = overlayBusy || typeof bridge?.resetOverlay !== "function";
  elements.retryOverlayShortcuts.disabled = overlayBusy || typeof bridge?.retryOverlayShortcuts !== "function";
  elements.resetOverlayShortcuts.disabled = overlayBusy || typeof bridge?.resetOverlayShortcuts !== "function";
}

function setOverlayFeedback(message, tone = "error") {
  overlayFeedback = { message, tone };
}

function clearOverlayFeedback() {
  overlayFeedback = null;
}

function refreshOverlayStatus() {
  if (!hasOverlayBridge() || overlayStatusPromise) return overlayStatusPromise ?? Promise.resolve();
  const operation = (async () => {
    try {
      const result = await bridge.getOverlayStatus();
      if (result?.ok === false) throw new Error(result.error || "Overlay status could not be loaded.");
      overlayStatus = sanitizeOverlayStatus(result);
    } catch {
      overlayStatus = null;
    }
  })();
  overlayStatusPromise = operation.finally(() => {
    overlayStatusPromise = null;
    renderOverlaySettings();
  });
  renderOverlaySettings();
  return overlayStatusPromise;
}

async function updateOverlaySettingsFromForm() {
  if (!hasOverlayBridge() || overlayBusy || typeof bridge?.updateOverlaySettings !== "function") return;
  const mode = elements.overlayPrivate.checked ? "private" : "accessible";
  if (mode === "private" && !elements.overlayAcknowledged.checked) {
    elements.overlayAccessible.checked = true;
    elements.overlayPrivate.checked = false;
    setOverlayFeedback("Acknowledge the private-mode disclosure before enabling it.");
    renderOverlaySettings();
    return;
  }
  const opacity = mode === "private" ? Number(elements.overlayOpacity.value) / 100 : 1;
  clearOverlayFeedback();
  overlayBusy = true;
  renderOverlaySettings();
  try {
    if (mode === "private") {
      if (typeof bridge?.acknowledgeOverlayPrivateMode !== "function"
        || typeof overlayStatus?.disclosure?.version !== "string") {
        throw new Error("The current private-mode disclosure is unavailable.");
      }
      const acknowledgement = await bridge.acknowledgeOverlayPrivateMode({
        version: overlayStatus.disclosure.version
      });
      if (acknowledgement?.ok === false) {
        throw new Error(acknowledgement.error || "The private-mode disclosure could not be acknowledged.");
      }
    }
    const result = await bridge.updateOverlaySettings({ mode, opacity });
    if (result?.ok === false) throw new Error(result.error || "Overlay settings could not be saved.");
    overlayStatus = sanitizeOverlayStatus(result) ?? overlayStatus;
    clearOverlayFeedback();
  } catch (error) {
    setOverlayFeedback(error?.message || "Overlay settings could not be saved.");
  } finally {
    overlayBusy = false;
    renderOverlaySettings();
  }
}

async function runOverlayAction(method) {
  if (!hasOverlayBridge() || overlayBusy || !["showOverlay", "hideOverlay", "resetOverlay", "retryOverlayShortcuts", "resetOverlayShortcuts"].includes(method)) return;
  if (typeof bridge[method] !== "function") return;
  clearOverlayFeedback();
  overlayBusy = true;
  renderOverlaySettings();
  try {
    const result = await bridge[method]();
    if (result?.ok === false) throw new Error(result.error || "Overlay action could not be completed.");
    overlayStatus = sanitizeOverlayStatus(result) ?? overlayStatus;
    await refreshOverlayStatus();
    clearOverlayFeedback();
  } catch (error) {
    setOverlayFeedback(error?.message || "Overlay action could not be completed.");
  } finally {
    overlayBusy = false;
    renderOverlaySettings();
  }
}

function toggleOverlayVisibility() {
  if (!hasOverlayBridge()) return Promise.resolve();
  if (overlayStatus?.visible && typeof bridge.hideOverlay === "function") return runOverlayAction("hideOverlay");
  return runOverlayAction("showOverlay");
}

function toggleSetupRail() {
  setupRailCollapsed = !setupRailCollapsed;
  document.body.classList.toggle("setup-rail-collapsed", setupRailCollapsed);
  elements.setupRailToggle.setAttribute("aria-expanded", String(!setupRailCollapsed));
  elements.setupRailToggle.textContent = setupRailCollapsed ? "Show setup" : "Hide setup";
}

function setWorkspaceTab(tab, { focus = false } = {}) {
  activeWorkspaceTab = tab === "debrief" ? "debrief" : "copilot";
  const isCopilot = activeWorkspaceTab === "copilot";
  const [copilotTab, debriefTab] = elements.workspaceTabs;
  copilotTab.setAttribute("aria-selected", String(isCopilot));
  copilotTab.tabIndex = isCopilot ? 0 : -1;
  debriefTab.setAttribute("aria-selected", String(!isCopilot));
  debriefTab.tabIndex = isCopilot ? -1 : 0;
  elements.workspaceCopilotPanel.hidden = !isCopilot;
  elements.workspaceDebriefPanel.hidden = isCopilot;
  renderDebrief();
  if (focus) (isCopilot ? copilotTab : debriefTab).focus();
}

function handleWorkspaceTabKeydown(event) {
  const current = elements.workspaceTabs.indexOf(event.currentTarget);
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === "Home" ? 0 : event.key === "End" ? elements.workspaceTabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + elements.workspaceTabs.length) % elements.workspaceTabs.length;
  setWorkspaceTab(target === 1 ? "debrief" : "copilot", { focus: true });
}

function prefillCopilotQuestion(value) {
  if (typeof value !== "string" || !value.trim()) return;
  setWorkspaceTab("copilot");
  void revealAssist({ focusQuestion: false });
  elements.assistQuestion.value = value.slice(0, ASSIST_QUESTION_MAX_CHARS);
  handleAssistQuestionInput();
  requestAnimationFrame(() => elements.assistQuestion.focus());
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
      message: !sourceSetup
        ? "The bundled local runtime and all required components are available."
        : engineSetup.python.version
        ? `Python ${engineSetup.python.version} and all required components are available.`
        : "All required local engine components are available.",
      summary: "Ready",
      summaryState: "ready",
      mainStatus: "Ready to start",
      mainDot: "neutral"
    },
    python_missing: {
      title: sourceSetup ? "Python isn't installed" : "Bundled runtime is unavailable",
      message: sourceSetup
        ? `${pythonLabel} is required. Install it, then return here and check again.`
        : "This installed app does not use system Python. Repair or reinstall the app, then check again.",
      summary: sourceSetup ? "Python required" : "Repair required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    python_unsupported: {
      title: sourceSetup ? "Python version isn't supported" : "Bundled runtime isn't supported",
      message: !sourceSetup
        ? "This installed app does not use system Python. Install a current app release, then check again."
        : engineSetup.python.version
        ? `Python ${engineSetup.python.version} was found. This app currently supports ${pythonLabel}. Install it, then check again.`
        : `This app currently supports ${pythonLabel}. Install it, then check again.`,
      summary: sourceSetup ? "Unsupported Python" : "Update required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    components_missing: {
      title: "Engine components are missing",
      message: sourceSetup
        ? `This source checkout is missing ${problemComponents}. Copy and run the setup command, then check again.`
        : `The bundled runtime is incomplete. Unavailable components: ${problemComponents}. Repair or reinstall the app, then check again.`,
      summary: "Setup required",
      summaryState: "warning",
      mainStatus: "Local engine needs setup",
      mainDot: "working"
    },
    components_broken: {
      title: "Engine components need repair",
      message: sourceSetup
        ? `${problemComponents} could not be loaded. Copy and run the setup command to repair the source checkout, then check again.`
        : `${problemComponents} could not be loaded from the bundled runtime. Repair or reinstall the app, then check again.`,
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
      message: sourceSetup
        ? "The app could not verify the local engine. Try again. If this continues, restart the app."
        : "The app could not verify its bundled runtime. Try again. If this continues, repair or reinstall the app.",
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
  const pythonProblem = ["python_missing", "python_unsupported"].includes(engineSetup.state)
    && engineSetup.sourceSetupAvailable;
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

function beginAssistMeeting(sessionId) {
  supersedeAssistRequestForMeetingTransition();
  if (assistStatusRefreshTimer) clearTimeout(assistStatusRefreshTimer);
  assistStatusRefreshTimer = null;
  assistStatusGate.transition(sessionId);
  assistEventGate.activateSession(sessionId, 0);
  assistStatus = null;
  assistExpanded = false;
  assistDismissedSessionId = null;
  assistConsentChecked = false;
  assistRequestContext = null;
  assistOutput = null;
  assistMessage = null;
  assistDeliveryBlockedContext = null;
  renderAssist();
  void refreshAssistStatus();
}

function endAssistMeeting(sessionId) {
  if (assistEventGate.sessionId !== sessionId) return false;
  supersedeAssistRequestForMeetingTransition();
  if (assistStatusRefreshTimer) clearTimeout(assistStatusRefreshTimer);
  assistStatusRefreshTimer = null;
  assistStatusGate.transition(null);
  assistEventGate.endSession(sessionId);
  assistStatus = null;
  assistExpanded = false;
  assistConsentChecked = false;
  assistRequestContext = null;
  assistOutput = null;
  assistMessage = null;
  assistDeliveryBlockedContext = null;
  renderAssist();
  return true;
}

function supersedeAssistRequestForMeetingTransition() {
  assistRequestAttempt?.supersede();
}

function refreshAssistStatus({ fresh = false } = {}) {
  if (fresh) assistStatusGate.invalidate();
  const identity = assistStatusGate.capture();
  if (assistStatusRequest && assistStatusGate.isCurrent(assistStatusRequest.identity)) {
    return assistStatusRequest.promise;
  }
  const request = { identity, promise: null };
  const operation = (async () => {
    try {
      const result = await bridge.getAssistStatus();
      if (!result?.ok) throw new Error(result?.error || "Meeting assistance status could not be checked.");
      if (!assistStatusGate.accepts(identity, result.assist?.sessionId)) return false;
      return applyAssistStatus(result.assist, { expectedSessionId: identity.sessionId });
    } catch (error) {
      if (!assistStatusGate.isCurrent(identity)) return false;
      assistStatus = null;
      setAssistMessage(
        error?.message || "Meeting assistance status could not be checked. Local transcription continues normally.",
        "error"
      );
      return false;
    }
  })();
  request.promise = operation.finally(() => {
    if (assistStatusRequest === request) {
      assistStatusRequest = null;
      renderAssist();
    }
  });
  assistStatusRequest = request;
  renderAssist();
  return request.promise;
}

function scheduleAssistStatusRefresh() {
  // Invalidate immediately so a response already in transit cannot swallow
  // this finalized transcript revision when the debounce timer fires.
  assistStatusGate.invalidate();
  if (assistStatusRefreshTimer) clearTimeout(assistStatusRefreshTimer);
  assistStatusRefreshTimer = setTimeout(() => {
    assistStatusRefreshTimer = null;
    void refreshAssistStatus();
  }, 180);
}

function applyAssistStatus(value, { expectedSessionId = assistStatusGate.sessionId } = {}) {
  const next = sanitizeAssistStatus(value);
  if (next.sessionId !== expectedSessionId || next.sessionId !== assistEventGate.sessionId) return false;
  if (next.sessionId !== null && next.contextRevision < assistEventGate.transcriptRevision) return false;
  assistStatus = next;
  if (assistDeliveryBlockedContext
    && (assistDeliveryBlockedContext.sessionId !== next.sessionId
      || assistDeliveryBlockedContext.contextRevision !== next.contextRevision)) {
    assistDeliveryBlockedContext = null;
  }

  // Lifecycle transitions own gate activation/teardown. Status can advance
  // only the exact already-current meeting identity.
  if (next.sessionId !== null) assistEventGate.advanceTranscript(next.contextRevision);

  assistConsentChecked = next.provider.consentGranted === true;

  if (assistOutput
    && assistOutput.sessionId === next.sessionId
    && next.contextRevision > assistOutput.contextRevision) {
    assistOutput.stale = true;
  }
  return true;
}

function sanitizeAssistStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Meeting assistance status could not be checked.");
  }
  const sessionId = value.sessionId === null ? null : normalizeAssistIdentifier(value.sessionId, "session");
  const contextRevision = normalizeAssistRevision(value.contextRevision);
  const contextSummary = sanitizeAssistContextSummary(value.contextSummary);
  if (sessionId === null && (contextSummary !== null || contextRevision !== 0)) {
    throw new Error("Meeting assistance status could not be checked.");
  }
  const provider = sanitizeAssistProvider(value.provider);
  const sessionContext = sanitizeAssistSessionContextSummary(value.sessionContext);
  const requestPreview = sanitizeAssistRequestPreview(value.requestPreview);
  if (sessionId === null && (sessionContext !== null || requestPreview !== null)) {
    throw new Error("Meeting assistance status could not be checked.");
  }
  return Object.freeze({
    sessionId,
    contextRevision,
    contextSummary,
    sessionContext,
    requestPreview,
    provider
  });
}

function sanitizeAssistContextSummary(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Meeting assistance context could not be checked.");
  }
  const segmentCount = normalizeAssistRevision(value.segmentCount);
  const transcriptChars = normalizeAssistRevision(value.transcriptChars);
  const startMs = normalizeAssistRevision(value.startMs);
  const endMs = normalizeAssistRevision(value.endMs);
  if (segmentCount === 0 || endMs < startMs) {
    throw new Error("Meeting assistance context could not be checked.");
  }
  return Object.freeze({ segmentCount, transcriptChars, startMs, endMs });
}

function sanitizeAssistProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Meeting assistance provider status could not be checked.");
  }
  if (!["off", "openai"].includes(value.mode)
    || typeof value.model !== "string"
    || !ASSIST_CREDENTIAL_STATES.has(value.credentialState)
    || typeof value.configured !== "boolean"
    || typeof value.removable !== "boolean"
    || typeof value.encryptionAvailable !== "boolean"
    || typeof value.consentGranted !== "boolean"
    || typeof value.inFlight !== "boolean") {
    throw new Error("Meeting assistance provider status could not be checked.");
  }
  return Object.freeze({
    mode: value.mode,
    model: value.model,
    configured: value.configured,
    credentialState: value.credentialState,
    removable: value.removable,
    encryptionAvailable: value.encryptionAvailable,
    consentGranted: value.consentGranted,
    inFlight: value.inFlight,
    disclosure: sanitizeAssistDisclosure(value.disclosure)
  });
}

function sanitizeAssistDisclosure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.title !== "string"
    || typeof value.summary !== "string"
    || typeof value.version !== "string") {
    throw new Error("Meeting assistance disclosure could not be checked.");
  }
  const links = Array.isArray(value.links)
    ? value.links.filter((link) => (
      link
      && ASSIST_PROVIDER_LINK_IDS.has(link.id)
      && typeof link.label === "string"
    )).map((link) => Object.freeze({ id: link.id, label: link.label }))
    : [];
  return Object.freeze({
    title: value.title,
    summary: value.summary,
    version: value.version,
    links: Object.freeze(links)
  });
}

function sanitizeAssistSessionContextSummary(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainRendererRecord(value)
    || !isPlainRendererRecord(value.profile)
    || !isSafeRendererIdentifier(value.profile.id)
    || !Number.isSafeInteger(value.profile.version)
    || value.profile.version <= 0
    || !Array.isArray(value.contextPacks)
    || value.contextPacks.length > CONTEXT_PACK_MAX_SELECTED) {
    throw new Error("Meeting assistance context could not be checked.");
  }
  return Object.freeze({
    profile: Object.freeze({
      id: value.profile.id,
      version: value.profile.version,
      name: requireRendererText(value.profile.name, 120)
    }),
    contextPacks: Object.freeze(value.contextPacks.map((pack) => {
      if (!isPlainRendererRecord(pack) || !CONTEXT_PACK_KINDS.has(pack.kind)) {
        throw new Error("Meeting assistance context could not be checked.");
      }
      return Object.freeze({
        kind: pack.kind,
        name: requireRendererText(pack.name, 120),
        bytes: normalizeAssistRevision(pack.bytes)
      });
    }))
  });
}

function sanitizeAssistRequestPreview(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainRendererRecord(value)) {
    throw new Error("Meeting assistance request preview could not be checked.");
  }
  if (value.blocked === true) {
    return Object.freeze({ blocked: true, reason: requireRendererText(value.reason, 500) });
  }
  if (!isPlainRendererRecord(value.transcript)
    || !Array.isArray(value.contextPacks)
    || value.contextPacks.length > CONTEXT_PACK_MAX_SELECTED) {
    throw new Error("Meeting assistance request preview could not be checked.");
  }
  const profile = value.profile === null
    ? null
    : sanitizeAssistPreviewProfile(value.profile);
  const contextPacks = value.contextPacks.map((pack) => {
    if (!isPlainRendererRecord(pack) || !CONTEXT_PACK_KINDS.has(pack.category)) {
      throw new Error("Meeting assistance request preview could not be checked.");
    }
    return Object.freeze({
      category: pack.category,
      name: requireRendererText(pack.name, 120),
      bytes: normalizeAssistRevision(pack.bytes)
    });
  });
  const startMs = value.transcript.startMs === null ? null : normalizeAssistRevision(value.transcript.startMs);
  const endMs = value.transcript.endMs === null ? null : normalizeAssistRevision(value.transcript.endMs);
  if ((startMs === null) !== (endMs === null) || (startMs !== null && endMs < startMs)) {
    throw new Error("Meeting assistance request preview could not be checked.");
  }
  return Object.freeze({
    blocked: false,
    totalBytes: normalizeAssistRevision(value.totalBytes),
    maxBytes: normalizeAssistRevision(value.maxBytes),
    profile,
    contextPacks: Object.freeze(contextPacks),
    transcript: Object.freeze({
      segmentCount: normalizeAssistRevision(value.transcript.segmentCount),
      bytes: normalizeAssistRevision(value.transcript.bytes),
      startMs,
      endMs
    })
  });
}

function sanitizeAssistPreviewProfile(value) {
  if (!isPlainRendererRecord(value)
    || !Number.isSafeInteger(value.version)
    || value.version <= 0) {
    throw new Error("Meeting assistance request preview could not be checked.");
  }
  return Object.freeze({
    name: requireRendererText(value.name, 120),
    version: value.version,
    bytes: normalizeAssistRevision(value.bytes)
  });
}

function renderAssist() {
  const sessionId = assistStatus?.sessionId ?? assistEventGate.sessionId;
  const contextSummary = assistStatus?.contextSummary ?? null;
  const hasContext = Boolean(sessionId && contextSummary?.segmentCount > 0);
  const dismissed = Boolean(sessionId && assistDismissedSessionId === sessionId);
  const inFlight = Boolean(assistRequestPromise || assistOutput?.phase === "streaming" || assistStatus?.provider.inFlight);
  const provider = assistStatus?.provider ?? null;
  const disclosure = provider?.disclosure ?? null;

  elements.assistPanel.hidden = dismissed;
  if (dismissed) return;

  elements.assistEmpty.hidden = hasContext;
  elements.assistEmptyMessage.textContent = sessionId
    ? "Waiting for finalized transcript text before meeting assistance can be used."
    : "Start transcription to use meeting assistance.";
  elements.assistCollapsed.hidden = !hasContext || assistExpanded;
  elements.assistExpanded.hidden = !assistExpanded;
  elements.assistExpand.setAttribute("aria-expanded", String(assistExpanded));

  elements.assistContextSummary.textContent = contextSummary
    ? formatAssistContextSummary(contextSummary)
    : "No finalized context is available yet.";
  elements.assistReviewContext.disabled = !hasContext || inFlight;
  elements.assistQuestion.disabled = !hasContext || inFlight || Boolean(assistOutput);
  elements.assistConsent.disabled = !hasContext
    || inFlight
    || Boolean(assistConsentPromise)
    || !providerCanAssist(provider);
  elements.assistConsent.checked = assistConsentChecked;
  elements.assistSend.disabled = !canSendAssistRequest();
  elements.assistSend.hidden = Boolean(assistOutput);
  elements.assistCancel.hidden = !inFlight;
  elements.assistCancel.disabled = assistCancelPending
    || Boolean(assistRequestAttempt?.canceled && !assistRequestAttempt.dispatched);
  elements.assistDismiss.hidden = inFlight;
  elements.assistProgress.hidden = !inFlight;
  renderAssistQuickActions();
  renderAssistRequestPreview(assistStatus?.requestPreview, assistStatus?.sessionContext, contextSummary);

  renderAssistStateBadge(provider, hasContext, inFlight);
  renderAssistProviderAvailability(provider);
  renderAssistDisclosure(disclosure);
  renderAssistMessage();
  renderAssistResult();
}

function renderAssistRequestPreview(preview, sessionContext, contextSummary) {
  if (preview?.blocked) {
    elements.assistRequestPreview.textContent = `Cannot send: ${preview.reason}`;
    elements.assistRequestPreview.dataset.tone = "error";
    return;
  }
  elements.assistRequestPreview.dataset.tone = "";
  if (!preview) {
    elements.assistRequestPreview.textContent = contextSummary
      ? "Preparing an exact request-size preview. Nothing has been sent."
      : "A request preview will appear after finalized transcript text is available.";
    return;
  }
  const profileName = preview.profile?.name ?? sessionContext?.profile?.name ?? "General";
  const packCount = preview.contextPacks.length;
  const segmentCount = preview.transcript.segmentCount;
  elements.assistRequestPreview.textContent = `Will send the ${profileName} profile, ${packCount} private ${packCount === 1 ? "pack" : "packs"}, and ${segmentCount} finalized ${segmentCount === 1 ? "segment" : "segments"} (${formatContextBytes(preview.totalBytes)} total) only when you choose Send.`;
}

function renderAssistStateBadge(provider, hasContext, inFlight) {
  let display = null;
  if (inFlight) display = ["Working", "working"];
  else if (providerCanAssist(provider) && hasContext) display = ["Ready", "ready"];
  else if (provider?.mode === "off") display = ["Off", "neutral"];
  elements.assistStateBadge.hidden = !display;
  elements.assistStateBadge.textContent = display?.[0] ?? "";
  elements.assistStateBadge.dataset.state = display?.[1] ?? "";
}

function renderAssistProviderAvailability(provider) {
  const message = describeAssistProviderAvailability(provider);
  elements.assistProviderAvailability.hidden = !message;
  elements.assistProviderMessage.textContent = message ?? "";
  elements.assistOpenSettings.disabled = !settingsReady;
}

function describeAssistProviderAvailability(provider) {
  if (!provider) return "Meeting assistance status is unavailable. Open Settings to review the provider.";
  if (provider.mode !== "openai") return "AI assistance is Off. Open Settings to choose OpenAI before sending anything.";
  if (!provider.encryptionAvailable) return "Secure credential storage is unavailable on this device.";
  if (["invalid", "unreadable"].includes(provider.credentialState)) {
    return "The saved OpenAI API key needs to be removed in Settings before assistance can be used.";
  }
  if (!provider.configured) return "No OpenAI API key is saved. Open Settings to import one securely.";
  return null;
}

function renderAssistDisclosure(disclosure) {
  elements.assistDisclosure.textContent = disclosure?.summary ?? "Provider disclosure is unavailable.";
  elements.assistPolicyVersion.textContent = disclosure?.version
    ? `Assistant policy ${disclosure.version} applies to this meeting.`
    : "";
  elements.assistProviderLinks.replaceChildren(...(disclosure?.links ?? []).map((link) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "provider-link-button";
    button.textContent = link.label;
    button.addEventListener("click", () => void openProviderLink(link.id));
    return button;
  }));
}

function handleAssistQuestionInput() {
  const length = elements.assistQuestion.value.length;
  elements.assistQuestionCount.textContent = `${length.toLocaleString()} / ${ASSIST_QUESTION_MAX_CHARS.toLocaleString()}`;
  elements.assistQuestionCount.hidden = length < 800;
  validateAssistQuestion({ announce: false });
  renderAssist();
}

async function handleAssistConsentChange() {
  if (assistConsentPromise) return;
  const previous = assistConsentChecked;
  const desired = elements.assistConsent.checked;
  const identity = assistStatusGate.invalidate();
  assistConsentChecked = desired;
  renderAssist();
  const operation = (async () => {
    const result = await bridge.setAssistConsent(desired);
    if (!result?.ok) throw new Error(result?.error || "Meeting assistance consent could not be updated.");
    if (!assistStatusGate.isCurrent(identity)) return false;
    if (!assistStatusGate.accepts(identity, result.assist?.sessionId)) {
      void refreshAssistStatus({ fresh: true });
      return false;
    }
    if (!applyAssistStatus(result.assist, { expectedSessionId: identity.sessionId })) return false;
    assistConsentChecked = result.assist?.provider?.consentGranted === true;
    return true;
  })();
  assistConsentPromise = operation;
  try {
    const applied = await operation;
    if (applied && assistStatusGate.isCurrent(identity)) assistMessage = null;
  } catch (error) {
    if (assistStatusGate.isCurrent(identity)) {
      assistConsentChecked = previous;
      setAssistMessage(
        `${error?.message || "Meeting assistance consent could not be updated."} Nothing was sent.`,
        "error"
      );
    }
  } finally {
    assistConsentPromise = null;
    renderAssist();
  }
}

function validateAssistQuestion({ announce = true } = {}) {
  const value = elements.assistQuestion.value;
  let message = null;
  if (value.trim().length === 0) message = "Enter a question before sending.";
  else if (value.length > ASSIST_QUESTION_MAX_CHARS) message = "Keep the question within 1,000 characters.";
  else if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    message = "Remove unsupported control characters from the question.";
  }
  elements.assistQuestionValidation.hidden = !message || !announce;
  elements.assistQuestionValidation.textContent = announce ? message ?? "" : "";
  elements.assistQuestion.setAttribute("aria-invalid", String(Boolean(message && announce)));
  return message === null ? value.trim() : null;
}

function providerCanAssist(provider = assistStatus?.provider) {
  return Boolean(provider
    && provider.mode === "openai"
    && provider.configured
    && provider.credentialState === "configured"
    && provider.encryptionAvailable);
}

function canSendAssistRequest({ currentAttempt = null } = {}) {
  const question = elements.assistQuestion.value;
  const ownsCurrentAttempt = Boolean(currentAttempt && assistRequestAttempt === currentAttempt);
  const deliveryBlocked = Boolean(assistDeliveryBlockedContext
    && assistDeliveryBlockedContext.sessionId === assistStatus?.sessionId
    && assistDeliveryBlockedContext.contextRevision === assistStatus?.contextRevision);
  return Boolean(
    assistStatus?.sessionId
    && assistStatus.contextSummary?.segmentCount > 0
    && providerCanAssist()
    && assistStatus.provider.disclosure?.version
    && assistStatus.provider.consentGranted
    && assistConsentChecked
    && question.trim().length > 0
    && question.length <= ASSIST_QUESTION_MAX_CHARS
    && !/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(question)
    && (!assistRequestPromise || ownsCurrentAttempt)
    && !assistConsentPromise
    && !assistCancelPending
    && assistOutput?.phase !== "streaming"
    && !assistStatus.provider.inFlight
    && assistStatus.requestPreview?.blocked !== true
    && !deliveryBlocked
    && !assistOutput
  );
}

async function revealAssist({ focusQuestion = false } = {}) {
  setWorkspaceTab("copilot");
  if (assistStatus?.sessionId && assistDismissedSessionId === assistStatus.sessionId) {
    assistDismissedSessionId = null;
  }
  await refreshAssistStatus();
  if (assistStatus?.contextSummary?.segmentCount > 0) assistExpanded = true;
  renderAssist();
  if (focusQuestion && assistExpanded && !elements.assistQuestion.disabled) {
    requestAnimationFrame(() => {
      elements.assistPanel.scrollIntoView({ block: "nearest" });
      elements.assistQuestion.focus();
    });
  } else if (focusQuestion) {
    elements.assistPanel.tabIndex = -1;
    elements.assistPanel.focus();
  }
}

function dismissAssistForMeeting() {
  if (assistRequestPromise || assistOutput?.phase === "streaming") return;
  const sessionId = assistStatus?.sessionId ?? assistEventGate.sessionId;
  if (sessionId) assistDismissedSessionId = sessionId;
  else assistExpanded = false;
  renderAssist();
}

async function openAssistContextReview() {
  if (!assistStatus?.sessionId || elements.assistContextDialog.open) return;
  try {
    const context = await getExactAssistContext();
    renderAssistContextDialog(context);
    elements.assistContextDialog.showModal();
  } catch (error) {
    setAssistMessage(
      error?.message || "The finalized context could not be reviewed. Local transcription continues normally.",
      "error"
    );
    renderAssist();
  }
}

function closeAssistContextReview() {
  if (elements.assistContextDialog.open) elements.assistContextDialog.close();
}

function useReviewedAssistContext() {
  closeAssistContextReview();
  renderAssist();
  requestAnimationFrame(() => elements.assistQuestion.focus());
}

async function getExactAssistContext() {
  const result = await bridge.getAssistContext();
  if (!result?.ok) throw new Error(result?.error || "The finalized assistance context could not be loaded.");
  const context = sanitizeAssistContext(result.context);
  if (!context || context.sessionId !== assistStatus?.sessionId) {
    throw new Error("The finalized assistance context changed. Try sending again.");
  }
  if (context.sessionId !== assistEventGate.sessionId) {
    assistEventGate.activateSession(context.sessionId, context.revision);
  } else if (!assistEventGate.advanceTranscript(context.revision)) {
    throw new Error("The finalized assistance context is stale. Try sending again.");
  }
  return context;
}

function sanitizeAssistContext(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The finalized assistance context could not be loaded.");
  }
  const sessionId = normalizeAssistIdentifier(value.sessionId, "session");
  const revision = normalizeAssistRevision(value.revision);
  const transcriptChars = normalizeAssistRevision(value.transcriptChars);
  if (!Array.isArray(value.segments) || value.segments.length > 48 || transcriptChars > 12_000) {
    throw new Error("The finalized assistance context could not be loaded.");
  }
  const segments = value.segments.map((segment) => sanitizeAssistContextSegment(segment));
  const ids = new Set();
  let measuredChars = 0;
  let previous = null;
  for (const segment of segments) {
    if (ids.has(segment.id)
      || (previous && compareAssistContextSegments(previous, segment) > 0)) {
      throw new Error("The finalized assistance context could not be loaded.");
    }
    ids.add(segment.id);
    measuredChars += segment.text.length;
    previous = segment;
  }
  if (measuredChars !== transcriptChars) {
    throw new Error("The finalized assistance context could not be loaded.");
  }
  return Object.freeze({
    sessionId,
    revision,
    transcriptChars,
    segments: Object.freeze(segments),
    sessionContext: sanitizeAssistSessionContextSummary(value.sessionContext),
    requestPreview: sanitizeAssistRequestPreview(value.requestPreview)
  });
}

function sanitizeAssistContextSegment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.text !== "string"
    || value.text.trim().length === 0
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)
    || !["system", "microphone"].includes(value.track)) {
    throw new Error("The finalized assistance context could not be loaded.");
  }
  const startMs = normalizeAssistRevision(value.start_ms);
  const endMs = normalizeAssistRevision(value.end_ms);
  if (endMs < startMs) throw new Error("The finalized assistance context could not be loaded.");
  const speakerId = typeof value.speaker_id === "string" ? value.speaker_id : null;
  if (speakerId !== null
    && (speakerId.length > 256 || /[\u0000-\u001f\u007f]/u.test(speakerId))) {
    throw new Error("The finalized assistance context could not be loaded.");
  }
  return Object.freeze({
    id: normalizeAssistIdentifier(value.id, "segment"),
    revision: normalizeAssistRevision(value.revision),
    start_ms: startMs,
    end_ms: endMs,
    track: value.track,
    text: value.text,
    language: typeof value.language === "string" ? value.language : null,
    speaker_id: speakerId
  });
}

function compareAssistContextSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function renderAssistContextDialog(context) {
  const summary = summarizeAssistContextSnapshot(context);
  elements.assistContextDialogSummary.textContent = summary
    ? formatAssistContextSummary(summary)
    : "No finalized transcript context is available.";
  elements.assistContextDialogEmpty.hidden = context.segments.length > 0;
  elements.assistContextUse.disabled = context.segments.length === 0;
  const sessionContext = context.sessionContext;
  const privateSummary = [];
  if (sessionContext?.profile) {
    const profile = document.createElement("div");
    profile.textContent = `Meeting profile: ${sessionContext.profile.name} (version ${sessionContext.profile.version})`;
    privateSummary.push(profile);
  }
  if (sessionContext?.contextPacks.length) {
    const packs = document.createElement("div");
    packs.textContent = `Private context selected: ${sessionContext.contextPacks.map((pack) => `${pack.name} (${CONTEXT_KIND_LABELS[pack.kind]}, ${formatContextBytes(pack.bytes)})`).join(", ")}. Contents stay hidden in this summary.`;
    privateSummary.push(packs);
  } else {
    const packs = document.createElement("div");
    packs.textContent = "Private context selected: none.";
    privateSummary.push(packs);
  }
  if (context.requestPreview?.blocked) {
    const blocked = document.createElement("div");
    blocked.textContent = `Request blocked: ${context.requestPreview.reason}`;
    privateSummary.push(blocked);
  }
  elements.assistContextPrivateSummary.replaceChildren(...privateSummary);
  elements.assistContextList.replaceChildren(...context.segments.map((segment) => {
    const item = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "assist-context-segment-meta";
    meta.textContent = `${formatTimestamp(segment.start_ms)}–${formatTimestamp(segment.end_ms)} · ${formatAssistSnapshotSpeaker(segment)}`;
    const text = document.createElement("p");
    text.className = "assist-context-segment-text";
    text.textContent = segment.text;
    setLanguageAttribute(text, segment.language);
    item.append(meta, text);
    return item;
  }));
}

async function sendAssistRequest() {
  const question = validateAssistQuestion({ announce: true });
  if (!question || assistRequestPromise || assistOutput) return;
  const attempt = new AssistRequestAttempt();
  const meetingIdentity = assistStatusGate.capture();
  assistRequestAttempt = attempt;
  assistMessage = null;
  assistRequestPromise = (async () => {
    await refreshAssistStatus({ fresh: true });
    attempt.throwIfCanceledBeforeDispatch();
    if (!canSendAssistRequest({ currentAttempt: attempt })) {
      throw new Error(describeAssistSendBlocker());
    }

    // Review is inspect-only. Every explicit Send freezes a fresh, exact,
    // one-use pack in the main process immediately before the request.
    const context = await getExactAssistContext();
    attempt.throwIfCanceledBeforeDispatch();
    if (context.segments.length === 0) throw new Error("Wait for finalized transcript text before sending a question.");
    if (!attempt.bindContext(context.sessionId, context.revision)) {
      throw new Error("The meeting assistance request could not be prepared.");
    }
    assistRequestContext = context;
    const pending = assistEventGate.beginRequest(context.revision);
    if (!pending || pending.sessionId !== assistStatus.sessionId || pending.minimumContextRevision !== context.revision) {
      throw new Error("The meeting context changed. Try sending again.");
    }

    assistOutput = createPendingAssistOutput(context);
    renderAssist();
    // This final synchronous check and dispatch mark close the preflight
    // cancellation window before any provider request can be transmitted.
    attempt.throwIfCanceledBeforeDispatch();
    if (!attempt.markDispatched()) {
      throw new Error("The meeting assistance request could not be dispatched.");
    }
    const result = await bridge.requestAssist({ question });
    if (!result?.ok) throw new Error(result?.error || "Assistance could not be completed.");
    // The invoke reply and streamed webContents events use separate Electron
    // channels. Wait for the strictly gated terminal event instead of assuming
    // cross-channel delivery order.
    await attempt.waitForTerminal();
  })();
  renderAssist();

  try {
    await assistRequestPromise;
  } catch (error) {
    const ownsCurrentMeeting = assistRequestAttempt === attempt
      && assistStatusGate.isSameSession(meetingIdentity);
    if (!ownsCurrentMeeting) return;
    if (error instanceof AssistRequestCanceledError) {
      if (assistOutput?.phase === "pending") assistOutput.phase = "canceled";
      setAssistMessage(error.message, "warning");
    } else if (error instanceof AssistTerminalDeliveryTimeoutError) {
      if (assistOutput) assistOutput.phase = "error";
      assistDeliveryBlockedContext = attempt.context;
      setAssistMessage(
        `${error.message} Wait for new finalized transcript text or restart the meeting before trying again. Local transcription continues normally.`,
        "error"
      );
    } else if (!assistOutput || !["error", "canceled"].includes(assistOutput.phase)) {
      if (assistOutput) assistOutput.phase = "error";
      setAssistMessage(
        `${error?.message || "Assistance could not be completed."} Local transcription continues normally.`,
        "error"
      );
    }
  } finally {
    const ownsAttempt = assistRequestAttempt === attempt;
    attempt.finish();
    if (ownsAttempt) {
      assistRequestAttempt = null;
      assistRequestPromise = null;
      if (assistStatusGate.isSameSession(meetingIdentity)) {
        await refreshAssistStatus({ fresh: true });
      }
      renderAssist();
    }
  }
}

function createPendingAssistOutput(context) {
  return {
    requestId: null,
    sessionId: context.sessionId,
    contextRevision: context.revision,
    contextSnapshot: context,
    snapshotVerified: false,
    phase: "pending",
    suggestion: "",
    citations: [],
    stale: false,
    staleAcknowledged: false,
    metrics: null
  };
}

function handleAssistEvent(event) {
  const attempt = assistRequestAttempt;
  if (!attempt || attempt.closed) return;
  if (!assistEventGate.accepts(event)) return;

  if (event.type === "assist_started") {
    if (!attempt.bindStarted(event)) return;
    const context = assistRequestContext?.sessionId === event.sessionId
      && assistRequestContext.revision === event.contextRevision
      ? assistRequestContext
      : null;
    assistOutput = {
      requestId: event.requestId,
      sessionId: event.sessionId,
      contextRevision: event.contextRevision,
      contextSnapshot: context,
      snapshotVerified: Boolean(context),
      phase: "streaming",
      suggestion: "",
      citations: [],
      stale: assistStatus?.sessionId === event.sessionId
        && assistStatus.contextRevision > event.contextRevision,
      staleAcknowledged: false,
      metrics: null
    };
    assistExpanded = true;
    assistDismissedSessionId = null;
    assistMessage = null;
    renderAssist();
    return;
  }

  if (!assistOutput || event.requestId !== assistOutput.requestId) return;
  const terminal = ["assist_completed", "assist_error", "assist_canceled"].includes(event.type);
  if (terminal && !attempt.acceptTerminal(event)) return;
  if (event.type === "assist_delta") {
    // v0.4 intentionally presents all streamed model text as an unverified
    // suggestion. It does not promote provider-generated classifications to
    // meeting facts.
    if (event.channel === "suggestion") assistOutput.suggestion += event.delta;
  } else if (event.type === "assist_item") {
    if (event.channel === "suggestion") {
      assistOutput.suggestion = appendAssistSuggestion(assistOutput.suggestion, event.text);
      if (assistOutput.snapshotVerified) {
        const allowedIds = new Set(assistOutput.contextSnapshot.segments.map((segment) => segment.id));
        if (event.citations.every((id) => allowedIds.has(id))) {
          assistOutput.citations = [...new Set([...assistOutput.citations, ...event.citations])];
        }
      }
    }
  } else if (event.type === "assist_completed") {
    assistOutput.phase = "completed";
    assistOutput.metrics = event.metrics;
    if (!assistOutput.suggestion.trim()) {
      setAssistMessage("The provider completed without a displayable suggestion. Local transcription continues normally.", "warning");
    }
  } else if (event.type === "assist_error") {
    assistOutput.phase = "error";
    setAssistMessage(`${event.error.message} Local transcription continues normally.`, "error");
  } else if (event.type === "assist_canceled") {
    assistOutput.phase = "canceled";
    setAssistMessage("Assistance canceled. Your transcript was not changed.", "warning");
  }
  renderAssist();
}

async function cancelAssistRequest() {
  if (assistCancelPending || (!assistRequestPromise && assistOutput?.phase !== "streaming")) return;
  const attempt = assistRequestAttempt;
  if (attempt?.cancel()) {
    if (assistOutput?.phase === "pending") assistOutput.phase = "canceled";
    setAssistMessage("Assistance canceled before any meeting context was sent.", "warning");
    renderAssist();
    return;
  }
  assistCancelPending = true;
  renderAssist();
  try {
    const result = await bridge.cancelAssist();
    if (!result?.ok) throw new Error(result?.error || "The assistance request could not be canceled.");
  } catch (error) {
    setAssistMessage(
      `${error?.message || "The assistance request could not be canceled."} Local transcription continues normally.`,
      "error"
    );
  } finally {
    assistCancelPending = false;
    renderAssist();
  }
}

function renderAssistMessage() {
  elements.assistMessage.hidden = !assistMessage;
  elements.assistMessage.textContent = assistMessage?.text ?? "";
  elements.assistMessage.dataset.tone = assistMessage?.tone ?? "";
  elements.assistMessage.setAttribute("role", assistMessage?.tone === "error" ? "alert" : "status");
  elements.assistMessage.setAttribute("aria-live", assistMessage?.tone === "error" ? "assertive" : "polite");
}

function setAssistMessage(text, tone = "status") {
  assistMessage = { text, tone };
}

function renderAssistResult() {
  elements.assistResult.hidden = !assistOutput;
  if (!assistOutput) {
    elements.assistResultContent.replaceChildren();
    elements.assistClearResponse.hidden = true;
    return;
  }

  const summary = assistOutput.contextSnapshot
    ? summarizeAssistContextSnapshot(assistOutput.contextSnapshot)
    : null;
  elements.assistResultContext.textContent = summary
    ? `Frozen context · ${formatAssistContextSummary(summary)}`
    : `Frozen context revision ${assistOutput.contextRevision}`;
  const resultState = {
    pending: ["Preparing", "working"],
    streaming: ["Streaming", "working"],
    completed: ["Complete", "complete"],
    canceled: ["Incomplete", "incomplete"],
    error: ["Incomplete", "error"]
  }[assistOutput.phase];
  elements.assistResultState.textContent = resultState?.[0] ?? "";
  elements.assistResultState.dataset.state = resultState?.[1] ?? "";

  const suggestion = assistOutput.suggestion.trim();
  const content = [];
  if (suggestion) {
    const channel = document.createElement("section");
    channel.className = "assist-channel";
    channel.dataset.channel = "suggestion";
    const title = document.createElement("h4");
    title.className = "assist-channel-title";
    title.textContent = "Suggested response";
    const text = document.createElement("p");
    text.className = "assist-channel-text";
    text.textContent = suggestion;
    channel.append(title, text);
    const citations = renderAssistCitations(assistOutput);
    if (citations) channel.append(citations);
    content.push(channel);
  }
  elements.assistResultContent.replaceChildren(...content);
  elements.assistCopySuggestion.hidden = !suggestion;
  elements.assistResetRequest.hidden = ["pending", "streaming"].includes(assistOutput.phase);
  elements.assistClearResponse.hidden = ["pending", "streaming"].includes(assistOutput.phase);
  elements.assistResetRequest.textContent = assistOutput.phase === "error" ? "Try again" : "Ask another question";
  elements.assistStale.hidden = !assistOutput.stale || assistOutput.staleAcknowledged;
}

function renderAssistCitations(output) {
  if (!output.snapshotVerified || output.citations.length === 0) return null;
  const segmentById = new Map(output.contextSnapshot.segments.map((segment) => [segment.id, segment]));
  const container = document.createElement("div");
  container.className = "assist-citations";
  container.setAttribute("aria-label", "Supporting finalized transcript citations");
  for (const id of output.citations) {
    const segment = segmentById.get(id);
    if (!segment) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assist-citation";
    const label = `${formatTimestamp(segment.start_ms)} · ${formatAssistSnapshotSpeaker(segment)}`;
    button.textContent = label;
    button.title = label;
    button.setAttribute("aria-label", `Open frozen transcript citation at ${label}`);
    button.addEventListener("click", () => focusTranscriptCitation(id));
    container.append(button);
  }
  return container.childElementCount > 0 ? container : null;
}

function focusTranscriptCitation(segmentId) {
  const node = segmentNodes.get(segmentId);
  if (!node) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  node.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  node.focus({ preventScroll: true });
}

async function copyAssistSuggestion() {
  const suggestion = assistOutput?.suggestion.trim();
  if (!suggestion) return;
  const result = await bridge.copy(suggestion);
  if (!result?.ok) {
    setAssistMessage(result?.error || "The suggestion could not be copied.", "error");
  } else {
    setAssistMessage("Suggestion copied.", "status");
  }
  renderAssist();
}

async function clearAssistResponse() {
  if (!assistOutput || ["pending", "streaming"].includes(assistOutput.phase)) return;
  const confirmed = await confirmLocalDeletion({
    title: "Clear Copilot response?",
    message: "This removes only the current Copilot response from this window. The transcript, debrief, private context packs, and any text you already copied remain unchanged.",
    confirmLabel: "Clear response"
  });
  if (!confirmed) return;
  assistOutput = null;
  assistRequestContext = null;
  setAssistMessage("Copilot response cleared from this window. Transcript and debrief remain.", "status");
  renderAssist();
}

function resetAssistRequest() {
  if (assistOutput?.phase === "streaming" || assistRequestPromise) return;
  assistOutput = null;
  assistRequestContext = null;
  const deliveryBlocked = assistDeliveryBlockedContext?.sessionId === assistStatus?.sessionId
    && assistDeliveryBlockedContext.contextRevision === assistStatus?.contextRevision;
  assistMessage = deliveryBlocked
    ? {
        text: "Wait for new finalized transcript text or restart the meeting before requesting assistance again.",
        tone: "error"
      }
    : null;
  renderAssist();
  void refreshAssistStatus().then(() => requestAnimationFrame(() => elements.assistQuestion.focus()));
}

async function useLatestAssistContext() {
  if (!assistOutput || assistOutput.phase === "streaming") return;
  assistOutput = null;
  assistRequestContext = null;
  assistMessage = null;
  await refreshAssistStatus();
  renderAssist();
  requestAnimationFrame(() => elements.assistQuestion.focus());
}

function keepAssistAnswer() {
  if (!assistOutput) return;
  assistOutput.staleAcknowledged = true;
  renderAssist();
}

function describeAssistSendBlocker() {
  if (!assistStatus?.sessionId) return "Start a meeting before requesting assistance.";
  if (!assistStatus.contextSummary?.segmentCount) return "Wait for finalized transcript text before sending a question.";
  const providerMessage = describeAssistProviderAvailability(assistStatus.provider);
  if (providerMessage) return providerMessage;
  if (assistDeliveryBlockedContext?.sessionId === assistStatus.sessionId
    && assistDeliveryBlockedContext.contextRevision === assistStatus.contextRevision) {
    return "Wait for new finalized transcript text or restart the meeting before requesting assistance again.";
  }
  if (assistStatus.requestPreview?.blocked) return assistStatus.requestPreview.reason;
  if (!assistConsentChecked) return "Review the disclosure and confirm consent for this meeting.";
  return "The assistance request is not ready yet. Review the question and try again.";
}

function formatAssistContextSummary(summary) {
  return `${summary.segmentCount} finalized ${summary.segmentCount === 1 ? "segment" : "segments"} · ${formatTimestamp(summary.startMs)}–${formatTimestamp(summary.endMs)}`;
}

function summarizeAssistContextSnapshot(context) {
  if (!context?.segments?.length) return null;
  return {
    segmentCount: context.segments.length,
    transcriptChars: context.transcriptChars,
    startMs: context.segments[0].start_ms,
    endMs: context.segments.at(-1).end_ms
  };
}

function formatAssistSnapshotSpeaker(segment) {
  if (segment.track === "microphone") return "You";
  return segment.speaker_id || "Meeting audio";
}

function formatContextBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1_000) return `${bytes} B`;
  return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0).replace(/\.0$/, "")} KB`;
}

function appendAssistSuggestion(current, next) {
  if (!current.trim()) return next;
  return `${current.trimEnd()}\n\n${next}`;
}

function normalizeAssistIdentifier(value, label) {
  if (typeof value !== "string") throw new Error(`The assistance ${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`The assistance ${label} is invalid.`);
  }
  return normalized;
}

function normalizeAssistRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The assistance context revision is invalid.");
  }
  return value;
}

function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.isContentEditable || Boolean(target.closest("[contenteditable]:not([contenteditable='false'])"));
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
  elements.ribbonElapsed.textContent = elements.elapsed.textContent;
  elements.ribbonElapsed.dateTime = elements.elapsed.dateTime;
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
