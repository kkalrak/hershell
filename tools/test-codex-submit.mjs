// Optional real Codex TUI test. Requires an installed, signed-in CLI and may use quota.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(os.tmpdir(), 'hershell-codex-submit-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, HERSHELL_USER_DATA: dir, TERM: 'xterm-256color' } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__hershell?.tail(3).includes('PS '));
  await page.click('.term.active .xterm-screen');
  await page.keyboard.type('codex --no-alt-screen --sandbox read-only --ask-for-approval never -C C:\\work\\hershell');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__hershell.tail(30).includes('Ask Codex to do anything'), null, { timeout: 30000 });
  // Wait for CLI startup/terminal-mode negotiation before testing an established composer.
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => window.pty.agentInfo());
  const shells = await (await fetch(info.url + '/shells', { headers: { Authorization: 'Bearer ' + info.token } })).json();
  const response = await fetch(info.url + '/messages', {
    method: 'POST', headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: shells[0].id, to: shells[0].id, message: '입력 제출 테스트다. 도구 쓰지 마라. 파일 건드리지 마라. 다음 x 문자는 무시해라.\n' + 'x'.repeat(12000) + '\nENTER_OK 한 단어만 답해라.' }),
  });
  assert.equal(response.status, 200);
  await page.waitForFunction(() => /(?:Working|Thinking) \(|^\s*[•◦] ENTER_OK\s*$/m.test(window.__hershell.tail(20)), null, { timeout: 15000 });
  await page.screenshot({ path: path.join(dir, 'submitted.png') });
  console.log('PASS: actual Codex TUI accepted and submitted a 12k-character API message. Artifacts:', dir);
} catch(e) {
  const p=app.windows()[0];
  console.log('Failed test tail:',await p.evaluate(()=>window.__hershell.tail(20)));
  await p.screenshot({path:path.join(dir,'failure.png')});
  console.log('Artifacts:',dir);
  throw e;
} finally { await app.close(); }
