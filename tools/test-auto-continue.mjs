import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hershell-auto-test-'));
const fixture = path.join(dir, 'receiver.cjs');
writeFileSync(fixture, `
const fs=require('fs'),path=require('path'),name=process.argv[2],dir=${JSON.stringify(dir)};
fs.writeFileSync(path.join(dir,name+'.token'),process.env.HERSHELL_SHELL_TOKEN);
process.stdin.setRawMode(true);process.stdin.resume();let input='',messages=[];
const prompt=()=>process.stdout.write('\\x1b[2J\\x1b[H❯ \\x1b[2mTry...\\x1b[22m\\x1b[6D');
process.stdout.write('\\x1b[?2004h');prompt();
process.stdin.on('data',b=>{input+=b.toString();if(input.endsWith('\\x1b[201~\\r')){
messages.push(input);fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(messages));input='';prompt();
}else if(!input.includes('\\x1b[200~'))input='';});
`);
let app;
const received = name => existsSync(path.join(dir,name+'.json')) ? JSON.parse(readFileSync(path.join(dir,name+'.json'),'utf8')) : [];
async function until(check, label, ms = 22000) {
  const deadline = Date.now()+ms;
  while (!await check()) { if(Date.now()>deadline) throw Error('Timed out: '+label); await new Promise(r=>setTimeout(r,100)); }
}
try {
  app=await electron.launch({args:['.'],env:{...process.env,HERSHELL_USER_DATA:path.join(dir,'profile')}});
  const page=await app.firstWindow();
  await page.waitForFunction(()=>window.__hershell?.tail(3).includes('PS '));
  const info=await page.evaluate(()=>window.pty.agentInfo());
  for (const name of ['one','two']) {
    if(name==='two') { await page.click('#add'); await page.waitForFunction(()=>document.querySelectorAll('#list li').length===2&&window.__hershell.tail(3).includes('PS ')); }
    await page.click('.term.active .xterm-screen');
    await page.keyboard.type(`node "${fixture}" ${name}`); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.__hershell.tail(3).includes('❯'));
  }
  const token=name=>readFileSync(path.join(dir,name+'.token'),'utf8');
  const request=(name,state)=>fetch(info.url+'/task',{method:state?'POST':'GET',headers:{Authorization:'Bearer '+(name==='shared'?info.token:token(name)),'Content-Type':'application/json'},...(state?{body:JSON.stringify({state})}:{})});
  assert.equal((await request('shared')).status,403);
  assert.equal((await request('one','invalid')).status,400);
  assert.equal((await (await request('two')).json()).enabled,false);
  await page.click('#extensions');
  await page.click('#copy-auto-usage');
  const usage=await app.evaluate(({clipboard})=>clipboard.readText());
  assert.match(usage,/POST \/task/); assert.match(usage,/HERSHELL_SHELL_TOKEN/); assert.match(usage,/blocked/);
  await page.click('[data-send-kind="auto"][data-send-target="current"]');
  await until(()=>received('two').length===1,'current usage');
  assert.equal(received('one').length,0);
  assert.match(received('two')[0],/hershell 허셀/);
  assert.ok(received('two')[0].endsWith('\x1b[201~\r'));
  await page.click('[data-send-kind="message"][data-send-target="all"]');
  await until(()=>received('one').length===1&&received('two').length===2,'all usage');
  await page.screenshot({path:path.join(dir,'extensions.png')});
  await page.keyboard.press('Escape');
  await page.locator('#list li[data-shell-id="2"]').click({button:'right'});
  await page.click('#auto-toggle');
  await until(async()=>(await (await request('two')).json()).enabled,'enabled');
  assert.equal((await (await request('one')).json()).enabled,false);
  await request('two','waiting');
  const waiting=await (await request('two')).json();
  await until(()=>received('two').length===3,'automatic continue');
  assert.match(received('two')[2],/계속해/);
  assert.equal((await (await request('two')).json()).state,'working');
  // Same report cannot submit twice; complete/blocked invalidate stale versions.
  await page.evaluate(({id,version})=>window.pty.autoContinue(id,version),{id:2,version:waiting.version});
  await request('two','complete');
  await page.evaluate(({id,version})=>window.pty.autoContinue(id,version),{id:2,version:waiting.version});
  await request('two','blocked');
  assert.equal((await (await request('two')).json()).state,'blocked');
  await request('two','waiting');
  await page.click('.term.active .xterm-screen'); await page.keyboard.type('x');
  await until(async()=>(await (await request('two')).json()).state==='working','user input cancels waiting');
  await page.waitForTimeout(11000);
  assert.equal(received('two').length,3,'no duplicate or cancelled continuation');
  await page.locator('#list li[data-shell-id="2"]').click({button:'right'}); await page.click('#auto-toggle');
  assert.equal((await (await request('two')).json()).enabled,false);
  console.log('PASS: scoped task API, current/all usage + Enter, per-shell toggle, one-shot continuation, completed/blocked/stale report, user input cancellation. Artifacts:',dir);
} finally { if(app) await app.close(); }
