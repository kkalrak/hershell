import { contextBridge, ipcRenderer } from 'electron';

const api = {
  create: (cols: number, rows: number, cwd?: string): Promise<number> =>
    ipcRenderer.invoke('pty:create', cols, rows, cwd),
  write: (id: number, data: string) => ipcRenderer.send('pty:write', id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id: number) => ipcRenderer.send('pty:kill', id),
  onData: (cb: (id: number, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id: number, data: string) => cb(id, data)),
  onExit: (cb: (id: number, code: number) => void) =>
    ipcRenderer.on('pty:exit', (_e, id: number, code: number) => cb(id, code)),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clip:read'),
  writeClipboard: (text: string) => ipcRenderer.send('clip:write', text),
};

contextBridge.exposeInMainWorld('pty', api);

export type PtyApi = typeof api;
