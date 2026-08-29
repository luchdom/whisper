import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
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
import { ProviderController } from "./provider-controller.js";
import { createProviderCredentialStore } from "./provider-credential-store.js";
import { resolveProviderExternalLink } from "./provider-policy.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..", "..");
const rendererEntry = path.join(projectRoot, "desktop", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererEntry).href;
const preloadEntry = path.join(projectRoot, "desktop", "preload", "index.cjs");
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

function showMainWindow({ focusStart = false } = {}) {
  if (!desktopBootstrapReady) {
    queueWindowShow({ focusStart });
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoadingMainFrame()) {
    queueWindowShow({ focusStart });
    return;
  }
  revealMainWindow({ focusStart });
}

function revealMainWindow({ focusStart = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!focusStart) return;
  const signalFocus = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("meeting:tray-action", "focus-start");
    }
  };
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", signalFocus);
  } else {
    signalFocus();
  }
}

function queueWindowShow({ focusStart = false } = {}) {
  pendingWindowShow = {
    focusStart: focusStart || pendingWindowShow?.focusStart === true
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
  ipcMain.handle("meeting:start", async (event, options) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    try {
      if (meetingInProgress) throw new Error("A transcription session is already active.");
      if (!modelCatalog) return modelCatalogUnavailableResult();
      const setup = await backendSetup.check();
      if (setup.state !== "ready") {
        return {
          ok: false,
          error: "The local engine is not ready. Open Settings, complete the suggested setup, and check again."
        };
      }
      trayController?.setState("preparing");
      const engine = await backend.startSession(createBackendStartOptions(options, {
        userDataPath: app.getPath("userData"),
        catalog: modelCatalog
      }));
      meetingInProgress = true;
      successfulStop = false;
      lastSessionStopReason = null;
      transcriptFiles.resetCurrentAutoSavePath();
      return { ok: true, engine };
    } catch (error) {
      trayController?.setState("error");
      return { ok: false, error: publicError(error, "The local transcription engine could not start.") };
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
      meetingInProgress = false;
      successfulStop = hadMeeting && lastSessionStopReason === "stopped";
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
      return { ok: true, provider: await getRendererProviderStatus() };
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
    if (trayState) trayController?.setState(trayState.state);
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
    catalog: {
      modes: status.catalog.modes,
      openAIModels: status.catalog.openAIModels
    },
    disclosure: status.disclosure
  };
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
      createProviderBoundary();
    } catch {
      // Hosted assistance is optional and must never prevent the local
      // transcription application from starting.
      providerController = null;
    }
    registerIpc();
    configureMediaCapture();
    createApplicationTray();
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
    providerController?.cancelRequest();
    trayController?.destroy();
    trayController = null;
  });
}
