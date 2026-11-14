const $ = id => document.getElementById(id);
async function act(action, params) { try { $('message').textContent=''; return await window.browser.command(action,params); } catch(e) { $('message').textContent=e.message; } }
function render(s) {
  document.title = `hershell Browser · ${s.id}`;
  $('instance').textContent=s.id; $('endpoint').textContent=s.connection?.baseUrl || '';
  if(document.activeElement!==$('url')) $('url').value=s.url?.startsWith('http')?s.url:'';
  if(s.lastCapture) $('metrics').textContent=`${s.lastCapture.totalMs} ms · ${Math.round(s.lastCapture.bytes/1024)} KB · ${s.lastCapture.width} × ${s.lastCapture.height}`;
  $('logs').replaceChildren(...s.logs.slice(0,15).map(l=>{const d=document.createElement('div');d.className='log';d.textContent=`${l.time.slice(11,19)}  ${l.action} ${l.detail}`;return d;}));
}
$('navigation').onsubmit=e=>{e.preventDefault();let url=$('url').value.trim();if(!/^https?:\/\//i.test(url))url='https://'+url;act('navigate',{url});};
for(const action of ['back','forward','reload']) $(action).onclick=()=>act(action);
$('copy').onclick=()=>window.browser.copyConnection();
$('apply').onclick=()=>act('user-agent',{value:$('ua').value});
let previewURL;
$('capture').onclick=async()=>{const r=await act('screenshot');if(r){if(previewURL)URL.revokeObjectURL(previewURL);previewURL=URL.createObjectURL(new Blob([r.buffer],{type:r.mime}));$('preview').src=previewURL;$('preview').hidden=false;}};
window.browser.onState(render);window.browser.state().then(render);
