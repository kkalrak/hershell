import { CONVERSATION_RULE } from '../src/agent-instructions.ts';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hershell-browser-test-'));
const profile = path.join(dir, 'profile');
const env = { ...process.env, HERSHELL_USER_DATA: profile };
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Browser test</title><style>body{font:24px sans-serif;background:#f3f5f9;color:#234;padding:30px}input,button{font:24px sans-serif;padding:12px} .tall{height:4000px}</style><h1>hershell 브라우저 테스트</h1><form id="form"><input id="name" value="old"><button id="submit">확인</button></form><p id="result"></p><a href="/next">Next</a><div class="tall"></div><script>document.querySelector('#form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent=document.querySelector('#name').value};</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
let app, info;
const headers = () => ({ Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' });
async function request(route, body = {}, method = 'POST') {
  const r = await fetch(info.url + route, { method, headers: headers(), ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw Error(`${r.status}: ${await r.text()}`);
  return r;
}
const json = async (...args) => (await request(...args)).json();
const command = (id, action, body = {}) => json(`/browsers/${id}/${action}`, body);
const evaluate = async (id, expression) => (await command(id, 'evaluate', { expression })).value;
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('Timed out: ' + label);
    await new Promise(r => setTimeout(r, 100));
  }
}
async function launch(extraEnv = {}) {
  app = await electron.launch({ args: ['.'], env: { ...env, ...extraEnv } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__hershell?.tail(3).includes('PS '));
  info = await page.evaluate(() => window.pty.agentInfo());
  return page;
}
try {
  const page = await launch();
  await page.click('#extensions');
  await page.click('#copy-browser-usage');
  await page.waitForFunction(() => document.querySelector('#browser-copy-result').textContent.includes('복사했습니다'));
  const usage = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(usage.includes(CONVERSATION_RULE));
  assert.match(usage, /POST \/browsers\/:id/);
  assert.match(usage, /shell-1/);
  await page.screenshot({ path: path.join(dir, 'extensions.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(await json('/browsers', {}, 'GET'), []);
  assert.equal((await fetch(info.url + '/browsers')).status, 401);
  assert.equal((await fetch(info.url + '/browsers/agent-A', { method: 'POST', headers: { ...headers(), Origin: 'http://example.com' }, body: '{}' })).status, 401);
  assert.equal((await fetch(info.url + '/browsers/agent-A/not-real', { method: 'POST', headers: headers(), body: '{}' })).status, 400);
  assert.deepEqual(await json('/browsers', {}, 'GET'), []);
  const [a, b] = await Promise.all([json('/browsers/agent-A'), json('/browsers/agent-A')]);
  assert.equal(a.baseUrl, b.baseUrl);
  assert.equal((await json('/browsers', {}, 'GET')).length, 1);
  await Promise.all([command('agent-A', 'navigate', { url }), command('agent-a', 'navigate', { url })]);
  const snap = await command('agent-A', 'snapshot');
  assert.equal(snap.title, 'Browser test');
  assert.ok(snap.elements.some(e => e.id === 'submit'));
  assert.deepEqual(await evaluate('agent-A', '[typeof window.pty, typeof window.browser, typeof require, typeof process]'), ['undefined', 'undefined', 'undefined', 'undefined']);
  assert.deepEqual(await evaluate('agent-A', "[window.open('file:///C:/Windows/win.ini'), location.href]").then(x => x[0]), null);
  assert.equal((await fetch(info.url + '/browsers/agent-A/navigate', { method: 'POST', headers: headers(), body: JSON.stringify({ url: 'file:///C:/Windows/win.ini' }) })).status, 400);
  await evaluate('agent-A', "localStorage.setItem('test','kept'); document.cookie='test=kept'; sessionStorage.setItem('ephemeral','yes')");
  assert.deepEqual(await evaluate('agent-a', "[localStorage.getItem('test'), document.cookie]"), [null, '']);
  await Promise.all([
    command('agent-A', 'type', { selector: '#name', text: '한글 입력', clear: true }),
    command('agent-a', 'type', { selector: '#name', text: 'second', clear: true }),
  ]);
  await command('agent-A', 'click', { selector: '#submit' });
  assert.equal(await evaluate('agent-A', "document.querySelector('#result').textContent"), '한글 입력');
  await command('agent-a', 'key', { key: 'Enter' });
  assert.equal(await evaluate('agent-a', "document.querySelector('#result').textContent"), 'second');
  await command('agent-A', 'scroll', { deltaY: 500 });
  await until(async () => (await evaluate('agent-A', 'scrollY')) > 0, 'scroll');
  await evaluate('agent-A', 'scrollTo(0,0)');
  const shot = await request('/browsers/agent-A/screenshot', { format: 'png' });
  const png = Buffer.from(await shot.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(Number(shot.headers.get('x-total-ms')) >= 0);
  writeFileSync(path.join(dir, 'web.png'), png);
  const jpeg = Buffer.from(await (await request('/browsers/agent-a/screenshot', { format: 'jpeg' })).arrayBuffer());
  assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  const chrome = app.windows().find(w => w.url().endsWith('browser.html'));
  await chrome.waitForFunction(() => document.querySelector('#instance').textContent === 'agent-A');
  await chrome.screenshot({ path: path.join(dir, 'browser-window.png') });
  await chrome.click('#capture');
  await chrome.waitForSelector('#preview:not([hidden])');
  await chrome.click('#copy');
  const copied = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()));
  assert.equal(copied.baseUrl, a.baseUrl);
  await command('agent-A', 'user-agent', { value: 'Hershell-Test/1.0' });
  await evaluate('agent-A', 'scrollTo(0,600)');
  await until(async () => (await evaluate('agent-A', 'scrollY')) === 600, 'save scroll');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'hershell Browser · agent-A').close());
  await until(async () => !(await json('/browsers', {}, 'GET')).some(b => b.id === 'agent-A'), 'manual close');
  assert.equal((await json('/shells', {}, 'GET')).length, 1);
  await json('/browsers/agent-A');
  const restored = await evaluate('agent-A', "({storage:localStorage.getItem('test'),cookie:document.cookie,scroll:scrollY,ua:navigator.userAgent,url:location.href,form:document.querySelector('#name').value,ephemeral:sessionStorage.getItem('ephemeral')})");
  assert.deepEqual(restored, { storage: 'kept', cookie: 'test=kept', scroll: 600, ua: 'Hershell-Test/1.0', url, form: 'old', ephemeral: null });
  await json('/browsers/agent-a', {}, 'DELETE');
  // Closing the terminal exits the whole app, even with an open browser window.
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).close());
  await closed;
  app = null;
  await launch({ HERSHELL_BROWSER_IDLE_MS: '1500' });
  await json('/browsers/agent-A');
  assert.equal(await evaluate('agent-A', "localStorage.getItem('test')"), 'kept');
  // Heartbeat extends lifetime; long-running commands must not be swept.
  await new Promise(r => setTimeout(r, 700));
  await command('agent-A', 'heartbeat');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await json('/browsers', {}, 'GET')).length, 1);
  const busy = evaluate('agent-A', 'new Promise(resolve => setTimeout(() => resolve(123), 2500))');
  await new Promise(r => setTimeout(r, 2000));
  assert.equal((await json('/browsers', {}, 'GET')).length, 1);
  assert.equal(await busy, 123);
  await until(async () => (await json('/browsers', {}, 'GET')).length === 0, 'idle close');
  await json('/browsers/agent-A');
  assert.equal(await evaluate('agent-A', "localStorage.getItem('test')"), 'kept');
  await json('/browsers/agent-A', {}, 'DELETE');
  // A page promise that never resolves cannot hold a browser (or app shutdown) forever.
  await json('/browsers/stuck');
  const pending = evaluate('stuck', 'new Promise(() => {})').then(() => false, () => true);
  await until(async () => (await json('/browsers', {}, 'GET')).some(b => b.id === 'stuck' && b.busy > 0), 'pending evaluation');
  const closeStarted = Date.now();
  await json('/browsers/stuck', {}, 'DELETE');
  assert.ok(Date.now() - closeStarted < 11000, 'bounded close');
  assert.equal(await pending, true);
  console.log('PASS: integrated browser API, modal copy, concurrent reuse, case-sensitive session isolation, input, capture, manual close, restart/restore, heartbeat, busy/idle cleanup, terminal-owned shutdown');
  console.log('Artifacts:', dir);
} finally { if (app) await app.close(); fixture.close(); }
