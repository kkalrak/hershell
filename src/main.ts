import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron';
import * as pty from '@lydell/node-pty';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Output from a pty is batched and sent to the window at most once per FLUSH_MS.
// Sending every tiny chunk separately is the main cause of IPC/render overhead.
const FLUSH_MS = 16;

function findShell(): string {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    if (d && existsSync(path.join(d, 'pwsh.exe'))) return 'pwsh.exe';
  }
  return 'powershell.exe';
}

const SHELL = findShell();

interface Session {
  proc: pty.IPty;
  buf: string;
  timer: NodeJS.Timeout | null;
}

const sessions = new Map<number, Session>();
let nextId = 1;
let win: BrowserWindow | null = null;

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function flush(id: number) {
  const s = sessions.get(id);
  if (!s) return;
  s.timer = null;
  if (s.buf) {
    send('pty:data', id, s.buf);
    s.buf = '';
  }
}

function validDir(dir: unknown): string {
  try {
    if (typeof dir === 'string' && dir && statSync(dir).isDirectory()) return dir;
  } catch { /* missing or inaccessible */ }
  return os.homedir();
}

function size(n: unknown, fallback: number): number {
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback;
}

ipcMain.handle('pty:create', (_e, cols: number, rows: number, cwd?: string) => {
  const id = nextId++;
  const proc = pty.spawn(SHELL, ['-NoLogo'], {
    name: 'xterm-256color',
    cols: size(cols, 80),
    rows: size(rows, 24),
    cwd: validDir(cwd),
    env: process.env as Record<string, string>,
  });
  const s: Session = { proc, buf: '', timer: null };
  sessions.set(id, s);

  proc.onData((data) => {
    s.buf += data;
    if (!s.timer) s.timer = setTimeout(() => flush(id), FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    if (s.timer) clearTimeout(s.timer);
    flush(id);
    sessions.delete(id);
    send('pty:exit', id, exitCode);
  });
  return id;
});

ipcMain.on('pty:write', (_e, id: number, data: string) => {
  sessions.get(id)?.proc.write(data);
});

ipcMain.on('pty:resize', (_e, id: number, cols: number, rows: number) => {
  const s = sessions.get(id);
  if (s && size(cols, 0) && size(rows, 0)) {
    try { s.proc.resize(cols, rows); } catch { /* process may have exited */ }
  }
});

ipcMain.on('pty:kill', (_e, id: number) => {
  sessions.get(id)?.proc.kill();
});

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.on('clip:write', (_e, text: string) => clipboard.writeText(text));

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1e1e1e',
    title: 'hershell',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'), // made by tools/make-icon.ps1
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; });
}

// Tests use a separate profile so they never overwrite the user's saved sidebar.
if (process.env.HERSHELL_USER_DATA) app.setPath('userData', process.env.HERSHELL_USER_DATA);

// Only one instance per profile: two instances would fight over the saved sidebar
// and Chromium's storage lock. A second launch just brings the existing window forward.
// (The lock is tied to userData, so tests with HERSHELL_USER_DATA don't clash with the real app.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.proc.kill();
  app.quit();
});
