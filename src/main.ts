import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron';
import * as pty from '@lydell/node-pty';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startAgentApi } from './agent-api';
import { BrowserManager } from './browser-manager';
import { MessageDelivery } from './message-delivery';
import { TelegramBridge, type TelegramConfig } from './telegram';
import { TelegramSettings } from './telegram-settings';
import { randomBytes, randomUUID } from 'node:crypto';
import { isShellKey } from './layout';
import { shellAddresses } from './shell-address';
import { folderName } from './status';

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
  cwd: string;
  apiToken: string;
  key: string;
  ready: boolean;
}

const sessions = new Map<number, Session>();
let nextId = 1;
let win: BrowserWindow | null = null;

let agentApi: Awaited<ReturnType<typeof startAgentApi>> | null = null;
let browsers: BrowserManager;
let quitting = false;
let telegram: TelegramBridge;
let telegramSettings: TelegramSettings;
let representativeKey: string | null = null;
function listShells() { return [...sessions].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })); }
function shellAddress(id: number): string {
  const shells = listShells(), index = shells.findIndex(s => s.sessionId === id);
  return index < 0 ? '종료된 셸' : shellAddresses(shells)[index].id;
}
const messages = new MessageDelivery((id, to, message) => send('agent:message', id, to, message), undefined, shellAddress);
// Separate paste and Enter so CLI paste handling does not swallow the submit key.
// Main-process timers also work when the recipient terminal/window is hidden.
ipcMain.handle('agent:submit', async (e, id: number, requestId: number, length: number) => {
  if (e.sender !== win?.webContents) throw new Error('Unknown sender');
  const session = sessions.get(id);
  if (!session || !messages.isPending(requestId)) throw new Error('Delivery cancelled');
  // ConPTY can deliver a large paste as many key events. Codex suppresses Enter
  // while those events are still arriving. Budget for the paste size, then send once.
  if (!Number.isInteger(length) || length < 0 || length > 100000) throw new Error('Invalid paste length');
  const settleMs = Math.min(12000, 1500 + Math.ceil(length / 4));
  await new Promise(resolve => setTimeout(resolve, settleMs));
  if (sessions.get(id) !== session || quitting || !messages.isPending(requestId)) throw new Error('Delivery cancelled');
  // Renderer sends Enter through xterm.input/onData, matching normal keyboard input.
});
ipcMain.on('agent:delivered', (e, id: number, ok: boolean) => {
  if (e.sender === win?.webContents) messages.acknowledge(id, ok);
});
ipcMain.handle('agent:info', () => agentApi ? { url: agentApi.url, token: agentApi.token } : null);
ipcMain.handle('agent:shell-address', (e, id: number) => { trustedShellWindow(e); return shellAddress(id); });
ipcMain.on('pty:cwd', (_e, id: number, cwd: string) => {
  const s = sessions.get(id);
  if (s && typeof cwd === 'string') s.cwd = cwd;
});

function trustedShellWindow(e: Electron.IpcMainInvokeEvent) {
  if (e.sender !== win?.webContents) throw new Error('Unknown sender');
}
ipcMain.handle('telegram:status', e => { trustedShellWindow(e); return telegram.status(); });
ipcMain.handle('telegram:select', (e, id: number | null) => {
  trustedShellWindow(e);
  if (id !== null && !Number.isInteger(id)) throw new Error('Invalid shell');
  const session = id === null ? null : sessions.get(id);
  if (id !== null && (!session || !telegram.status().configured)) throw new Error('실행 중인 셸과 텔레그램 설정을 확인하세요.');
  const key = session?.key ?? null;
  telegramSettings.saveRepresentative(key);
  representativeKey = key;
  return telegram.select(id);
});
ipcMain.on('pty:ready', (e, id: number) => {
  if (e.sender !== win?.webContents) return;
  const session = sessions.get(id);
  if (!session || session.ready) return;
  session.ready = true;
  if (session.key === representativeKey && telegram.status().configured && !quitting) {
    void telegram.select(id).catch(() => telegram.setError('대표 셸 자동 연결에 실패했습니다. 다시 연결하세요.'));
  }
});
ipcMain.handle('telegram:import', e => {
  trustedShellWindow(e);
  telegram.configure(telegramSettings.importFile());
  return telegram.status();
});
ipcMain.handle('telegram:verify', async (e, input?: TelegramConfig) => {
  trustedShellWindow(e);
  return telegram.verify(input?.token ? input : undefined);
});
ipcMain.handle('telegram:save', async (e, input: TelegramConfig) => {
  trustedShellWindow(e);
  const config = { token: input.token || telegramSettings.load()?.token || '', chatId: input.chatId };
  await telegram.verify(config);
  telegramSettings.save(config); telegram.configure(config);
  return telegram.status();
});
ipcMain.handle('telegram:clear', e => {
  trustedShellWindow(e);
  telegram.configure(null); telegramSettings.clear();
  representativeKey = null;
  return telegram.status();
});

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

ipcMain.handle('pty:create', (_e, cols: number, rows: number, cwd?: string, savedKey?: string) => {
  const id = nextId++;
  const initialCwd = validDir(cwd);
  const apiToken = randomBytes(32).toString('hex');
  const key = isShellKey(savedKey) ? savedKey.toLowerCase() : randomUUID();
  if ([...sessions.values()].some(s => s.key === key)) throw new Error('Duplicate shell key');
  const proc = pty.spawn(SHELL, ['-NoLogo'], {
    name: 'xterm-256color',
    cols: size(cols, 80),
    rows: size(rows, 24),
    cwd: initialCwd,
    env: { ...process.env, HERSHELL_SHELL_ID: folderName(initialCwd), HERSHELL_API_URL: agentApi?.url ?? '', HERSHELL_API_TOKEN: agentApi?.token ?? '', HERSHELL_SHELL_TOKEN: apiToken } as Record<string, string>,
  });
  const s: Session = { proc, buf: '', timer: null, cwd: initialCwd, apiToken, key, ready: false };
  sessions.set(id, s);

  proc.onData((data) => {
    s.buf += data;
    if (!s.timer) s.timer = setTimeout(() => flush(id), FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    if (s.timer) clearTimeout(s.timer);
    flush(id);
    forgetRepresentative(id);
    sessions.delete(id);
    telegram?.shellClosed(id);
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
  forgetRepresentative(id);
  telegram?.shellClosed(id);
  sessions.get(id)?.proc.kill();
});

function forgetRepresentative(id: number) {
  if (!quitting && sessions.get(id)?.key === representativeKey) {
    representativeKey = null;
    try { telegramSettings.saveRepresentative(null); } catch { telegram.setError('대표 셸 해제 저장에 실패했습니다.'); }
  }
}

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
  win.on('close', e => {
    // The terminal owns the app lifecycle even while browser windows are open.
    if (!quitting) { e.preventDefault(); app.quit(); }
  });
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
  app.whenReady().then(async () => {
    const testBase = process.env.HERSHELL_USER_DATA ? process.env.HERSHELL_TELEGRAM_TEST_URL : undefined;
    const base = testBase && /^http:\/\/127\.0\.0\.1:\d+$/.test(testBase) ? testBase : undefined;
    telegram = new TelegramBridge({ base, hasShell: id => sessions.has(id),
      deliver: (id, text, signal) => messages.deliver(0, id, text, signal), changed: status => send('telegram:status', status) });
    telegramSettings = new TelegramSettings(path.join(app.getPath('userData'), 'telegram.enc'), path.join(app.getAppPath(), '.env'));
    representativeKey = telegramSettings.loadRepresentative();
    try {
      const stored = telegramSettings.load();
      if (stored) telegram.configure(stored);
      else if (!telegramSettings.hasSavedChoice() && !process.env.HERSHELL_USER_DATA && existsSync(path.join(app.getAppPath(), '.env'))) telegram.configure(telegramSettings.importFile());
    } catch { telegram.setError('텔레그램 설정을 불러오지 못했습니다. 추가기능에서 설정을 확인하세요.'); }
    try {
      agentApi = await startAgentApi(listShells, (from, to, message) => messages.deliver(from, to, message), () => browsers,
        { bridge: () => telegram, shellForToken: token => [...sessions].find(([, s]) => s.apiToken === token)?.[0] });
      const testIdle = process.env.HERSHELL_USER_DATA ? Number(process.env.HERSHELL_BROWSER_IDLE_MS) : NaN;
      browsers = new BrowserManager(() => ({ url: agentApi!.url, token: agentApi!.token }), Number.isFinite(testIdle) && testIdle >= 1000 ? testIdle : undefined);
    }
    catch (err) { console.error('Agent API could not start', err); }
    createWindow();
  });
}

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.proc.kill();
  app.quit();
});

app.on('before-quit', e => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  agentApi?.close();
  telegram?.stop();
  messages.close();
  for (const s of sessions.values()) { try { s.proc.kill(); } catch { /* already exited */ } }
  void (browsers?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
});
