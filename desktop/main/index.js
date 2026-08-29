import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  Tray
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendController, STOP_TIMEOUT_MS } from "./backend-controller.js";
import { BackendSetupManager } from "./backend-setup.js";
import { AssistController } from "./assist-controller.js";
import { createAssistProviderAdapter } from "./assist-provider-adapter.js";
import { normalizeRendererAssistRequest } from "./assist-protocol.js";
import {
  createCloseCoordinator,
  createCloseReadyGate,
  finalizeCloseLifecycle,
  getWindowCloseAction,
  getWindowMinimizeAction
} from "./close-lifecycle.js";
import { createBackendStartOptions, validateRendererSettingsPatch } from "./desktop-policy.js";
import { loadModelCatalog } from "./model-catalog.js";
import {
  DEFAULT_SETTINGS,
  createSettingsStore
} from "./settings-store.js";
import {
  TranscriptFileError,
  buildTranscriptFileName,
  createTranscriptFileService,
  validateFinalMarkdown
} from "./transcript-file-service.js";
import {
  isExactRendererFrame,
  isExactRendererIpcEvent,
  isTrustedRendererPermissionRequest,
  isTrustedFileOrigin,
  supportsSystemAudio
} from "./platform.js";
import { createStartupService, isHiddenLaunch } from "./startup-service.js";
import { createTrayController, validateTrayStateDto } from "./tray-controller.js";
import { createOpenAIProvider } from "./openai-provider.js";
import { createFakeAssistProvider } from "./fake-assist-provider.js";
import { ProviderController } from "./provider-controller.js";
import { createProviderCredentialStore } from "./provider-credential-store.js";
import { createContextPackStore } from "./context-pack-store.js";
import {
  DEFAULT_MEETING_PROFILE_ID,
  getMeetingProfile,
  getMeetingProfileCatalogDto,
  normalizeMeetingProfileSelection
} from "./meeting-profiles.js";
import {
  PROVIDER_DISCLOSURE,
  PROVIDER_DISCLOSURE_VERSION,
  buildProviderContextPreview,
  createAssistSessionContext,
  resolveProviderExternalLink
} from "./provider-policy.js";
import { createOverlayController, OverlayControllerError } from "./overlay-controller.js";
import { createOverlaySettingsStore } from "./overlay-settings-store.js";
import { createShortcutRegistry } from "./shortcut-registry.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..", "..");
const rendererEntry = path.join(projectRoot, "desktop", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererEntry).href;
const preloadEntry = path.join(projectRoot, "desktop", "preload", "index.cjs");
const overlayRendererEntry = path.join(projectRoot, "desktop", "renderer", "overlay.html");
const overlayRendererUrl = pathToFileURL(overlayRendererEntry).href;
const overlayPreloadEntry = path.join(projectRoot, "desktop", "preload", "overlay.cjs");
const applicationIcon = path.join(projectRoot, "desktop", "build", "icon.png");
const backendRoot = app.isPackaged
  ? path.join(process.resourcesPath, "backend")
  : path.join(projectRoot, "backend");
const fakeBackendPath = path.join(projectRoot, "desktop", "test", "fake-backend.js");
const modelManifestPath = path.join(backendRoot, "src", "meeting_transcriber", "model_manifest.json");
// Python 3.12.10 is the last 3.12 release with official Windows and macOS
// binary installers. Newer Python series are intentionally rejected until the
// native transcription stack has been validated against them.
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/release/python-31210/";
const BOOTSTRAP_COMMAND = process.platform === "win32"
  ? ".\\scripts\\bootstrap.ps1"
  : "bash scripts/bootstrap.sh";
// Startup has an explicit bounded cancel path. The close-ready gate therefore
// needs only finalization plus shutdown and atomic-file-settle margin.
const RENDERER_CLOSE_READY_TIMEOUT_MS = STOP_TIMEOUT_MS + 30_000;
// Only messages authored as stable, path-free product copy may cross an IPC
// handler through publicError. Runtime, filesystem, process, and provider
// exceptions otherwise collapse to the handler-owned fallback below.
const PUBLIC_ERROR_MESSAGES = new Set([
  "A transcription session is already active.",
  "A transcription session is already changing state.",
  "Could not initialize the transcription engine.",
  "Finalizing the transcript timed out.",
  "Settings update contains an unsupported field.",
  "Settings update must be an object.",
  "The automatic save setting is invalid.",
  "The assistance model setting is invalid.",
  "The assistance provider setting is invalid or unavailable.",
  "The launch-at-startup setting is invalid.",
  "The minimize-to-tray setting is invalid.",
  "The local application data path is invalid.",
  "The local audio queue reached its safety limit.",
  "The local model startup could not be canceled normally.",
  "The local process termination has not been confirmed yet.",
  "The local transcription engine could not start.",
  "The local transcription engine took too long to start.",
  "The local transcription prerequisites could not be verified.",
  "The local transcription prerequisites have not been verified.",
  "The local transcription process could not start.",
  "The local transcription process is still shutting down.",
  "The local transcription process stopped.",
  "The selected language is not supported.",
  "The selected model is not supported.",
  "The selected translation mode is unavailable in this build.",
  "The speaker detection setting is invalid.",
  "The transcription backend is not running.",
  "The transcription backend is not writable.",
  "The transcription engine is not ready for audio.",
  "The transcript folder could not be selected.",
  "The window close behavior is invalid.",
  "Launch at sign-in is available in an installed Windows or macOS app.",
  "Transcription settings are invalid.",
  "Transcription settings contain an unsupported field."
]);

let mainWindow = null;
let allowWindowClose = false;
let quitRequested = false;
let hideNextWindowOnReady = isHiddenLaunch(process.argv);
let settingsStore = null;
let startupService = null;
let trayController = null;
let providerController = null;
let assistController = null;
let contextPackStore = null;
let overlayController = null;
let overlaySettingsStore = null;
let shortcutRegistry = null;
let displayRecoveryTimer = null;
let fakeAssistConsent = null;
let desktopBootstrapReady = false;
let pendingWindowShow = null;
let settings = { ...DEFAULT_SETTINGS };
let modelCatalog = null;
let meetingInProgress = false;
let successfulStop = false;
let lastSessionStopReason = null;

const backendSetup = new BackendSetupManager({ backendRoot, fakeBackendPath });
const backend = new BackendController({
  backendRoot,
  fakeBackendPath,
  getVerifiedLaunch: () => backendSetup.getVerifiedLaunch()
});
const transcriptFiles = createTranscriptFileService();
const closeCoordinator = createCloseCoordinator(closeWindowSafely);
const closeReadyGate = createCloseReadyGate({ timeoutMs: RENDERER_CLOSE_READY_TIMEOUT_MS });

backend.on("event", (event) => {
  if (event.type === "final_segment") assistController?.ingest(event);
  overlayController?.ingestBackendEvent(event);
  if (event.type === "session_stopped") endAssistSession(event.session_id);
  if (event.type === "session_stopped") lastSessionStopReason = event.reason ?? null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("meeting:backend-event", event);
  }
});

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  allowWindowClose = false;
  const startHidden = hideNextWindowOnReady;
  hideNextWindowOnReady = false;
  mainWindow = new BrowserWindow({
    width: 1_000,
    height: 700,
    minWidth: 820,
    minHeight: 600,
    show: false,
    title: "Meeting Transcriber",
    icon: applicationIcon,
    backgroundColor: "#f5f6f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow.once("ready-to-show", () => {
    const pending = takePendingWindowShow();
    if (!startHidden || pending) revealMainWindow(pending ?? {});
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    const action = getWindowCloseAction({
      closeBehavior: settings.closeBehavior,
      quitRequested
    });
    if (action === "hide") {
      mainWindow?.hide();
      return;
    }
    requestApplicationQuit();
  });
  mainWindow.on("minimize", (event) => {
    if (getWindowMinimizeAction(settings) !== "hide") return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererEntry);
  return mainWindow;
}

function showMainWindow({ focusStart = false, focusAssist = false } = {}) {
  if (!desktopBootstrapReady) {
    queueWindowShow({ focusStart, focusAssist });
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoadingMainFrame()) {
    queueWindowShow({ focusStart, focusAssist });
    return;
  }
  revealMainWindow({ focusStart, focusAssist });
}

function revealMainWindow({ focusStart = false, focusAssist = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!focusStart && !focusAssist) return;
  const signalFocus = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (focusAssist) mainWindow.webContents.send("meeting:assist-shortcut");
      else mainWindow.webContents.send("meeting:tray-action", "focus-start");
    }
  };
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", signalFocus);
  } else {
    signalFocus();
  }
}

function queueWindowShow({ focusStart = false, focusAssist = false } = {}) {
  pendingWindowShow = {
    focusStart: focusStart || pendingWindowShow?.focusStart === true,
    focusAssist: focusAssist || pendingWindowShow?.focusAssist === true
  };
}

function takePendingWindowShow() {
  const pending = pendingWindowShow;
  pendingWindowShow = null;
  return pending;
}

function requestTrayStop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("meeting:tray-action", "stop");
}

function requestApplicationQuit() {
  quitRequested = true;
  void closeCoordinator.request({ quit: true });
}

function createApplicationTray() {
  if (trayController) return;
  trayController = createTrayController({
    Tray,
    Menu,
    nativeImage,
    platform: process.platform,
    showWindow: showMainWindow,
    requestStop: requestTrayStop,
    requestQuit: requestApplicationQuit
  });
  // Readiness is not established until the renderer reconciles the catalog
  // and prerequisite doctor. Never advertise Ready during that bootstrap gap.
  trayController.setState("preparing");
}

function createProviderBoundary() {
  const providerSession = session.fromPartition("meeting-transcriber-openai", { cache: false });
  const credentialStore = createProviderCredentialStore({
    credentialPath: path.join(app.getPath("userData"), "openai-credential.json"),
    safeStorage
  });
  providerController = new ProviderController({
    credentialStore,
    openAIProvider: createOpenAIProvider({
      fetch: providerSession.fetch.bind(providerSession)
    })
  });
  providerController.configure({
    mode: settings.providerMode,
    model: settings.openAIModel
  });
}

function createAssistLibraryBoundary() {
  contextPackStore = createContextPackStore({
    contextPackPath: path.join(app.getPath("userData"), "meeting-context-packs.json"),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  });
}

function createAssistBoundary() {
  const provider = isDevelopmentFakeAssistEnabled()
    ? createFakeAssistProvider()
    : createAssistProviderAdapter({ providerController });
  assistController = new AssistController({ provider });
  assistController.on("event", sendAssistEvent);
}

async function createOverlayBoundary() {
  overlaySettingsStore = createOverlaySettingsStore({
    userDataPath: app.getPath("userData")
  });
  overlayController = createOverlayController({
    BrowserWindow,
    screen,
    platform: process.platform,
    rendererEntry: overlayRendererEntry,
    rendererUrl: overlayRendererUrl,
    preloadEntry: overlayPreloadEntry,
    icon: applicationIcon,
    settingsStore: overlaySettingsStore,
    showWorkspace: () => showMainWindow(),
    focusAssist: () => showMainWindow({ focusAssist: true }),
    cancelAssist: () => assistController?.cancel("canceled"),
    shouldAllowClose: () => quitRequested || allowWindowClose,
    onStatusChange: sendOverlayStatusToWorkspace
  });
  await overlayController.initialize();
  await refreshOverlayProviderState();
}

function createShortcutBoundary() {
  shortcutRegistry = createShortcutRegistry({
    globalShortcut,
    handlers: {
      showHide: () => overlayController?.toggleVisibility(),
      focusAssist: () => showMainWindow({ focusAssist: true }),
      cancelAssist: () => assistController?.cancel("canceled"),
      opacityUp: () => {
        void overlayController?.adjustOpacity("up").catch(() => {});
      },
      opacityDown: () => {
        void overlayController?.adjustOpacity("down").catch(() => {});
      },
      toggleClickThrough: () => {
        try {
          overlayController?.toggleClickThrough();
        } catch {
          // The visible shortcut status explains why recovery is unavailable.
        }
      }
    }
  });
  updateShortcutStatus(shortcutRegistry.registerAll());
}

function updateShortcutStatus(status) {
  overlayController?.setShortcutStatus(status);
  return status;
}

function sendOverlayStatusToWorkspace(status) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
  try {
    mainWindow.webContents.send("meeting:overlay-status", status);
  } catch {
    // Companion status is informational and does not affect capture.
  }
}

async function refreshOverlayProviderState() {
  if (!overlayController) return;
  try {
    const assist = await getRendererAssistStatus();
    overlayController.setProviderStatus(assist.provider);
  } catch {
    overlayController.setProviderStatus({
      mode: settings.providerMode,
      configured: false,
      consentGranted: false,
      inFlight: false
    });
  }
}

function scheduleOverlayPlacementRecovery() {
  if (!overlayController) return;
  if (displayRecoveryTimer !== null) clearTimeout(displayRecoveryTimer);
  displayRecoveryTimer = setTimeout(() => {
    displayRecoveryTimer = null;
    void overlayController?.recoverPlacement().catch(() => {});
  }, 250);
}

function registerOverlayDisplayRecovery() {
  for (const eventName of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(eventName, scheduleOverlayPlacementRecovery);
  }
}

function unregisterOverlayDisplayRecovery() {
  if (displayRecoveryTimer !== null) clearTimeout(displayRecoveryTimer);
  displayRecoveryTimer = null;
  for (const eventName of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.removeListener(eventName, scheduleOverlayPlacementRecovery);
  }
}

function isDevelopmentFakeAssistEnabled() {
  return !app.isPackaged && process.env.MEETING_TRANSCRIBER_FAKE_ASSIST === "1";
}

function startAssistSession(sessionId, sessionContext = null) {
  fakeAssistConsent = null;
  try {
    providerController?.startSession(sessionId);
  } catch {
    providerController = null;
  }
  try {
    assistController?.startSession(sessionId, sessionContext);
  } catch {
    assistController = null;
  }
  void refreshOverlayProviderState();
}

function endAssistSession(sessionId) {
  fakeAssistConsent = null;
  try {
    assistController?.endSession(sessionId);
  } catch {
    // Local transcription owns the authoritative stop lifecycle.
  }
  try {
    providerController?.stopSession(sessionId);
  } catch {
    // Provider cleanup cannot change local finalization.
  }
  void refreshOverlayProviderState();
}

function sendAssistEvent(event) {
  overlayController?.ingestAssistEvent(event);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("meeting:assist-event", event);
  } catch {
    // Assistance output is ephemeral. A disappearing renderer cannot affect
    // local transcription or provider cleanup.
  }
}

async function closeWindowSafely({ shouldQuit }) {
  const windowToClose = mainWindow;
  if (windowToClose && !windowToClose.isDestroyed()) {
    await waitForRendererCloseReady(windowToClose);
  }

  return finalizeCloseLifecycle({
    stopBackend: async () => {
      try {
        await backend.stopSession();
      } finally {
        endAssistSession(assistController?.getContextSnapshot()?.sessionId);
        // The renderer may be unresponsive or may have timed out before it
        // could update main-owned state. A reopened macOS window must start
        // from an unlocked lifecycle with no stale autosave ownership.
        meetingInProgress = false;
        successfulStop = false;
        lastSessionStopReason = null;
        transcriptFiles.resetCurrentAutoSavePath();
      }
    },
    shutdownBackend: () => backend.shutdown(),
    releaseWindow: () => {
      allowWindowClose = true;
      if (windowToClose && !windowToClose.isDestroyed()) windowToClose.destroy();
    },
    finishCleanly: () => {
      if (shouldQuit()) app.quit();
    },
    forceExit: (code) => app.exit(code)
  });
}

async function waitForRendererCloseReady(windowToClose) {
  await closeReadyGate.wait(() => {
    windowToClose.webContents.send("meeting:before-close");
  });
}

function configureMediaCapture() {
  const appSession = session.defaultSession;
  const allowedPermissions = new Set(["media", "display-capture"]);
  appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    webContents === mainWindow?.webContents
      && webContents.getURL() === rendererUrl
      && details.isMainFrame
      && allowedPermissions.has(permission)
      && isTrustedFileOrigin(requestingOrigin)
  ));
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = webContents === mainWindow?.webContents
      && webContents.getURL() === rendererUrl
      && isTrustedRendererPermissionRequest(permission, details, rendererUrl);
    callback(trusted);
  });

  appSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!isTrustedRendererFrame(request.frame) || !isTrustedFileOrigin(request.securityOrigin) || !request.audioRequested) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false
      });
      const primaryDisplayId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];
      if (!source || !isTrustedRendererFrame(request.frame)) {
        callback({});
        return;
      }
      if (process.platform === "win32") {
        callback({ video: source, audio: "loopback" });
      } else {
        // On macOS the native picker below owns ScreenCaptureKit system audio.
        callback({ video: source });
      }
    } catch {
      callback({});
    }
  }, { useSystemPicker: process.platform === "darwin" });
}

function registerIpc() {
  ipcMain.handle("meeting:start", async (event, options, assistSelection, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    let startTransitionBegan = false;
    try {
      if (args.length !== 0) {
        throw Object.assign(new Error("The selected meeting assistance context is invalid."), {
          code: "invalid_context_selection"
        });
      }
      if (meetingInProgress) throw new Error("A transcription session is already active.");
      if (!modelCatalog) return modelCatalogUnavailableResult();
      const setup = await backendSetup.check();
      if (setup.state !== "ready") {
        return {
          ok: false,
          error: "The local engine is not ready. Open Settings, complete the suggested setup, and check again."
        };
      }
      const sessionContext = await resolveAssistSelection(assistSelection);
      startTransitionBegan = true;
      trayController?.setState("preparing");
      overlayController?.setMeetingState("preparing");
      const engine = await backend.startSession(createBackendStartOptions(options, {
        userDataPath: app.getPath("userData"),
        catalog: modelCatalog
      }));
      meetingInProgress = true;
      overlayController?.beginSession(engine.session_id);
      startAssistSession(engine.session_id, sessionContext);
      successfulStop = false;
      lastSessionStopReason = null;
      transcriptFiles.resetCurrentAutoSavePath();
      return { ok: true, engine };
    } catch (error) {
      if (startTransitionBegan) {
        trayController?.setState("error");
        overlayController?.setMeetingState("error");
      }
      const contextError = typeof error?.code === "string"
        && (error.code.startsWith("context_pack_")
          || error.code.startsWith("meeting_profile_")
          || error.code === "invalid_meeting_profile"
          || error.code === "invalid_context_selection"
          || error.code === "invalid_context");
      return {
        ok: false,
        error: contextError
          ? contextPackPublicError(error)
          : publicError(error, "The local transcription engine could not start.")
      };
    }
  });

  ipcMain.handle("meeting:audio", async (event, packet) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      await backend.sendAudio(packet);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: publicError(error, "An audio block could not be processed.") };
    }
  });

  ipcMain.handle("meeting:cancel-start", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      return { ok: true, canceled: await backend.cancelStart() };
    } catch (error) {
      return { ok: false, error: publicError(error, "The local model startup could not be canceled normally.") };
    }
  });

  ipcMain.handle("meeting:stop", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      const hadMeeting = meetingInProgress;
      await backend.stopSession();
      endAssistSession(assistController?.getContextSnapshot()?.sessionId);
      meetingInProgress = false;
      successfulStop = hadMeeting && lastSessionStopReason === "stopped";
      overlayController?.setMeetingState("stopped");
      return {
        ok: true,
        successful: successfulStop,
        reason: lastSessionStopReason,
        message: successfulStop ? null : incompleteStopMessage(lastSessionStopReason)
      };
    } catch (error) {
      // BackendController tears down an ambiguous sidecar before rejecting. Keep
      // the desktop state retryable even when finalization itself failed.
      meetingInProgress = false;
      successfulStop = false;
      overlayController?.setMeetingState("error");
      endAssistSession(assistController?.getContextSnapshot()?.sessionId);
      return { ok: false, error: publicError(error, "The transcript could not be finalized normally.") };
    }
  });

  ipcMain.handle("meeting:copy", (event, markdown) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      clipboard.writeText(validateFinalMarkdown(markdown));
      return { ok: true };
    } catch (error) {
      return transcriptErrorResult(error, "The finalized transcript could not be copied.");
    }
  });

  ipcMain.handle("meeting:save", async (event, markdown) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      validateFinalMarkdown(markdown);
      const suggestedName = buildTranscriptFileName();
      const defaultPath = settings.transcriptDirectory
        ? path.join(settings.transcriptDirectory, suggestedName)
        : suggestedName;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save transcript copy",
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"]
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      const saved = await transcriptFiles.saveManual({ filePath: result.filePath, markdown });
      return { ok: true, canceled: false, fileName: saved.fileName };
    } catch (error) {
      return transcriptErrorResult(error, "The transcript copy could not be saved. Choose another location and try again.");
    }
  });

  ipcMain.handle("meeting:autosave", async (event, markdown) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (!successfulStop) {
      return { ok: false, error: "Automatic saving is available only after a successful stop." };
    }
    if (!settings.autoSave || !settings.transcriptDirectory) return { ok: true, skipped: true };
    try {
      const saved = await transcriptFiles.autoSave({
        directory: settings.transcriptDirectory,
        markdown
      });
      return { ok: true, skipped: false, ...saved };
    } catch (error) {
      return transcriptErrorResult(error, "The transcript could not be saved automatically.");
    }
  });

  ipcMain.handle("meeting:refresh-autosave", async (event, markdown) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (!successfulStop || !transcriptFiles.getCurrentAutoSavePath()) {
      return { ok: true, skipped: true };
    }
    try {
      const saved = await transcriptFiles.refreshAutoSave(markdown);
      return { ok: true, skipped: false, ...saved };
    } catch (error) {
      return transcriptErrorResult(error, "The saved transcript could not be refreshed after the speaker rename.");
    }
  });

  ipcMain.handle("meeting:settings-get", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (!modelCatalog) return modelCatalogUnavailableResult();
    return {
      ok: true,
      settings: getRendererSettings(),
      catalog: modelCatalog.getRendererDto()
    };
  });

  ipcMain.handle("meeting:settings-update", async (event, patch) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!modelCatalog || !settingsStore) return modelCatalogUnavailableResult();
      const safePatch = validateRendererSettingsPatch(patch, { catalog: modelCatalog });
      const { launchAtStartup, ...persistedPatch } = safePatch;
      if (Object.hasOwn(safePatch, "launchAtStartup")) {
        startupService.setEnabled(launchAtStartup);
      }
      if (Object.keys(persistedPatch).length > 0) {
        settings = await settingsStore.update(persistedPatch);
      }
      providerController?.configure({
        mode: settings.providerMode,
        model: settings.openAIModel
      });
      void refreshOverlayProviderState();
      return { ok: true, settings: getRendererSettings() };
    } catch (error) {
      return { ok: false, error: publicError(error, "Settings could not be saved.") };
    }
  });

  ipcMain.handle("meeting:settings-choose-directory", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!modelCatalog || !settingsStore) return modelCatalogUnavailableResult();
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Choose transcript folder",
        properties: ["openDirectory", "createDirectory"]
      });
      if (result.canceled || result.filePaths.length !== 1) {
        return { ok: true, canceled: true, settings: getRendererSettings() };
      }
      settings = await settingsStore.update({
        transcriptDirectory: result.filePaths[0],
        autoSave: true
      });
      return { ok: true, canceled: false, settings: getRendererSettings() };
    } catch (error) {
      return { ok: false, error: publicError(error, "The transcript folder could not be selected.") };
    }
  });

  ipcMain.handle("meeting:settings-clear-directory", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!modelCatalog || !settingsStore) return modelCatalogUnavailableResult();
      settings = await settingsStore.update({ transcriptDirectory: null, autoSave: false });
      return { ok: true, settings: getRendererSettings() };
    } catch (error) {
      return { ok: false, error: publicError(error, "The transcript folder setting could not be cleared.") };
    }
  });

  ipcMain.handle("meeting:provider-status", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      return { ok: true, provider: await getRendererProviderStatus() };
    } catch {
      return { ok: false, error: "Secure provider status could not be checked." };
    }
  });

  ipcMain.handle("meeting:provider-import-clipboard", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!providerController) return providerUnavailableResult();
      const clipboardValue = clipboard.readText("clipboard");
      await providerController.importCredential(clipboardValue.trim());
      if (clipboard.readText("clipboard") === clipboardValue) clipboard.clear("clipboard");
      const provider = await getRendererProviderStatus();
      overlayController?.setProviderStatus(provider);
      return { ok: true, provider };
    } catch (error) {
      return { ok: false, error: providerPublicError(error) };
    }
  });

  ipcMain.handle("meeting:provider-revoke", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    if (!providerController || !settingsStore) return providerUnavailableResult();
    let revokeError = null;
    try {
      await providerController.revokeCredential();
    } catch (error) {
      providerController.setMode("off");
      revokeError = error;
    }
    const runtimeOffSettings = { ...settings, providerMode: "off" };
    let settingsError = false;
    try {
      settings = await settingsStore.update({ providerMode: "off" });
    } catch {
      settings = runtimeOffSettings;
      settingsError = true;
    }
    const rendererStatus = await getRendererProviderStatus().catch(() => null);
    overlayController?.setProviderStatus(rendererStatus ?? { mode: "off" });
    const safeState = {
      settings: getRendererSettings(),
      provider: rendererStatus
    };
    if (revokeError) {
      return {
        ok: false,
        error: settingsError
          ? "Assistance is Off for this session, but the saved OpenAI API key could not be removed and the Off preference could not be saved. Restart the app and try again."
          : "Assistance is Off, but the saved OpenAI API key could not be removed. Try again.",
        ...safeState
      };
    }
    if (settingsError) {
      return {
        ok: false,
        error: "The saved OpenAI API key was removed and assistance is Off for this session, but the Off preference could not be saved. Restart the app and verify Settings.",
        ...safeState
      };
    }
    if (!rendererStatus) {
      return {
        ok: false,
        error: "The saved OpenAI API key was removed and assistance is Off, but secure provider status could not be refreshed.",
        ...safeState
      };
    }
    return {
      ok: true,
      ...safeState
    };
  });

  ipcMain.handle("meeting:provider-open-link", async (event, linkId) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      await shell.openExternal(resolveProviderExternalLink(linkId));
      return { ok: true };
    } catch {
      return { ok: false, error: "The provider information page could not be opened." };
    }
  });

  ipcMain.handle("meeting:assist-library", async (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    try {
      return { ok: true, library: await getRendererAssistLibrary() };
    } catch (error) {
      return { ok: false, error: contextPackPublicError(error) };
    }
  });

  ipcMain.handle("meeting:context-pack-create", async (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!contextPackStore) throw Object.assign(new Error(), { code: "secure_storage_unavailable" });
      await contextPackStore.create(value);
      return { ok: true, library: await getRendererAssistLibrary() };
    } catch (error) {
      return { ok: false, error: contextPackPublicError(error) };
    }
  });

  ipcMain.handle("meeting:context-pack-update", async (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!contextPackStore) throw Object.assign(new Error(), { code: "secure_storage_unavailable" });
      await contextPackStore.update(value);
      return { ok: true, library: await getRendererAssistLibrary() };
    } catch (error) {
      return { ok: false, error: contextPackPublicError(error) };
    }
  });

  ipcMain.handle("meeting:context-pack-delete", async (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!contextPackStore) throw Object.assign(new Error(), { code: "secure_storage_unavailable" });
      await contextPackStore.delete(value);
      return { ok: true, library: await getRendererAssistLibrary() };
    } catch (error) {
      return { ok: false, error: contextPackPublicError(error) };
    }
  });

  ipcMain.handle("meeting:assist-status", async (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    try {
      const assist = await getRendererAssistStatus();
      overlayController?.setProviderStatus(assist.provider);
      return { ok: true, assist };
    } catch {
      return { ok: false, error: "Meeting assistance status could not be checked." };
    }
  });

  ipcMain.handle("meeting:assist-context", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    return {
      ok: true,
      context: buildRendererAssistContext(assistController?.freezeContextForRequest() ?? null)
    };
  });

  ipcMain.handle("meeting:assist-consent", async (event, enabled, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0 || typeof enabled !== "boolean") return invalidAssistRequestResult();
    try {
      const snapshot = assistController?.getContextSnapshot();
      if (!enabled) {
        fakeAssistConsent = null;
        providerController?.revokeConsent();
      } else {
        if (!snapshot) {
          return { ok: false, error: "Start a meeting before approving assistance." };
        }
        if (isDevelopmentFakeAssistEnabled()) {
          fakeAssistConsent = Object.freeze({
            sessionId: snapshot.sessionId,
            disclosureVersion: PROVIDER_DISCLOSURE_VERSION
          });
        } else {
          if (!providerController) return providerUnavailableResult();
          providerController.grantConsent({
            sessionId: snapshot.sessionId,
            disclosureVersion: PROVIDER_DISCLOSURE_VERSION
          });
        }
      }
      const assist = await getRendererAssistStatus();
      overlayController?.setProviderStatus(assist.provider);
      return { ok: true, assist };
    } catch (error) {
      return { ok: false, error: assistConsentError(error) };
    }
  });

  ipcMain.handle("meeting:assist-request", async (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    try {
      if (!assistController) return providerUnavailableResult();
      const request = normalizeRendererAssistRequest(value);
      const snapshot = assistController.getContextSnapshot();
      if (!snapshot || snapshot.segments.length === 0) {
        return { ok: false, error: "Wait for finalized transcript text before requesting assistance." };
      }
      if (isDevelopmentFakeAssistEnabled()
        && (fakeAssistConsent?.sessionId !== snapshot.sessionId
          || fakeAssistConsent?.disclosureVersion !== PROVIDER_DISCLOSURE_VERSION)) {
        return { ok: false, error: "Approve data sharing for this meeting before requesting assistance." };
      }
      const result = await assistController.request(request);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: assistRequestError(error) };
    }
  });

  ipcMain.handle("meeting:assist-cancel", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidAssistRequestResult();
    return { ok: true, canceled: Boolean(assistController?.cancel("canceled")) };
  });

  ipcMain.handle("meeting:overlay-status", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!overlayController) return overlayUnavailableResult();
    return { ok: true, status: overlayController.getStatus() };
  });

  ipcMain.handle("meeting:overlay-show", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!overlayController) return overlayUnavailableResult();
    return { ok: true, status: overlayController.show({ focus: true }) };
  });

  ipcMain.handle("meeting:overlay-hide", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!overlayController) return overlayUnavailableResult();
    return { ok: true, status: overlayController.hide() };
  });

  ipcMain.handle("meeting:overlay-settings-update", async (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0 || !overlayController) {
      return overlayController ? invalidOverlayRequestResult() : overlayUnavailableResult();
    }
    try {
      return { ok: true, status: await overlayController.updateSettings(value) };
    } catch (error) {
      return overlayErrorResult(error);
    }
  });

  ipcMain.handle("meeting:overlay-private-acknowledge", (event, value, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0 || !overlayController) {
      return overlayController ? invalidOverlayRequestResult() : overlayUnavailableResult();
    }
    try {
      return { ok: true, ...overlayController.acknowledgePrivateMode(value) };
    } catch (error) {
      return overlayErrorResult(error);
    }
  });

  ipcMain.handle("meeting:overlay-reset", async (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!overlayController) return overlayUnavailableResult();
    try {
      return { ok: true, status: await overlayController.reset() };
    } catch (error) {
      return overlayErrorResult(error);
    }
  });

  ipcMain.handle("meeting:overlay-shortcuts-retry", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!shortcutRegistry) return overlayUnavailableResult();
    return { ok: true, status: updateShortcutStatus(shortcutRegistry.retryUnavailable()) };
  });

  ipcMain.handle("meeting:overlay-shortcuts-reset", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!shortcutRegistry) return overlayUnavailableResult();
    return { ok: true, status: updateShortcutStatus(shortcutRegistry.reset()) };
  });

  ipcMain.handle("meeting:overlay-click-through-toggle", (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    if (!overlayController) return overlayUnavailableResult();
    try {
      return { ok: true, status: overlayController.toggleClickThrough() };
    } catch (error) {
      return overlayErrorResult(error);
    }
  });

  ipcMain.handle("overlay:status", (event, ...args) => {
    if (!isTrustedOverlayIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    return { ok: true, status: overlayController.getStatus() };
  });

  ipcMain.handle("overlay:show-workspace", (event, ...args) => {
    if (!isTrustedOverlayIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    return { ok: true, ...overlayController.showMainWorkspace() };
  });

  ipcMain.handle("overlay:focus-assist", (event, ...args) => {
    if (!isTrustedOverlayIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    return { ok: true, ...overlayController.focusMainAssist() };
  });

  ipcMain.handle("overlay:hide", (event, ...args) => {
    if (!isTrustedOverlayIpcEvent(event)) return unauthorizedResult();
    if (args.length !== 0) return invalidOverlayRequestResult();
    return { ok: true, status: overlayController.hide() };
  });

  ipcMain.handle("meeting:platform", (event) => {
    if (!isTrustedIpcEvent(event)) {
      return { platform: "unknown", systemAudioSupported: false, systemAudioRequirement: "Invalid local renderer." };
    }
    const systemVersion = process.getSystemVersion();
    const systemAudioSupported = supportsSystemAudio(process.platform, systemVersion);
    return {
      platform: process.platform,
      systemAudioSupported,
      startupSupported: startupService?.supported === true,
      trayLocation: process.platform === "darwin" ? "menu bar" : "notification area",
      systemAudioRequirement: !systemAudioSupported
        ? process.platform === "darwin"
          ? "Meeting audio requires macOS 15 or later."
          : "Meeting audio is available on Windows and macOS."
        : null
    };
  });

  ipcMain.handle("meeting:engine-prerequisites", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    const setup = await backendSetup.check({ force: true });
    return {
      ok: true,
      setup: {
        state: setup.state,
        python: {
          version: setup.pythonVersion,
          minimum: "3.12",
          supportedSeries: "3.12.x"
        },
        components: { ...setup.components },
        sourceSetupAvailable: !app.isPackaged,
        platform: process.platform
      }
    };
  });

  ipcMain.handle("meeting:open-python-download", async (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      await shell.openExternal(PYTHON_DOWNLOAD_URL);
      return { ok: true };
    } catch {
      return { ok: false, error: "The official Python download page could not be opened." };
    }
  });

  ipcMain.handle("meeting:copy-bootstrap-command", (event) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (app.isPackaged) {
      return { ok: false, error: "The source bootstrap command is not available in this installed build." };
    }
    clipboard.writeText(BOOTSTRAP_COMMAND);
    return { ok: true };
  });

  ipcMain.on("meeting:close-ready", (event) => {
    if (isTrustedIpcEvent(event)) closeReadyGate.notify();
  });

  ipcMain.on("meeting:tray-state", (event, value) => {
    if (!isTrustedIpcEvent(event)) return;
    const trayState = validateTrayStateDto(value);
    if (!trayState) return;
    trayController?.setState(trayState.state);
    const overlayState = trayState.state === "idle" ? "ready" : trayState.state;
    overlayController?.setMeetingState(overlayState, {
      reveal: trayState.state === "transcribing"
    });
  });
}

function getRendererSettings() {
  return {
    ...settings,
    launchAtStartup: startupService?.isEnabled() === true
  };
}

async function getRendererProviderStatus() {
  if (!providerController) throw new Error("provider_unavailable");
  const status = await providerController.getStatus();
  if (!["absent", "configured", "invalid", "unreadable"].includes(status.credentialState)) {
    throw new Error("provider_status_invalid");
  }
  return {
    mode: status.mode,
    model: status.model,
    configured: status.configured,
    credentialState: status.credentialState,
    removable: status.removable,
    encryptionAvailable: status.encryptionAvailable,
    consentGranted: status.consentGranted,
    inFlight: status.inFlight,
    catalog: {
      modes: status.catalog.modes,
      openAIModels: status.catalog.openAIModels
    },
    disclosure: status.disclosure
  };
}

async function getRendererAssistStatus() {
  const fakeAssistEnabled = isDevelopmentFakeAssistEnabled();
  const hostedProvider = fakeAssistEnabled ? null : await getRendererProviderStatus();
  // Capture the context only after the awaited provider read. JavaScript then
  // assembles one coherent session/revision/provider DTO without a transition
  // interleaving between the snapshot and return value.
  const snapshot = assistController?.getContextSnapshot() ?? null;
  const requestSnapshot = assistController?.getRequestContextSnapshot() ?? null;
  const provider = fakeAssistEnabled
    ? {
        mode: "openai",
        model: "development-fake",
        configured: true,
        credentialState: "configured",
        removable: false,
        encryptionAvailable: true,
        consentGranted: Boolean(
          snapshot
            && fakeAssistConsent?.sessionId === snapshot.sessionId
            && fakeAssistConsent?.disclosureVersion === PROVIDER_DISCLOSURE_VERSION
        ),
        inFlight: assistController?.inFlight !== null,
        disclosure: PROVIDER_DISCLOSURE,
        fake: true
      }
    : {
        ...hostedProvider,
        inFlight: assistController?.inFlight !== null,
        fake: false
      };
  return {
    sessionId: snapshot?.sessionId ?? null,
    contextRevision: snapshot?.revision ?? 0,
    contextSummary: buildAssistContextSummary(snapshot),
    sessionContext: assistController?.getSessionContextSummary() ?? null,
    requestPreview: buildRendererRequestPreview(requestSnapshot),
    provider
  };
}

function buildAssistContextSummary(snapshot) {
  if (!snapshot || snapshot.segments.length === 0) return null;
  return Object.freeze({
    segmentCount: snapshot.segments.length,
    transcriptChars: snapshot.transcriptChars,
    startMs: snapshot.segments[0]?.start_ms ?? null,
    endMs: snapshot.segments.at(-1)?.end_ms ?? null
  });
}

function buildRendererRequestPreview(snapshot) {
  if (!snapshot) return null;
  try {
    return buildProviderContextPreview(snapshot);
  } catch (error) {
    if (error?.code === "provider_context_too_large") {
      return Object.freeze({ blocked: true, reason: "The selected meeting context is too large to send safely." });
    }
    return Object.freeze({ blocked: true, reason: "The selected meeting context could not be prepared." });
  }
}

function buildRendererAssistContext(snapshot) {
  if (!snapshot) return null;
  return Object.freeze({
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    transcriptChars: snapshot.transcriptChars,
    segments: snapshot.segments,
    sessionContext: assistController?.getSessionContextSummary() ?? null,
    requestPreview: buildRendererRequestPreview(snapshot)
  });
}

async function getRendererAssistLibrary() {
  const profiles = getMeetingProfileCatalogDto();
  if (!contextPackStore) {
    return Object.freeze({
      profiles,
      secureStorageAvailable: false,
      contextPacksAvailable: false,
      contextPacks: Object.freeze([])
    });
  }
  const secureStorageAvailable = await contextPackStore.encryptionAvailable();
  if (!secureStorageAvailable) {
    return Object.freeze({
      profiles,
      secureStorageAvailable: false,
      contextPacksAvailable: false,
      contextPacks: Object.freeze([])
    });
  }
  try {
    return Object.freeze({
      profiles,
      secureStorageAvailable: true,
      contextPacksAvailable: true,
      contextPacks: await contextPackStore.list()
    });
  } catch {
    // Private context is optional. Keep the immutable profile catalog and local
    // transcription usable, while leaving the unreadable store untouched and
    // disabling every pack mutation in the renderer.
    return Object.freeze({
      profiles,
      secureStorageAvailable: true,
      contextPacksAvailable: false,
      contextPacks: Object.freeze([])
    });
  }
}

async function resolveAssistSelection(value) {
  const input = value ?? {
    profile: { profileId: DEFAULT_MEETING_PROFILE_ID, profileVersion: 1 },
    contextPacks: []
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("The selected meeting assistance context is invalid."), {
      code: "invalid_context_selection"
    });
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "contextPacks" || keys[1] !== "profile") {
    throw Object.assign(new Error("The selected meeting assistance context is invalid."), {
      code: "invalid_context_selection"
    });
  }
  const selection = normalizeMeetingProfileSelection(input.profile);
  if (!Array.isArray(input.contextPacks)) {
    throw Object.assign(new Error("The selected meeting assistance context is invalid."), {
      code: "invalid_context_selection"
    });
  }
  const profile = getMeetingProfile(selection.profileId, selection.profileVersion);
  const contextPacks = input.contextPacks.length === 0
    ? Object.freeze([])
    : await contextPackStore?.resolveSelection(input.contextPacks);
  if (!contextPacks) {
    throw new Error("Secure meeting-context storage is unavailable on this computer.");
  }
  return createAssistSessionContext({ profile, contextPacks });
}

function contextPackPublicError(error) {
  const messages = new Map([
    ["invalid_meeting_profile", "The selected meeting profile is invalid."],
    ["meeting_profile_not_found", "The selected meeting profile is unavailable."],
    ["meeting_profile_version_mismatch", "The selected meeting profile version is unavailable."],
    ["secure_storage_unavailable", "Secure meeting-context storage is unavailable on this computer."],
    ["invalid_context_pack", "The meeting context pack is invalid."],
    ["invalid_context_selection", "The selected meeting context is invalid."],
    ["context_pack_limit_exceeded", "Saved meeting context exceeds the local storage limit."],
    ["context_pack_not_found", "The selected meeting context pack no longer exists."],
    ["context_pack_revision_conflict", "The meeting context pack changed. Review the latest version before continuing."],
    ["context_pack_corrupt", "Saved meeting context is invalid and was not changed."],
    ["context_pack_decryption_failed", "Saved meeting context could not be unlocked."],
    ["context_pack_read_failed", "Saved meeting context could not be read."],
    ["context_pack_write_failed", "Meeting context could not be stored securely."],
    ["context_pack_encryption_failed", "Meeting context could not be encrypted."]
  ]);
  return messages.get(error?.code) ?? "Meeting context could not be changed.";
}

function isTrustedRendererFrame(frame) {
  return Boolean(
    mainWindow
      && !mainWindow.isDestroyed()
      && isExactRendererFrame(frame, mainWindow.webContents.mainFrame, rendererUrl)
  );
}

function isTrustedIpcEvent(event) {
  return Boolean(
    mainWindow
      && !mainWindow.isDestroyed()
      && isExactRendererIpcEvent(event, mainWindow.webContents, rendererUrl)
  );
}

function isTrustedOverlayIpcEvent(event) {
  return overlayController?.isTrustedEvent(event) === true;
}

function settingsAreLocked() {
  return meetingInProgress || ["starting", "stopping"].includes(backend.sessionState);
}

function settingsLockedResult() {
  return { ok: false, error: "Stop the meeting before changing settings." };
}

function modelCatalogUnavailableResult() {
  return { ok: false, error: "Model catalog unavailable." };
}

function providerUnavailableResult() {
  return { ok: false, error: "Secure provider settings are unavailable." };
}

function providerPublicError(error) {
  const messages = new Map([
    ["invalid_credential", "Copy a valid OpenAI API key, then try importing again."],
    ["credential_cleanup_required", "Remove the saved OpenAI API key before importing another key."],
    ["secure_storage_unavailable", "Secure credential storage is unavailable on this computer."],
    ["credential_encryption_failed", "The OpenAI API key could not be stored securely."],
    ["credential_write_failed", "The OpenAI API key could not be stored securely."],
    ["credential_revoke_failed", "The saved OpenAI API key could not be removed."],
    ["credential_read_failed", "The saved OpenAI API key could not be read."],
    ["credential_corrupt", "The saved OpenAI API key is invalid. Remove it and add it again."]
  ]);
  return messages.get(error?.code) ?? "Secure provider settings could not be updated.";
}

function assistConsentError(error) {
  const messages = new Map([
    ["provider_off", "Turn on OpenAI assistance in Settings before continuing."],
    ["provider_unavailable", "The selected assistance provider is unavailable."],
    ["invalid_session", "The assistance consent does not belong to the active meeting."],
    ["consent_version_mismatch", "Review the current data-sharing disclosure before continuing."]
  ]);
  return messages.get(error?.code) ?? "The assistance consent could not be saved for this meeting.";
}

function assistRequestError(error) {
  const messages = new Map([
    ["assist_session_inactive", "Start a meeting before requesting assistance."],
    ["assist_busy", "Wait for the current assistance request to finish canceling."],
    ["assist_context_not_frozen", "Finalized context could not be frozen for this request."],
    ["assist_context_empty", "Wait for finalized transcript text before requesting assistance."],
    ["invalid_assist_request", "Enter a valid assistance question."],
    ["unexpected_assist_field", "The assistance request contains an unsupported field."],
    ["invalid_question", "Enter a valid assistance question."],
    ["question_too_large", "The assistance question is too long."]
  ]);
  return messages.get(error?.code) ?? "Assistance could not be started. Local transcription continues normally.";
}

function invalidAssistRequestResult() {
  return { ok: false, error: "The assistance request contains an unsupported field." };
}

function invalidOverlayRequestResult() {
  return { ok: false, error: "The companion request contains an unsupported field." };
}

function overlayUnavailableResult() {
  return { ok: false, error: "The companion overlay is unavailable." };
}

function overlayErrorResult(error) {
  const messages = new Map([
    ["overlay_acknowledgement_required", "Review and acknowledge the private-mode disclosure before enabling it."],
    ["overlay_disclosure_mismatch", "Review and acknowledge the current private-mode disclosure before continuing."],
    ["overlay_recovery_unavailable", "Click-through requires the Show or hide overlay recovery shortcut."]
  ]);
  const known = error instanceof OverlayControllerError ? messages.get(error.code) : null;
  return { ok: false, error: known ?? "The companion setting could not be changed." };
}

function transcriptErrorResult(error, fallback) {
  const message = error instanceof TranscriptFileError
    ? error.publicMessage
    : publicError(error, fallback);
  return { ok: false, error: message };
}

function unauthorizedResult() {
  return { ok: false, error: "Unauthorized local request." };
}

function publicError(error, fallback) {
  if (!(error instanceof Error)) return fallback;
  return PUBLIC_ERROR_MESSAGES.has(error.message) ? error.message : fallback;
}

function incompleteStopMessage(reason) {
  if (reason === "final_inference_failed") {
    return "At least one final segment could not be transcribed. Automatic saving was skipped. Review the visible text; Save copy exports completed segments only.";
  }
  if (reason === "inference_backpressure") {
    return "The local transcription buffer filled before finalization. Automatic saving was skipped. Review the visible text; Save copy exports completed segments only.";
  }
  return "The transcript did not finalize completely. Automatic saving was skipped. Review the visible text; Save copy exports completed segments only.";
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("com.luchdom.meetingtranscriber");
    startupService = createStartupService({
      electronApp: app,
      platform: process.platform,
      isPackaged: app.isPackaged
    });
    if (startupService.wasOpenedAtLogin()) hideNextWindowOnReady = true;
    try {
      modelCatalog = await loadModelCatalog({ manifestPath: modelManifestPath });
    } catch {
      modelCatalog = null;
    }
    if (modelCatalog) {
      settingsStore = createSettingsStore({
        userDataPath: app.getPath("userData"),
        catalog: modelCatalog
      });
      try {
        settings = await settingsStore.load();
      } catch {
        settings = { ...DEFAULT_SETTINGS };
      }
    }
    try {
      createAssistLibraryBoundary();
    } catch {
      // Private context is optional. The renderer reports secure storage as
      // unavailable while transcription and profile-only assistance continue.
      contextPackStore = null;
    }
    try {
      createProviderBoundary();
    } catch {
      // Hosted assistance is optional and must never prevent the local
      // transcription application from starting.
      providerController = null;
    }
    try {
      createAssistBoundary();
    } catch {
      // Assistance, including its development fake, is optional and must not
      // prevent local transcription from starting.
      assistController = null;
    }
    try {
      await createOverlayBoundary();
      registerOverlayDisplayRecovery();
    } catch {
      overlayController?.destroy();
      overlayController = null;
      overlaySettingsStore = null;
    }
    registerIpc();
    configureMediaCapture();
    createApplicationTray();
    try {
      createShortcutBoundary();
    } catch {
      shortcutRegistry?.destroy();
      shortcutRegistry = null;
    }
    desktopBootstrapReady = true;
    createWindow();
    app.on("activate", () => showMainWindow());
  });

  app.on("window-all-closed", () => {
    if (quitRequested || process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    quitRequested = true;
    if (!mainWindow || allowWindowClose) return;
    event.preventDefault();
    void closeCoordinator.request({ quit: true });
  });

  app.on("will-quit", () => {
    unregisterOverlayDisplayRecovery();
    shortcutRegistry?.destroy();
    shortcutRegistry = null;
    assistController?.cancel("session_reset");
    providerController?.cancelRequest();
    overlayController?.destroy();
    overlayController = null;
    trayController?.destroy();
    trayController = null;
  });
}
