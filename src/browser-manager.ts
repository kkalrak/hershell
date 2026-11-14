import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, session } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const ACTIONS = new Set(['navigate', 'click', 'type', 'key', 'scroll', 'screenshot', 'snapshot', 'evaluate', 'user-agent', 'back', 'forward', 'reload']);
const ID_RE = /^[a-zA-Z0-9_-]{1,60}$/;
interface SavedState {
  url?: string;
  userAgent?: string;
  bounds?: Electron.Rectangle;
  scroll?: { x: number; y: number };
  cookies?: Electron.Cookie[];
}
export interface BrowserCapture {
  buffer: Buffer;
  mime: string;
  metrics: { captureMs: number; totalMs: number; bytes: number; width: number; height: number };
}
function webURL(value: string): string {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  return u.href;
}
function finite(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite number');
  return value;
}

/** Browser renderers and persistent sessions are isolated; no terminal preload is exposed. */
class ManagedBrowser {
  readonly win: BrowserWindow;
  readonly view: WebContentsView;
  readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private initialized = false;
  private saved: SavedState = {};
  private lastCapture: BrowserCapture['metrics'] | null = null;
  private logs: { time: string; action: string; detail: string }[] = [];
  lastUsed = Date.now();
  busy = 0;

  constructor(readonly id: string, private readonly dir: string, private readonly connection: () => { baseUrl: string; token: string }, private readonly onClosed: () => void) {
    const ses = session.fromPath(path.join(dir, 'profile'));
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    this.win = new BrowserWindow({
      width: 1280, height: 900, minWidth: 900, minHeight: 600, show: false,
      title: `hershell Browser · ${id}`, backgroundColor: '#10141c',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'browser-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    this.win.contentView.addChildView(this.view);
    const resize = () => {
      const [w, h] = this.win.getContentSize();
      this.view.setBounds({ x: 280, y: 94, width: Math.max(w - 280, 1), height: Math.max(h - 94, 1) });
    };
    resize(); this.win.on('resize', resize);
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', e => e.preventDefault());
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      try { webURL(url); void this.run('navigate', { url }).catch(e => this.record('error', e.message)); } catch { /* unsupported protocol */ }
      return { action: 'deny' };
    });
    const guardNavigation = (e: Electron.Event, url: string) => { try { webURL(url); } catch { e.preventDefault(); } };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);
    wc.on('did-navigate', () => this.publish());
    wc.on('did-navigate-in-page', () => this.publish());
    wc.on('page-title-updated', () => this.publish());
    wc.on('did-stop-loading', () => this.publish());
    wc.on('will-prevent-unload', e => e.preventDefault());
    wc.on('before-input-event', () => { this.lastUsed = Date.now(); });
    this.win.on('close', e => { e.preventDefault(); void this.close(); });
    this.win.on('closed', () => {
      // WebContentsView must be explicitly destroyed when its host closes.
      if (!wc.isDestroyed()) wc.close();
      this.onClosed();
    });
    this.ready = this.initialize().catch(err => {
      this.win.destroy();
      throw err;
    });
  }

  private async initialize() {
    await mkdir(this.dir, { recursive: true });
    try { this.saved = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')); } catch { /* first use */ }
    if (this.saved.bounds) this.win.setBounds(this.saved.bounds);
    await this.win.loadFile(path.join(__dirname, 'browser.html'));
    await this.view.webContents.loadFile(path.join(__dirname, 'browser-welcome.html'));
    if (this.saved.userAgent) this.view.webContents.setUserAgent(this.saved.userAgent);
    for (const cookie of this.saved.cookies ?? []) {
      const { hostOnly, session: _session, ...details } = cookie;
      if (!cookie.domain) continue;
      const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      await this.view.webContents.session.cookies.set({ ...details, ...(hostOnly ? { domain: undefined } : {}), url }).catch(e => this.record('restore-error', String(e)));
    }
    if (this.saved.url?.startsWith('http')) {
      try {
        await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: "history.scrollRestoration = 'manual';" });
        await this.view.webContents.loadURL(webURL(this.saved.url));
        await this.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { scrollTo(${Number(this.saved.scroll?.x) || 0},${Number(this.saved.scroll?.y) || 0}); resolve(true); })))`);
      } catch (e) { this.record('restore-error', String(e)); }
    }
    this.initialized = true;
    if (!this.closing) this.win.show();
    this.record('ready', '웹 테스트 브라우저');
  }

  info() { return { id: this.id, status: this.closing ? 'closing' : this.initialized ? 'running' : 'starting', lastUsed: new Date(this.lastUsed).toISOString(), busy: this.busy }; }
  state() {
    const wc = this.view.webContents;
    return { id: this.id, url: wc.getURL(), title: wc.getTitle(), connection: this.connection(), lastCapture: this.lastCapture, logs: this.logs };
  }
  private publish() { if (!this.win.isDestroyed()) this.win.webContents.send('browser:state', this.state()); }
  private record(action: string, detail = '') {
    this.logs.unshift({ time: new Date().toISOString(), action, detail });
    this.logs.length = Math.min(this.logs.length, 60);
    this.publish();
  }
  private async cdp(method: string, params: Record<string, unknown> = {}) {
    const d = this.view.webContents.debugger;
    if (!d.isAttached()) {
      d.attach('1.3');
      await d.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    }
    return d.sendCommand(method, params);
  }
  private async evaluate(expression: string): Promise<any> {
    const result = await this.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  run(action: string, params: Record<string, any> = {}): Promise<any> {
    if (!ACTIONS.has(action)) return Promise.reject(new Error('Unknown browser action'));
    if (this.closing) return Promise.reject(new Error('Browser is closing'));
    if (!params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(new Error('Expected JSON object'));
    this.lastUsed = Date.now(); this.busy++;
    const next = this.queue.then(() => this.ready).then(() => this.command(action, params));
    this.queue = next.catch(() => {});
    return next.finally(() => { this.busy--; this.lastUsed = Date.now(); });
  }
  private async command(action: string, p: Record<string, any>): Promise<any> {
    const wc = this.view.webContents;
    let result: unknown = { ok: true };
    switch (action) {
      case 'navigate': await wc.loadURL(webURL(p.url)); break;
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'user-agent':
        if (typeof p.value !== 'string' || !p.value.trim()) throw new Error('User-Agent is required');
        wc.setUserAgent(p.value); break;
      case 'click': {
        let { x, y } = p;
        if (p.selector) {
          const point = await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(p.selector)}); if (!e) throw Error('Element not found'); e.scrollIntoView({block:'center',inline:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
          x = point.x; y = point.y;
        }
        finite(x); finite(y);
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        break;
      }
      case 'type':
        if (typeof p.text !== 'string') throw new Error('text is required');
        if (p.selector) await this.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(p.selector)}); if (!e) throw Error('Element not found'); e.focus(); ${p.clear ? "if (typeof e.select === 'function') e.select();" : ''} })()`);
        await this.cdp('Input.insertText', { text: p.text }); break;
      case 'key': {
        const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
        if (!Object.hasOwn(keys, p.key)) throw new Error('Unsupported key');
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: p.key, windowsVirtualKeyCode: keys[p.key], ...(p.key === 'Enter' ? { text: '\r' } : {}) });
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: p.key, windowsVirtualKeyCode: keys[p.key] }); break;
      }
      case 'scroll': await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: finite(p.x ?? 200), y: finite(p.y ?? 200), deltaX: finite(p.deltaX ?? 0), deltaY: finite(p.deltaY ?? 500) }); break;
      case 'snapshot': result = await this.evaluate(`({url:location.href,title:document.title,text:document.body.innerText.slice(0,20000),elements:Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0,250).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,role:e.getAttribute('role'),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,160),type:e.getAttribute('type'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})})`); break;
      case 'evaluate':
        if (typeof p.expression !== 'string') throw new Error('expression required');
        result = { value: await this.evaluate(p.expression) }; break;
      case 'screenshot': {
        const start = performance.now();
        const image = await wc.capturePage();
        const captured = performance.now();
        const jpeg = p.format === 'jpeg';
        const buffer = jpeg ? image.toJPEG(80) : image.toPNG();
        this.lastCapture = { captureMs: +(captured - start).toFixed(1), totalMs: +(performance.now() - start).toFixed(1), bytes: buffer.length, ...image.getSize() };
        this.record(action, `${this.lastCapture.totalMs} ms`);
        return { buffer, mime: jpeg ? 'image/jpeg' : 'image/png', metrics: this.lastCapture } satisfies BrowserCapture;
      }
    }
    this.record(action);
    return result;
  }
  private async save() {
    const wc = this.view.webContents;
    const scroll = await this.evaluate('({x:scrollX,y:scrollY})').catch(() => this.saved.scroll ?? { x: 0, y: 0 });
    this.saved = { url: wc.getURL(), userAgent: wc.getUserAgent(), bounds: this.win.getBounds(), scroll, cookies: await wc.session.cookies.get({}) };
    wc.session.flushStorageData();
    await wc.session.cookies.flushStore();
    const file = path.join(this.dir, 'state.json');
    await writeFile(file + '.tmp', JSON.stringify(this.saved));
    await rename(file + '.tmp', file);
  }
  checkpoint() {
    if (this.busy || this.closing) return;
    const next = this.queue.then(() => this.ready).then(() => this.save());
    this.queue = next.catch(e => console.error('Browser checkpoint failed', this.id, e));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // A pending page promise must not prevent hershell from exiting forever.
      let timeout: NodeJS.Timeout;
      const deadline = new Promise<void>(resolve => { timeout = setTimeout(resolve, 8000); });
      const save = (async () => {
        try { await this.queue; await this.ready; if (!this.win.isDestroyed()) await this.save(); }
        catch (e) { console.error('Browser save failed', this.id, e); }
      })();
      try { await Promise.race([save, deadline]); }
      finally { clearTimeout(timeout!); if (!this.win.isDestroyed()) this.win.destroy(); }
    })();
    return this.closing;
  }
}

export class BrowserManager {
  private browsers = new Map<string, ManagedBrowser>();
  private stopping = false;
  private sweep: NodeJS.Timeout;
  private checkpoint: NodeJS.Timeout;
  constructor(private readonly connection: () => { url: string; token: string }, private readonly idleMs = 600000) {
    this.sweep = setInterval(() => {
      for (const browser of this.browsers.values()) {
        if (!browser.busy && Date.now() - browser.lastUsed > idleMs) void browser.close();
      }
    }, Math.min(10000, idleMs / 2));
    this.checkpoint = setInterval(() => { for (const browser of this.browsers.values()) browser.checkpoint(); }, 30000);
    // Only trusted browser chrome can call this bridge. Web pages have no preload.
    const find = (sender: Electron.WebContents) => {
      const browser = [...this.browsers.values()].find(b => b.win.webContents === sender);
      if (!browser) throw new Error('Unknown browser window');
      return browser;
    };
    ipcMain.handle('browser:state', e => find(e.sender).state());
    ipcMain.handle('browser:command', (e, action, params) => find(e.sender).run(action, params));
    ipcMain.handle('browser:copy-connection', e => clipboard.writeText(JSON.stringify(find(e.sender).state().connection, null, 2)));
  }
  private async acquire(id: string): Promise<ManagedBrowser> {
    if (!ID_RE.test(id)) throw new Error('Browser ID must be 1–60 letters, numbers, hyphens or underscores');
    if (this.stopping) throw new Error('Browser manager is stopping');
    let browser = this.browsers.get(id);
    if (browser?.info().status === 'closing') { await browser.close(); return this.acquire(id); }
    if (!browser) {
      // Hash avoids Windows case-insensitive paths aliasing IDs such as A and a.
      browser = new ManagedBrowser(id, path.join(app.getPath('userData'), 'browsers', createHash('sha256').update(id).digest('hex')), () => {
        const { url, token } = this.connection();
        return { baseUrl: `${url}/browsers/${id}`, token };
      }, () => { if (this.browsers.get(id) === browser) this.browsers.delete(id); });
      this.browsers.set(id, browser);
    }
    browser.lastUsed = Date.now();
    await browser.ready;
    return browser;
  }
  list() { return [...this.browsers.values()].map(b => b.info()); }
  async request(method: string, id: string, action: string, params: Record<string, any>) {
    if (!ID_RE.test(id)) throw new Error('Invalid browser ID');
    if (method === 'DELETE' && !action) {
      await this.browsers.get(id)?.close();
      return { id, closed: true };
    }
    if (!(method === 'POST' && (!action || action === 'heartbeat' || ACTIONS.has(action))) && !(method === 'GET' && action === 'state')) throw new Error('Unknown browser action or method');
    const browser = await this.acquire(id);
    if (!action || action === 'heartbeat') return { ...browser.info(), baseUrl: browser.state().connection.baseUrl };
    if (action === 'state') return browser.state();
    return browser.run(action, params);
  }
  async shutdown() {
    this.stopping = true;
    clearInterval(this.sweep); clearInterval(this.checkpoint);
    await Promise.allSettled([...this.browsers.values()].map(b => b.close()));
  }
}
