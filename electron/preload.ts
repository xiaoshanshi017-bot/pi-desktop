import { contextBridge, ipcRenderer } from 'electron';
import type { PiDesktopApi, RpcRecord } from '../shared/types';

const api: PiDesktopApi = {
  bootstrap: options => ipcRenderer.invoke('pi:bootstrap', options),
  chooseProject: () => ipcRenderer.invoke('pi:chooseProject'),
  previewProjectMigration: () => ipcRenderer.invoke('pi:previewProjectMigration'),
  importProjects: paths => ipcRenderer.invoke('pi:importProjects', paths),
  connect: (project, sessionPath, options) => ipcRenderer.invoke('pi:connect', project, sessionPath, options),
  activateConnection: id => ipcRenderer.invoke('pi:activateConnection', id),
  selectConnection: id => ipcRenderer.invoke('pi:selectConnection', id),
  listConnections: () => ipcRenderer.invoke('pi:listConnections'),
  disconnect: connectionId => ipcRenderer.invoke('pi:disconnect', connectionId),
  listSessions: project => ipcRenderer.invoke('pi:listSessions', project),
  rpc: (command, connectionId) => ipcRenderer.invoke('pi:rpc', command, connectionId),
  redirect: (prompt, connectionId) => ipcRenderer.invoke('pi:redirect', prompt, connectionId),
  respondUI: (response, connectionId) => ipcRenderer.invoke('pi:respondUI', response, connectionId),
  savePreferences: patch => ipcRenderer.invoke('pi:savePreferences', patch),
  saveWorkspace: snapshot => ipcRenderer.invoke('pi:saveWorkspace', snapshot),
  onWorkspaceFlush: callback => {
    const handler = (_event: Electron.IpcRendererEvent, requestId: string) => {
      void Promise.resolve().then(callback).then(() => ipcRenderer.invoke('pi:workspaceFlushed', requestId)).catch(() => {});
    };
    ipcRenderer.on('pi:workspaceFlush', handler);
    return () => ipcRenderer.removeListener('pi:workspaceFlush', handler);
  },
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
