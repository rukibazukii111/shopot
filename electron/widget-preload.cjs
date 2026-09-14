const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('dictationWidget', {
  boot: () => ipcRenderer.invoke('widget-boot'),
  action: action => ipcRenderer.send('widget-action', action),
  onState: callback => ipcRenderer.on('widget-state', (_, state) => callback(state)),
});
