import { contextBridge, ipcRenderer } from 'electron';
import type { TelegramStatus, TelegramConfig } from './telegram';

const api = {
  create: (cols: number, rows: number, cwd?: string, key?: string): Promise<number> =>
    ipcRenderer.invoke('pty:create', cols, rows, cwd, key),
  ready: (id: number) => ipcRenderer.send('pty:ready', id),
  write: (id: number, data: string) => ipcRenderer.send('pty:write', id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id: number) => ipcRenderer.send('pty:kill', id),
  onData: (cb: (id: number, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id: number, data: string) => cb(id, data)),
  onExit: (cb: (id: number, code: number) => void) =>
    ipcRenderer.on('pty:exit', (_e, id: number, code: number) => cb(id, code)),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clip:read'),
  agentInfo: (): Promise<{ url: string; token: string } | null> => ipcRenderer.invoke('agent:info'),
  shellAddress: (id: number): Promise<string> => ipcRenderer.invoke('agent:shell-address', id),
  setCwd: (id: number, cwd: string) => ipcRenderer.send('pty:cwd', id, cwd),
  onMessage: (cb: (requestId: number, to: number, message: string) => void) =>
    ipcRenderer.on('agent:message', (_e, requestId, to, message) => cb(requestId, to, message)),
  delivered: (requestId: number, ok: boolean) => ipcRenderer.send('agent:delivered', requestId, ok),
  submitMessage: (id: number, requestId: number, length: number): Promise<void> => ipcRenderer.invoke('agent:submit', id, requestId, length),
  telegramStatus: (): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:status'),
  telegramSelect: (id: number | null): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:select', id),
  telegramImport: (): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:import'),
  telegramSave: (config: TelegramConfig): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:save', config),
  telegramVerify: (config?: TelegramConfig): Promise<string> => ipcRenderer.invoke('telegram:verify', config),
  telegramClear: (): Promise<TelegramStatus> => ipcRenderer.invoke('telegram:clear'),
  onTelegramStatus: (cb: (status: TelegramStatus) => void) => ipcRenderer.on('telegram:status', (_e, status) => cb(status)),
  writeClipboard: (text: string) => ipcRenderer.send('clip:write', text),
};

contextBridge.exposeInMainWorld('pty', api);

export type PtyApi = typeof api;
