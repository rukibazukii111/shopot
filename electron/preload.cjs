const {contextBridge, ipcRenderer} = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('shopot', {
  boot: () => ipcRenderer.invoke('boot'),
  settings: value => ipcRenderer.invoke('settings', value),
  dictionary: value => ipcRenderer.invoke('dictionary', value),
  snippets: value => ipcRenderer.invoke('snippets', value),
  profiles: value => ipcRenderer.invoke('profiles', value),
  download: model => ipcRenderer.invoke('download', model),
  beginRecording: () => ipcRenderer.invoke('begin-recording'),
  transcribe: (id, audio) => ipcRenderer.invoke('transcribe', {id, audio}),
  importAudio: () => ipcRenderer.invoke('import-audio'),
  retryRecording: id => ipcRenderer.invoke('retry-recording', id),
  deleteRecording: id => ipcRenderer.invoke('delete-recording', id),
  cancel: () => ipcRenderer.invoke('cancel'),
  copy: text => ipcRenderer.invoke('copy', text),
  saveText: (id, text) => ipcRenderer.invoke('save-text', {id, text}),
  deleteEntry: id => ipcRenderer.invoke('delete-entry', id),
  updateEntry: (id, text) => ipcRenderer.invoke('update-entry', {id, text}),
  readAudio: id => ipcRenderer.invoke('read-audio', id),
  captureUpdate: value => ipcRenderer.send('capture-update', value),
  pastePermission: () => ipcRenderer.invoke('paste-permission'),
  startMeeting: () => ipcRenderer.invoke('meeting-start'),
  stopMeeting: () => ipcRenderer.invoke('meeting-stop'),
  meetingChunk: (id, index, offset, audio) => ipcRenderer.invoke('meeting-chunk', {id, index, offset, audio}),
  meetingDone: (id, error) => ipcRenderer.invoke('meeting-done', {id, error}),
  copySummary: id => ipcRenderer.invoke('copy-summary', id),
  onMeetingRecord: callback => subscribe('meeting-record', callback),
  onMeetingFinish: callback => subscribe('meeting-finish', callback),
  onToggle: callback => subscribe('toggle-recording', callback),
  onCancel: callback => subscribe('cancel-recording', callback),
  onProgress: callback => subscribe('progress', callback),
  onEngine: callback => subscribe('engine', callback),
  onSnapshot: callback => subscribe('snapshot', callback),
});
