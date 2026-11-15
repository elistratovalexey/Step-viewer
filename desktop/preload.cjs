const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openModel: () => ipcRenderer.invoke('model:open'),
  openPath: (p) => ipcRenderer.invoke('model:openPath', p),
  saveText: (name, text, filters) => ipcRenderer.invoke('file:saveText', name, text, filters),
  saveBinary: (name, b64, filters) => ipcRenderer.invoke('file:saveBinary', name, b64, filters),
  readText: () => ipcRenderer.invoke('file:readText'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  info: () => ipcRenderer.invoke('app:info'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },
  onMenu: (cb) => ipcRenderer.on('menu', (_e, id) => cb(id))
});
