import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, screen, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendController, STOP_TIMEOUT_MS } from "./backend-controller.js";
import { BackendSetupManager } from "./backend-setup.js";
import { createCloseCoordinator, createCloseReadyGate, finalizeCloseLifecycle } from "./close-lifecycle.js";
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

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..", "..");
const rendererEntry = path.join(projectRoot, "desktop", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererEntry).href;
const preloadEntry = path.join(projectRoot, "desktop", "preload", "index.cjs");
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
  "Transcription settings are invalid.",
  "Transcription settings contain an unsupported field."
]);

let mainWindow = null;
let allowWindowClose = false;
let settingsStore = null;
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
  allowWindowClose = false;
  mainWindow = new BrowserWindow({
    width: 1_000,
    height: 700,
    minWidth: 820,
    minHeight: 600,
    show: false,
    title: "Meeting Transcriber",
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

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void closeCoordinator.request();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererEntry);
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
      settings: { ...settings },
      catalog: modelCatalog.getRendererDto()
    };
  });

  ipcMain.handle("meeting:settings-update", async (event, patch) => {
    if (!isTrustedIpcEvent(event)) return unauthorizedResult();
    if (settingsAreLocked()) return settingsLockedResult();
    try {
      if (!modelCatalog || !settingsStore) return modelCatalogUnavailableResult();
      const safePatch = validateRendererSettingsPatch(patch, { catalog: modelCatalog });
      settings = await settingsStore.update(safePatch);
      return { ok: true, settings: { ...settings } };
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
        return { ok: true, canceled: true, settings: { ...settings } };
      }
      settings = await settingsStore.update({
        transcriptDirectory: result.filePaths[0],
        autoSave: true
      });
      return { ok: true, canceled: false, settings: { ...settings } };
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
      return { ok: true, settings: { ...settings } };
    } catch (error) {
      return { ok: false, error: publicError(error, "The transcript folder setting could not be cleared.") };
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

app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId("com.luchdom.meetingtranscriber");
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
  registerIpc();
  configureMediaCapture();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!mainWindow || allowWindowClose) return;
  event.preventDefault();
  void closeCoordinator.request({ quit: true });
});
