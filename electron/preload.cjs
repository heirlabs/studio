const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokStudioNative", {
  isNative: true,
  platform: process.platform,
  openImages: () => ipcRenderer.invoke("studio:open-images"),
  openProject: () => ipcRenderer.invoke("studio:open-project"),
  revealPath: (p) => ipcRenderer.invoke("studio:reveal-path", p),
  revealOutputs: () => ipcRenderer.invoke("studio:reveal-outputs"),
  getInfo: () => ipcRenderer.invoke("studio:get-info"),
  importPaths: (paths) => ipcRenderer.invoke("studio:import-paths", paths),
  notify: (payload) => ipcRenderer.invoke("studio:notify", payload),
  onImagesImported: (cb) => {
    const handler = (_event, files) => cb(files);
    ipcRenderer.on("studio:images-imported", handler);
    return () => ipcRenderer.removeListener("studio:images-imported", handler);
  },
  onProjectOpened: (cb) => {
    const handler = (_event, dir) => cb(dir);
    ipcRenderer.on("studio:project-opened", handler);
    return () => ipcRenderer.removeListener("studio:project-opened", handler);
  },
  onNotification: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("studio:notification", handler);
    return () => ipcRenderer.removeListener("studio:notification", handler);
  },
});
