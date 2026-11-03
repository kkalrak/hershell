// Drives the app with Playwright: real mouse/keyboard input + screenshots.
// Usage: node tools/drive.mjs <screenshot-dir>
import { _electron as electron } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'shots';
mkdirSync(outDir, { recursive: true });

import { rmSync } from 'node:fs';
import os from 'node:os';
const profile = path.join(os.tmpdir(), 'hershell-test-profile');
rmSync(profile, { recursive: true, force: true });
const env = { ...process.env, HERSHELL_USER_DATA: profile };
const hangulDir = path.join(os.tmpdir(), 'hershell-test-dirs', '가나다');

const app = await electron.launch({ args: ['.'], env });
const page = await app.firstWindow();
await page.waitForSelector('.xterm-screen');
const wait = (ms) => page.waitForTimeout(ms);
let n = 0;
const shot = async (name) => {
  const file = path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log('shot', file);
};
const status = () => page.$$eval('#list li', (lis) =>
  lis.map((li) => `${li.querySelector('.title').textContent}:${li.querySelector('.dot').className.replace('dot ', '')}`).join(', '));
const run = async (cmd) => { await page.keyboard.type(cmd); await page.keyboard.press('Enter'); };

await wait(1500);
await shot('start');

// 1. typing in the shell
await page.click('.term.active .xterm-screen');
await run('echo hello-from-claude');
await wait(800);
await shot('typed');

// 2. speed: print 50k lines and time until the prompt comes back
const t0 = Date.now();
await run('1..50000 | % { "line $_ ---------------------------------------------" }; "DONE-MARK"');
await page.waitForFunction(() => /^DONE-MARK/m.test(window.__hershell.tail(5)), null, { timeout: 60000 });
console.log('50k lines rendered in', Date.now() - t0, 'ms');
await shot('50k-lines');

// 3. status: working while output streams
await run('1..8 | % { "tick $_"; Start-Sleep -Milliseconds 400 }');
await wait(700);
console.log('during output:', await status());
await wait(3500);

// 4. status: blocked on an approval-like question
await run('Read-Host "Do you want to proceed (y/n)"');
await wait(900);
console.log('approval prompt:', await status());
await shot('blocked');
await run('y');
await wait(900);
console.log('back at prompt:', await status());

// 5. sidebar: add a second shell with the mouse
await page.click('#add');
await wait(1500);
await run('echo second-shell');
await wait(800);
await shot('second-shell');

// 6. switch back to the first item
await page.click('#list li:nth-child(1)');
await wait(500);
await shot('switched-back');

// Rows are auto-sorted by folder name, so find them by title, not by position.
const byTitle = (t) => page.locator('#list li').filter({ has: page.locator('.title', { hasText: new RegExp(`^${t.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`) }) }).first();
const titles = () => page.$$eval('#list li .title', (t) => t.map((x) => x.textContent).join(', '));

// 7. title follows the folder and the list re-sorts live (가나다 / alphabetical)
await page.click('#list li:nth-child(2)');
await run('cd C:\\work');
await wait(1000);
console.log('after cd C:\\work :', await titles());
await run('cd C:\\');
await wait(1000);
console.log('after cd C:\\     :', await titles());

// 8. keyboard shortcut Ctrl+Shift+T, then move the new shell around
await page.keyboard.press('Control+Shift+T');
await wait(1500);
console.log('after Ctrl+Shift+T:', await titles());
await run(`New-Item -ItemType Directory -Force '${hangulDir}' | Out-Null; cd '${hangulDir}'`);
await wait(1200);
console.log('after cd 가나다    :', await titles());
await run("cd 'C:\\Program Files'");
await wait(1000);
console.log('after cd Program Files:', await titles());
await shot('sorted');

// 9. close the "C:\" item
await byTitle('C:\\').hover();
await byTitle('C:\\').locator('.close').click();
await wait(500);
console.log('after close C:\\  :', await status());
await shot('final');

// 10. persistence: close and reopen, sidebar should come back
await byTitle('Program Files').click();
await wait(300);
await run('cd C:\\work\\hershell\\src');            // folder should be remembered
await wait(1200);
const before = await status();
await app.close();

const app2 = await electron.launch({ args: ['.'], env });
const page2 = await app2.firstWindow();
await page2.waitForSelector('.xterm-screen');
await page2.waitForTimeout(2000);
const after = await page2.$$eval('#list li', (lis) =>
  lis.map((li) => `${li.querySelector('.title').textContent}${li.classList.contains('active') ? '*' : ''}`).join(', '));
console.log('before restart:', before);
console.log('after restart :', after);
console.log('restored prompt:', (await page2.evaluate(() => window.__hershell.tail(3))).trim());
await page2.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-restored.png`) });
await page2.keyboard.press('Control+Shift+T');
await page2.waitForTimeout(1500);
console.log('new item after restore:', await page2.$$eval('#list li .title', (t) => t.map((x) => x.textContent).join(', ')));
await app2.close();
