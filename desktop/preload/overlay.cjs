const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("overlay", Object.freeze({
  getStatus: () => ipcRenderer.invoke("overlay:status"),
  showWorkspace: () => ipcRenderer.invoke("overlay:show-workspace"),
  focusCopilot: () => ipcRenderer.invoke("overlay:focus-assist"),
  hide: () => ipcRenderer.invoke("overlay:hide"),
  onStatus: (listener) => on("overlay:status", listener)
}));
