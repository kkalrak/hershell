import { CONVERSATION_RULE, TELEGRAM_FORMAT_RULE } from '../src/agent-instructions.ts';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hershell-telegram-test-'));
const profile = path.join(dir, 'profile');
const token = '123:DummyTestToken';
const receivedFile = path.join(dir, 'received.json');
const shellTokenFile = path.join(dir, 'shell-token');
const receiver = path.join(dir, 'receiver.cjs');
writeFileSync(receiver, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(shellTokenFile)},process.env.HERSHELL_SHELL_TOKEN);process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004hRECEIVER-READY');let input='',messages=[];process.stdin.on('data',b=>{input+=b.toString();if(input.endsWith('\\x1b[201~\\r')){messages.push(input);input='';fs.writeFileSync(${JSON.stringify(receivedFile)},JSON.stringify(messages));}});`);
const update = (id, text, owner = 42) => ({ update_id: id, message: { message_id: id + 100, date: Math.floor(Date.now()/1000), text, chat: { id: owner, type: 'private' }, from: { id: owner } } });
let updates = [update(1, 'OLD-MUST-NOT-RUN')], conflict = false, webhook = '', outgoing = [], calls = [];
const mock = createServer(async (req, res) => {
  let raw = '';for await(const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const method = req.url.split('/').at(-1); calls.push({method, body});
  const reply = value => { if(!res.destroyed) { res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value)); } };
  if(method === 'getMe') return reply({ok:true,result:{username:'hershell_test_bot'}});
  if(method === 'getWebhookInfo') return reply({ok:true,result:{url:webhook}});
  if(method === 'sendMessage') { outgoing.push(body);return reply({ok:true,result:{message_id:1000}}); }
  if(method === 'getUpdates') {
    if(conflict) return reply({ok:false,error_code:409});
    const found = body.offset === -1 ? updates.slice(-1) : updates.filter(u => u.update_id >= body.offset);
    if(!found.length) await new Promise(r=>setTimeout(r,180));
    return reply({ok:true,result:found});
  }
  reply({ok:false,error_code:404});
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const env={...process.env,HERSHELL_USER_DATA:profile,HERSHELL_TELEGRAM_TEST_URL:`http://127.0.0.1:${mock.address().port}`};
let app, page, info;
async function until(check, label) {
 const deadline=Date.now()+12000;
 while(!(await check())){if(Date.now()>deadline)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,100));}
}
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
async function launch(){
 app=await electron.launch({args:['.'],env});page=await app.firstWindow();
 await page.waitForFunction(()=>window.__hershell?.tail(3).includes('PS '));
 info=await page.evaluate(()=>window.pty.agentInfo());
}
const state=()=>page.evaluate(()=>window.pty.telegramStatus());
async function bind(id){
 await page.locator(`#list li[data-shell-id="${id}"]`).click({button:'right'});
 await page.click('#telegram-assign');
 await until(async()=>(await state()).phase==='connected','bind');
}
const received=()=>existsSync(receivedFile)?JSON.parse(readFileSync(receivedFile,'utf8')):[];
try {
 await launch();
 assert.equal((await state()).configured,false);
 assert.equal(calls.length,0,'no network on unconfigured startup');
 await page.click('.term.active .xterm-screen');
 await page.keyboard.type('cd C:\\work\\hershell');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#list li').title==='C:\\work\\hershell');
 await page.click('#extensions');
 await page.fill('#telegram-token',token);await page.fill('#telegram-chat','42');
 await page.click('#telegram-settings button[type=submit]');
 await page.waitForFunction(()=>document.querySelector('#telegram-result').textContent==='적용했습니다.');
 assert.equal((await state()).configured,true);
 assert.equal(readFileSync(path.join(profile,'telegram.enc')).includes(Buffer.from(token)),false);
 assert.equal(JSON.stringify(await state()).includes(token),false);
 await page.click('#telegram-check');
 await page.waitForFunction(()=>document.querySelector('#telegram-result').textContent.includes('hershell_test_bot'));
 await page.click('#copy-telegram-usage');
 await page.waitForFunction(()=>document.querySelector('#telegram-result').textContent.includes('복사했습니다'));
 const usage=await app.evaluate(({clipboard})=>clipboard.readText());
 assert.ok(usage.includes(CONVERSATION_RULE));
 assert.ok(usage.includes(TELEGRAM_FORMAT_RULE));
 assert.match(usage,/앱 다시 켜면 같은 셸에 자동 연결한다/);
 assert.match(usage,/POST \/telegram\/send/);assert.match(usage,/HERSHELL_SHELL_TOKEN/);assert.equal(usage.includes(token),false);
 await page.screenshot({path:path.join(dir,'telegram-settings.png')});
 await page.keyboard.press('Escape');
 await page.waitForSelector('#extensions-dialog', { state: 'hidden' });
 await page.click('.term.active .xterm-screen');
 await page.keyboard.type(`node "${receiver}"`);await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__hershell.tail(5).includes('RECEIVER-READY'));
 await bind(1);
 await until(()=>calls.some(c=>c.method==='getUpdates'&&c.body.offset===2),'skip backlog');
 updates.push(update(2,'UNAUTHORIZED',99),update(3,'한글 지시 전달해라'));
 await until(()=>received().length===1,'incoming text and Enter');
 assert.ok(received()[0].includes(CONVERSATION_RULE));
 assert.ok(received()[0].includes(TELEGRAM_FORMAT_RULE));
 assert.match(received()[0],/한글 지시 전달해라/);
 assert.match(received()[0],/요청 #103/);
 assert.equal(received()[0].includes('OLD-MUST-NOT-RUN'),false);
 assert.equal(received()[0].includes('UNAUTHORIZED'),false);
 await until(()=>calls.some(c=>c.method==='getUpdates'&&c.body.offset===4),'offset acknowledged');
 assert.equal(received().length,1,'no duplicate delivery');
 await page.screenshot({path:path.join(dir,'representative.png')});
 const bearer=readFileSync(shellTokenFile,'utf8');
 const send=(key,from,text)=>fetch(info.url+'/telegram/send',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from,text})});
 assert.equal((await send(info.token,'hershell','not allowed')).status,403);
 assert.equal((await send(bearer,'missing','spoof')).status,404);
 assert.equal((await send(bearer,'hershell','요청 #103 답이다.')).status,200);
 assert.deepEqual(outgoing.map(x=>x.text),['요청 #103 답이다.']);
 await page.click('#add');
 await page.waitForFunction(()=>document.querySelectorAll('#list li').length===2&&window.__hershell.tail(3).includes('PS '));
 assert.equal((await send(bearer,path.basename(os.homedir()),'spoof existing shell')).status,403);
 await bind(2);
 assert.equal(await page.locator('.telegram-badge').count(),1);
 assert.equal(await page.locator('#list li[data-shell-id="2"] .telegram-badge').count(),1);
 assert.equal((await send(bearer,'hershell','old representative')).status,403);
 await page.locator('#list li[data-shell-id="2"]').hover();await page.locator('#list li[data-shell-id="2"] .close').click();
 await until(async()=>(await state()).representative===null,'closed representative unbound');
 assert.equal(await page.locator('.telegram-badge').count(),0);
 webhook='https://already-configured.invalid';
 await page.evaluate(()=>window.pty.telegramSelect(1));
 assert.match((await state()).error,/웹훅/);
 assert.equal((await state()).representative,1);
 assert.equal(await page.locator('#list li[data-shell-id="1"] .telegram-badge.connection-error').count(),1);
 webhook='';conflict=true;
 await page.evaluate(()=>window.pty.telegramSelect(1));
 await until(async()=>(await state()).phase==='error','polling conflict');
 assert.equal((await state()).representative,1);assert.match((await state()).error,/다른 프로그램/);
 assert.equal(await page.locator('#list li[data-shell-id="1"] .telegram-badge.connection-error').count(),1);
 conflict=false;
 await page.locator('#list li[data-shell-id="1"]').click({button:'right'});
 assert.equal(await page.locator('#telegram-assign').textContent(),'텔레그램 다시 연결');
 await page.click('#telegram-assign');
 await until(async()=>(await state()).phase==='connected','reconnect replaces failed connection');
 assert.equal((await state()).representative,1);
 assert.equal(await page.locator('.telegram-badge').count(),1);
 assert.equal(await page.locator('.telegram-badge.connection-error').count(),0);
 await page.evaluate(()=>window.pty.telegramSelect(null));
 assert.equal((await state()).representative,null);
 await page.evaluate(()=>window.pty.telegramSelect(1));
 await until(async()=>(await state()).phase==='connected','rebind');
 // Reorder the restored numeric handles and add an identical folder to prove
 // representative restoration uses the saved entry key, not order or folder name.
 await page.click('#add');
 await page.waitForFunction(()=>document.querySelectorAll('#list li').length===2&&window.__hershell.tail(3).includes('PS '));
 await page.click('#add');
 await page.waitForFunction(()=>document.querySelectorAll('#list li').length===3&&window.__hershell.tail(3).includes('PS '));
 await page.keyboard.type('cd C:\\work\\hershell');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>[...document.querySelectorAll('#list li')].filter(li=>li.title==='C:\\work\\hershell').length===2);
 const savedRepresentativeKey = await page.evaluate(()=>{
   const rows=[...document.querySelectorAll('#list li')];
   return JSON.parse(localStorage.getItem('hershell.layout.v2')).shellKeys[rows.findIndex(li=>li.dataset.shellId==='1')];
 });
 await closeApp();app=null;
 await launch();
 assert.equal((await state()).configured,true);
 await until(async()=>(await state()).phase==='connected','restore selected representative');
 const restoredRepresentative = (await state()).representative;
 assert.equal(restoredRepresentative,2,'same entry gets a different runtime handle after reordering');
 const restoredKey = await page.evaluate(id=>{
   const rows=[...document.querySelectorAll('#list li')];
   return JSON.parse(localStorage.getItem('hershell.layout.v2')).shellKeys[rows.findIndex(li=>Number(li.dataset.shellId)===id)];
 },restoredRepresentative);
 assert.equal(restoredKey,savedRepresentativeKey);
 assert.equal(await page.locator('.telegram-badge').count(),1);
 await page.evaluate(()=>window.pty.telegramSelect(null));
 await closeApp();app=null;
 await launch();
 assert.equal((await state()).configured,true);
 assert.equal((await state()).representative,null,'explicit unassign survives restart');
 assert.equal((await state()).phase,'ready');
 await page.click('#extensions');await page.click('#telegram-clear');
 await until(async()=>(await state()).configured===false,'clear');
 assert.equal(existsSync(path.join(profile,'telegram.enc')),false);
 assert.equal(existsSync(path.join(profile,'telegram.enc.disabled')),true);
 await closeApp();app=null;
 await launch();
 assert.equal((await state()).configured,false,'disconnect survives restart');
 assert.equal((await state()).representative,null);
 console.log('PASS: Telegram UI, encrypted settings, private sender filter, backlog skip, terminal paste+Enter, representative switch/exit, shell-authenticated reply, webhook/conflict errors, restart and deletion.');
 console.log('Artifacts:',dir);
} finally {if(app)await closeApp();mock.closeAllConnections();mock.close();}
