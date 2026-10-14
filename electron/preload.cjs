const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('debate', {
  getRuntimeConfig: () => ipcRenderer.invoke('debate:get-runtime-config'),
})