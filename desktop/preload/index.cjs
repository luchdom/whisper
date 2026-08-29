const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const TRAY_ACTIONS = new Set(["focus-start", "stop"]);
const PROVIDER_LINKS = new Set(["privacy", "data-controls", "usage"]);

contextBridge.exposeInMainWorld("meeting", Object.freeze({
  start: (options, assistSelection) => ipcRenderer.invoke("meeting:start", options, assistSelection),
  sendAudio: ({ track, startMs, endMs, pcm }) => {
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    const isolated = bytes.slice();
    return ipcRenderer.invoke("meeting:audio", { track, startMs, endMs, pcm: isolated });
  },
  cancelStart: () => ipcRenderer.invoke("meeting:cancel-start"),
  stop: () => ipcRenderer.invoke("meeting:stop"),
  generateLocalDebrief: () => ipcRenderer.invoke("meeting:debrief-generate"),
  copyDebrief: (markdown) => ipcRenderer.invoke("meeting:debrief-copy", markdown),
  saveDebrief: (markdown) => ipcRenderer.invoke("meeting:debrief-save", markdown),
  clearLocalDebrief: () => ipcRenderer.invoke("meeting:debrief-clear"),
  copy: (markdown) => ipcRenderer.invoke("meeting:copy", markdown),
  saveCopy: (markdown) => ipcRenderer.invoke("meeting:save", markdown),
  autoSave: (markdown) => ipcRenderer.invoke("meeting:autosave", markdown),
  refreshAutoSave: (markdown) => ipcRenderer.invoke("meeting:refresh-autosave", markdown),
  getSettings: () => ipcRenderer.invoke("meeting:settings-get"),
  updateSettings: (patch) => ipcRenderer.invoke("meeting:settings-update", patch),
  chooseTranscriptFolder: () => ipcRenderer.invoke("meeting:settings-choose-directory"),
  clearTranscriptFolder: () => ipcRenderer.invoke("meeting:settings-clear-directory"),
  getProviderStatus: () => ipcRenderer.invoke("meeting:provider-status"),
  importProviderCredential: () => ipcRenderer.invoke("meeting:provider-import-clipboard"),
  revokeProviderCredential: () => ipcRenderer.invoke("meeting:provider-revoke"),
  openProviderLink: (linkId) => PROVIDER_LINKS.has(linkId)
    ? ipcRenderer.invoke("meeting:provider-open-link", linkId)
    : Promise.resolve({ ok: false, error: "Invalid provider link." }),
  getAssistLibrary: () => ipcRenderer.invoke("meeting:assist-library"),
  createContextPack: ({ kind, name, content }) => ipcRenderer.invoke(
    "meeting:context-pack-create",
    { kind, name, content }
  ),
  updateContextPack: ({ id, revision, kind, name, content }) => ipcRenderer.invoke(
    "meeting:context-pack-update",
    { id, revision, kind, name, content }
  ),
  deleteContextPack: ({ id, revision }) => ipcRenderer.invoke(
    "meeting:context-pack-delete",
    { id, revision }
  ),
  getAssistStatus: () => ipcRenderer.invoke("meeting:assist-status"),
  getAssistContext: () => ipcRenderer.invoke("meeting:assist-context"),
  setAssistConsent: (enabled) => ipcRenderer.invoke("meeting:assist-consent", enabled === true),
  requestAssist: ({ question }) => ipcRenderer.invoke("meeting:assist-request", { question }),
  cancelAssist: () => ipcRenderer.invoke("meeting:assist-cancel"),
  getOverlayStatus: () => ipcRenderer.invoke("meeting:overlay-status"),
  showOverlay: () => ipcRenderer.invoke("meeting:overlay-show"),
  hideOverlay: () => ipcRenderer.invoke("meeting:overlay-hide"),
  updateOverlaySettings: (patch) => ipcRenderer.invoke("meeting:overlay-settings-update", patch),
  acknowledgeOverlayPrivateMode: ({ version }) => ipcRenderer.invoke(
    "meeting:overlay-private-acknowledge",
    { acknowledged: true, version }
  ),
  resetOverlay: () => ipcRenderer.invoke("meeting:overlay-reset"),
  retryOverlayShortcuts: () => ipcRenderer.invoke("meeting:overlay-shortcuts-retry"),
  resetOverlayShortcuts: () => ipcRenderer.invoke("meeting:overlay-shortcuts-reset"),
  toggleOverlayClickThrough: () => ipcRenderer.invoke("meeting:overlay-click-through-toggle"),
  getPlatform: () => ipcRenderer.invoke("meeting:platform"),
  getEnginePrerequisites: () => ipcRenderer.invoke("meeting:engine-prerequisites"),
  openPythonDownloadPage: () => ipcRenderer.invoke("meeting:open-python-download"),
  copyBootstrapCommand: () => ipcRenderer.invoke("meeting:copy-bootstrap-command"),
  reportTrayState: ({ state }) => ipcRenderer.send("meeting:tray-state", { state }),
  onTrayAction: (listener) => on("meeting:tray-action", (action) => {
    if (TRAY_ACTIONS.has(action)) listener(action);
  }),
  onBackendEvent: (listener) => on("meeting:backend-event", listener),
  onAssistEvent: (listener) => on("meeting:assist-event", listener),
  onAssistShortcut: (listener) => on("meeting:assist-shortcut", () => listener()),
  onAssistPrefill: (listener) => on("meeting:assist-prefill", (value) => listener(value)),
  onOverlayStatus: (listener) => on("meeting:overlay-status", listener),
  onBeforeClose: (listener) => on("meeting:before-close", listener),
  notifyCloseReady: () => ipcRenderer.send("meeting:close-ready")
}));
