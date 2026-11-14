import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('browser', {
  state: () => ipcRenderer.invoke('browser:state'),
  command: (action: string, params?: Record<string, unknown>) => ipcRenderer.invoke('browser:command', action, params),
  copyConnection: () => ipcRenderer.invoke('browser:copy-connection'),
  onState: (callback: (state: unknown) => void) => ipcRenderer.on('browser:state', (_e, state) => callback(state)),
});
