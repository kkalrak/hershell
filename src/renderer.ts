import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { PtyApi } from './preload';
import { compareItems, detect, folderName, STATUS_MS, TAIL_LINES, type Status } from './status';
import { loadLayout, saveLayout as storeLayout } from './layout';

declare global {
  interface Window { pty: PtyApi }
}
const api = window.pty;

const TERM_OPTIONS = {
  fontFamily: "'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: true,
  theme: { background: '#1e1e1e' },
};

/** One sidebar entry = one terminal = one shell process. */
interface Item {
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;      // terminal container
  li: HTMLLIElement;       // sidebar row
  dot: HTMLSpanElement;    // status color
  title: HTMLSpanElement;  // folder name
  cwd: string;
  status: Status;
  lastOutput: number;
  exited: boolean;
}

const items = new Map<number, Item>();
let active: Item | null = null;
let restoring = false;

const listEl = document.getElementById('list') as HTMLUListElement;
const termsEl = document.getElementById('terms') as HTMLElement;

// ---------- helpers ----------
function tailLines(term: Terminal, n: number): string[] {
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const out: string[] = [];
  for (let y = Math.max(0, end - n + 1); y <= end; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '');
  }
  return out;
}

/** Items in sidebar order. */
function ordered(): Item[] {
  const byLi = new Map([...items.values()].map((it) => [it.li, it]));
  return ([...listEl.children] as HTMLLIElement[]).flatMap((li) => byLi.get(li) ?? []);
}

function persist() {
  if (restoring) return;
  const list = ordered();
  storeLayout({ cwds: list.map((it) => it.cwd), active: active ? Math.max(0, list.indexOf(active)) : 0 });
}

function setCwd(it: Item, cwd: string) {
  it.cwd = cwd;
  it.title.textContent = folderName(cwd);
  it.li.title = cwd; // full path on hover
}

/** Keep the sidebar sorted by folder name. Touches the DOM only when the order actually changes. */
function sortList() {
  const current = ordered();
  const sorted = [...current].sort(compareItems);
  if (sorted.every((it, i) => it === current[i])) return;
  for (const it of sorted) listEl.appendChild(it.li);
  persist();
}

function setStatus(it: Item, s: Status) {
  if (s === it.status) return;
  it.status = s;
  it.dot.className = 'dot ' + s;
}

// ---------- status loop (cheap: last TAIL_LINES lines per shell) ----------
setInterval(() => {
  const now = Date.now();
  for (const it of items.values()) {
    const d = detect(tailLines(it.term, TAIL_LINES), now - it.lastOutput, it.exited);
    setStatus(it, d.status);
    if (d.cwd && d.cwd !== it.cwd) { setCwd(it, d.cwd); persist(); sortList(); }
  }
}, STATUS_MS);

// ---------- DOM ----------
function createRow(): { li: HTMLLIElement; dot: HTMLSpanElement; title: HTMLSpanElement; close: HTMLButtonElement } {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot idle';
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = '닫기';
  li.append(dot, title, close);
  return { li, dot, title, close };
}

function createTerminal(el: HTMLElement): { term: Terminal; fit: FitAddon } {
  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // GPU rendering; fall back to the default renderer if WebGL is unavailable or lost.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch { /* default renderer */ }
  return { term, fit };
}

// ---------- items ----------
async function addShell(cwd = '') {
  const el = document.createElement('div');
  el.className = 'term';
  termsEl.appendChild(el);
  const { li, dot, title, close } = createRow();
  listEl.appendChild(li);

  // Measure in the visible area so the shell starts with the right size.
  el.style.visibility = 'hidden';
  el.classList.add('active');
  const { term, fit } = createTerminal(el);
  fit.fit();

  let id: number;
  try {
    id = await api.create(term.cols, term.rows, cwd || undefined);
  } catch (err) {
    term.dispose(); el.remove(); li.remove();
    console.error('failed to start shell', err);
    return;
  } finally {
    el.classList.remove('active');
    el.style.visibility = '';
  }

  const it: Item = { id, term, fit, el, li, dot, title, cwd: '', status: 'idle', lastOutput: 0, exited: false };
  setCwd(it, cwd);
  items.set(id, it);
  sortList();

  term.onData((d) => { if (!it.exited) api.write(id, d); });
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
  term.attachCustomKeyEventHandler((e) => handleKey(it, e));
  li.addEventListener('click', () => activate(it));
  close.addEventListener('click', (e) => { e.stopPropagation(); removeItem(it); });

  activate(it);
}

/** Return false to stop xterm from handling the key. */
function handleKey(it: Item, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
  const key = e.key.toLowerCase();
  // Ctrl+C copies when text is selected; otherwise it reaches the shell as an interrupt.
  if (key === 'c' && !e.shiftKey && it.term.hasSelection()) {
    api.writeClipboard(it.term.getSelection());
    it.term.clearSelection();
    return false;
  }
  if (key === 'v') {
    e.preventDefault();
    api.readClipboard().then((t) => { if (t) it.term.paste(t); });
    return false;
  }
  if (key === 't' && e.shiftKey) {
    e.preventDefault();
    addShell();
    return false;
  }
  return true;
}

function activate(it: Item) {
  if (active !== it) {
    active?.el.classList.remove('active');
    active?.li.classList.remove('active');
    active = it;
    it.el.classList.add('active');
    it.li.classList.add('active');
    it.fit.fit();
    persist();
  }
  it.term.focus();
}

function removeItem(it: Item) {
  const list = ordered();
  const idx = list.indexOf(it);
  if (!it.exited) api.kill(it.id);
  it.term.dispose();
  it.el.remove();
  it.li.remove();
  items.delete(it.id);
  if (active === it) {
    active = null;
    // Select the neighbour below, or above if it was the last one.
    const next = list[idx + 1] ?? list[idx - 1];
    if (next) activate(next);
  }
  persist();
}

// ---------- pty events ----------
api.onData((id, data) => {
  const it = items.get(id);
  if (!it) return;
  it.lastOutput = Date.now();
  it.term.write(data);
});

api.onExit((id, code) => {
  const it = items.get(id);
  if (!it) return;
  it.exited = true;
  it.term.write(`\r\n\x1b[90m[셸 종료: ${code}]\x1b[0m\r\n`);
});

// Refit only the visible terminal, coalesced to one call per frame.
let resizeQueued = false;
new ResizeObserver(() => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    active?.fit.fit();
  });
}).observe(termsEl);

// Read-only hook for automated UI checks (WebGL draws text on a canvas, so the DOM has no text).
(window as any).__hershell = {
  tail: (n = 30) => (active ? tailLines(active.term, n).join('\n') : ''),
};

document.getElementById('add')!.addEventListener('click', () => addShell());
// ---------- start ----------
async function start() {
  const layout = loadLayout();
  if (!layout) { await addShell(); return; }
  restoring = true;
  for (const cwd of layout.cwds) await addShell(cwd);
  restoring = false;
  const target = ordered()[layout.active];
  if (target) activate(target);
  persist();
}

start();
