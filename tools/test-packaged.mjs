// Exercise the actual extracted ZIP, with no Node/npm directory on the app's PATH.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const zip = path.resolve(process.argv[2] ?? `release/hershell-${metadata.version}-windows-x64.zip`);
const dir = mkdtempSync(path.join(os.tmpdir(), 'hershell-portable-test-'));
const extracted = path.join(dir, 'unpacked');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:HERSHELL_TEST_ZIP, $env:HERSHELL_TEST_EXTRACT)"], {
  env: { ...process.env, HERSHELL_TEST_ZIP: zip, HERSHELL_TEST_EXTRACT: extracted }, stdio: 'pipe',
});
const executable = path.join(extracted, 'hershell.exe');
assert.ok(existsSync(executable));
const appRoot = path.join(extracted, 'resources', 'app');
assert.ok(existsSync(path.join(appRoot, 'node_modules', '@lydell', 'node-pty-win32-x64', 'prebuilds', 'win32-x64', 'conpty.node')));

const knownSecrets = existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = /^(TELEGRAM_(?:BOT_TOKEN|OWNER_ID|CHAT_ID))=(.+)$/.exec(line.trim());
  return match ? [match[2].replace(/^['"]|['"]$/g, '')].filter(Boolean) : [];
}) : [];
function audit(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    assert.notEqual(entry.name, '.env', 'Packaged credential file');
    assert.ok(!entry.name.startsWith('telegram.enc'), 'Packaged private settings');
    assert.notEqual(entry.name, '.git', 'Packaged Git metadata');
    if (entry.isDirectory()) audit(full);
    else {
      for (const secret of knownSecrets) assert.ok(!readFileSync(full).includes(Buffer.from(secret)), 'Known credential in package');
    }
  }
}
audit(extracted);

const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<title>Portable browser</title><h1>Portable OK</h1><input id="name"><button onclick="document.title=document.querySelector(\'#name\').value">Apply</button>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const minimalPath = [path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), systemRoot].join(';');
const env = { ...process.env, PATH: minimalPath, Path: minimalPath, HERSHELL_USER_DATA: path.join(dir, 'profile') };
let app;
// Close the native window and await shutdown before disconnecting the debugger.
// Playwright's close disconnects early while our asynchronous quit handler runs.
async function closeApp() {
  const closed = app.waitForEvent('close');
  const child = app.process();
  const exited = new Promise(resolve => child.once('close', resolve));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }).catch(() => {});
  await closed;
  await exited;
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: [], cwd: extracted, env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__hershell?.tail(3).includes('PS '));
  return page;
}
try {
  let page = await launch();
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await page.click('.term.active .xterm-screen');
  await page.keyboard.type("Write-Output 'PORTABLE-SHELL-OK'");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^PORTABLE-SHELL-OK$/m.test(window.__hershell.tail(5)));
  await page.keyboard.type(`cd '${extracted.replace(/'/g, "''")}'`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(cwd => document.querySelector('#list li').title === cwd, extracted);
  await page.click('#extensions');
  await page.click('#copy-usage');
  await page.waitForFunction(() => document.querySelector('#copy-result').textContent.includes('복사했습니다'));
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /POST \/messages/);
  await page.keyboard.press('Escape');
  const info = await page.evaluate(() => window.pty.agentInfo());
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
  const request = async (route, body = {}, method = 'POST') => {
    const result = await fetch(info.url + route, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    assert.equal(result.status, 200, route);
    return result;
  };
  await request('/browsers/portable/navigate', { url: `http://127.0.0.1:${fixture.address().port}` });
  const snapshot = await (await request('/browsers/portable/snapshot')).json();
  assert.equal(snapshot.title, 'Portable browser');
  await request('/browsers/portable/type', { selector: '#name', text: 'Portable input' });
  const png = Buffer.from(await (await request('/browsers/portable/screenshot')).arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  writeFileSync(path.join(dir, 'browser.png'), png);
  await request('/browsers/portable', {}, 'DELETE');
  // Import only a dummy config next to the extracted executable; never use the real bot.
  writeFileSync(path.join(extracted, '.env'), 'TELEGRAM_BOT_TOKEN=123:PortableDummy\nTELEGRAM_OWNER_ID=42\n');
  const state = await page.evaluate(() => window.pty.telegramImport());
  assert.equal(state.configured, true);
  assert.equal(state.representative, null);
  assert.ok(existsSync(path.join(dir, 'profile', 'telegram.enc')));
  await page.screenshot({ path: path.join(dir, 'portable.png') });
  await closeApp(); app = null;
  page = await launch();
  await page.waitForFunction(cwd => document.querySelector('#list li').title === cwd, extracted);
  assert.equal((await page.evaluate(() => window.pty.telegramStatus())).configured, true);
  console.log('PASS: extracted ZIP, exe, native PTY, minimal PATH, shell input, sidebar restore, browser capture, encrypted settings, and package secret audit.');
  console.log('Artifacts:', dir);
} finally { if (app) await closeApp(); fixture.closeAllConnections(); fixture.close(); }
