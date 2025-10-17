const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  pickCSV: () => ipcRenderer.invoke('pick-csv'),
  convertAll: (params) => ipcRenderer.invoke('convert-all', params),
});