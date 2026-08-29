const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("meeting", Object.freeze({
  start: (options) => ipcRenderer.invoke("meeting:start", options),
  sendAudio: ({ track, startMs, endMs, pcm }) => {
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    const isolated = bytes.slice();
    return ipcRenderer.invoke("meeting:audio", { track, startMs, endMs, pcm: isolated });
  },
  cancelStart: () => ipcRenderer.invoke("meeting:cancel-start"),
  stop: () => ipcRenderer.invoke("meeting:stop"),
  copy: (markdown) => ipcRenderer.invoke("meeting:copy", markdown),
  saveCopy: (markdown) => ipcRenderer.invoke("meeting:save", markdown),
  autoSave: (markdown) => ipcRenderer.invoke("meeting:autosave", markdown),
  refreshAutoSave: (markdown) => ipcRenderer.invoke("meeting:refresh-autosave", markdown),
  getSettings: () => ipcRenderer.invoke("meeting:settings-get"),
  updateSettings: (patch) => ipcRenderer.invoke("meeting:settings-update", patch),
  chooseTranscriptFolder: () => ipcRenderer.invoke("meeting:settings-choose-directory"),
  clearTranscriptFolder: () => ipcRenderer.invoke("meeting:settings-clear-directory"),
  getPlatform: () => ipcRenderer.invoke("meeting:platform"),
  getEnginePrerequisites: () => ipcRenderer.invoke("meeting:engine-prerequisites"),
  openPythonDownloadPage: () => ipcRenderer.invoke("meeting:open-python-download"),
  copyBootstrapCommand: () => ipcRenderer.invoke("meeting:copy-bootstrap-command"),
  onBackendEvent: (listener) => on("meeting:backend-event", listener),
  onBeforeClose: (listener) => on("meeting:before-close", listener),
  notifyCloseReady: () => ipcRenderer.send("meeting:close-ready")
}));
