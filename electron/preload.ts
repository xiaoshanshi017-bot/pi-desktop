import { contextBridge, ipcRenderer } from 'electron';
import type { PiDesktopApi, RpcRecord } from '../shared/types';

const api: PiDesktopApi = {
  bootstrap: () => ipcRenderer.invoke('pi:bootstrap'),
  chooseProject: () => ipcRenderer.invoke('pi:chooseProject'),
  previewProjectMigration: () => ipcRenderer.invoke('pi:previewProjectMigration'),
  importProjects: paths => ipcRenderer.invoke('pi:importProjects', paths),
  connect: (project, sessionPath) => ipcRenderer.invoke('pi:connect', project, sessionPath),
  disconnect: () => ipcRenderer.invoke('pi:disconnect'),
  listSessions: project => ipcRenderer.invoke('pi:listSessions', project),
  rpc: command => ipcRenderer.invoke('pi:rpc', command),
  respondUI: response => ipcRenderer.invoke('pi:respondUI', response),
  savePreferences: patch => ipcRenderer.invoke('pi:savePreferences', patch),
  chooseFiles: () => ipcRenderer.invoke('pi:chooseFiles'),
  openExternal: url => ipcRenderer.invoke('pi:openExternal', url),
  revealFile: path => ipcRenderer.invoke('pi:revealFile', path),
  onEvent: callback => {
    const handler = (_event: Electron.IpcRendererEvent, data: RpcRecord) => callback(data);
    ipcRenderer.on('pi:event', handler);
    return () => ipcRenderer.removeListener('pi:event', handler);
  },
};
contextBridge.exposeInMainWorld('pi', api);
