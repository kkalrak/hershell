import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { BrowserManager } from './browser-manager';
import type { TelegramBridge } from './telegram';
import { shellAddresses, resolveShell, ShellAddressError, type ShellSession } from './shell-address';

/** Loopback only; browser requests are rejected. The token changes on every launch. */
export async function startAgentApi(list: () => ShellSession[], deliver: (from: number, to: number, message: string) => Promise<void>, browsers?: () => BrowserManager,
  telegram?: { bridge: () => TelegramBridge; shellForToken: (token: string) => number | undefined }) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const authenticatedShell = telegram?.shellForToken(bearer);
    if (req.headers.origin || (bearer !== token && authenticatedShell === undefined)) {
      reply(401, { error: 'Unauthorized' }); return;
    }
    if (req.method === 'GET' && req.url === '/shells') { reply(200, shellAddresses(list())); return; }
    if (req.method === 'GET' && req.url === '/shells/me') {
      const shells = list(), index = shells.findIndex(s => s.sessionId === authenticatedShell);
      if (index < 0) reply(403, { error: 'Use HERSHELL_SHELL_TOKEN to identify your shell' });
      else reply(200, shellAddresses(shells)[index]);
      return;
    }
    if (telegram && req.method === 'GET' && req.url === '/telegram') {
      const state = telegram.bridge().status(), shells = list();
      const index = shells.findIndex(s => s.sessionId === state.representative);
      reply(200, { ...state, representative: index < 0 ? null : shellAddresses(shells)[index].id }); return;
    }
    if (telegram && req.method === 'POST' && req.url === '/telegram/send') {
      if (authenticatedShell === undefined) { reply(403, { error: 'Use HERSHELL_SHELL_TOKEN for Telegram replies' }); return; }
      try {
        let raw = ''; req.setEncoding('utf8');
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 131072) { reply(413, { error: 'Request too large' }); return; }
        }
        const body = JSON.parse(raw);
        if (resolveShell(list(), body?.from).sessionId !== authenticatedShell) { reply(403, { error: 'Sender does not match shell token' }); return; }
        if (telegram.bridge().status().representative !== authenticatedShell) { reply(403, { error: 'Only the representative can reply' }); return; }
        await telegram.bridge().send(authenticatedShell, body.text);
        reply(200, { sent: true });
      } catch (e) {
        if (e instanceof ShellAddressError) reply(e.status, { error: e.message });
        else reply(503, { error: 'Telegram reply failed. Check connection and text; do not retry automatically.' });
      }
      return;
    }
    if (browsers && req.method === 'GET' && req.url === '/browsers') { reply(200, browsers().list()); return; }
    const browserRoute = /^\/browsers\/([a-zA-Z0-9_-]{1,60})(?:\/([a-z-]+))?$/.exec(req.url ?? '');
    if (browsers && browserRoute) {
      try {
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 1024 * 1024) { reply(413, { error: 'Request too large' }); return; }
        }
        const params = raw ? JSON.parse(raw) : {};
        if (!params || typeof params !== 'object' || Array.isArray(params)) { reply(400, { error: 'Expected JSON object' }); return; }
        const result = await browsers().request(req.method ?? '', browserRoute[1], browserRoute[2] ?? '', params);
        if ('buffer' in result && Buffer.isBuffer(result.buffer)) {
          res.writeHead(200, { 'Content-Type': result.mime, 'Cache-Control': 'no-store', 'X-Capture-Ms': String(result.metrics.captureMs), 'X-Total-Ms': String(result.metrics.totalMs) });
          res.end(result.buffer);
        } else reply(200, result);
      } catch (e) { reply(400, { error: e instanceof Error ? e.message : 'Browser request failed' }); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/messages') { reply(404, { error: 'Not found' }); return; }
    let body = '';
    req.setEncoding('utf8');
    try {
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 65536) { reply(413, { error: 'Message too large' }); return; }
      }
      let input;
      try { input = JSON.parse(body); } catch { reply(400, { error: 'Invalid JSON' }); return; }
      const { from, to, message } = input ?? {};
      if (typeof from !== 'string' || typeof to !== 'string' || typeof message !== 'string' || !message.trim()
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) {
        reply(400, { error: 'Expected {from: folderName, to: folderName, message: nonempty text}' }); return;
      }
      const shells = list();
      const sender = resolveShell(shells, from), recipient = resolveShell(shells, to);
      await deliver(sender.sessionId, recipient.sessionId, message);
      reply(200, { delivered: true });
    } catch (e) {
      if (!res.writableEnded) reply(e instanceof ShellAddressError ? e.status : 503, { error: e instanceof ShellAddressError ? e.message : 'Delivery failed' });
    }
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API address unavailable');
  return { url: `http://127.0.0.1:${address.port}`, token, close: () => { server.close(); server.closeAllConnections(); } };
}
