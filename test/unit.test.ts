// Unit tests for pure logic. Run: npm test  (Node strips the TypeScript types itself)
import { shellAddresses, resolveShell, ShellAddressError } from '../src/shell-address.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareItems, detect, folderName, WORKING_WINDOW_MS } from '../src/status.ts';
import { validateTelegramConfig } from '../src/telegram.ts';
import { MessageDelivery } from '../src/message-delivery.ts';
import { parseLayout, loadLayout, saveLayout } from '../src/layout.ts';

const QUIET = WORKING_WINDOW_MS + 1;

test('detect: exited wins over everything', () => {
  assert.deepEqual(detect(['PS C:\\> '], 0, true), { status: 'exited' });
});

test('detect: prompt means idle and gives the folder', () => {
  assert.deepEqual(detect(['out', 'PS C:\\work\\hershell> ', '', ''], 0, false), { status: 'idle', cwd: 'C:\\work\\hershell' });
});

test('detect: approval question means blocked', () => {
  for (const q of ['Do you want to proceed?', 'Allow once', '(y/n)', '[Y/n]', "Yes, and don't ask again", 'Press Enter to confirm']) {
    assert.equal(detect(['x', q], QUIET, false).status, 'blocked', q);
  }
});

test('detect: recent output is working, quiet is done', () => {
  assert.equal(detect(['building...'], 10, false).status, 'working');
  assert.equal(detect(['finished'], QUIET, false).status, 'done');
});

test('detect: an old prompt above new output is not idle', () => {
  assert.equal(detect(['PS C:\\> ', 'running claude'], QUIET, false).status, 'done');
});

test('folderName', () => {
  assert.equal(folderName('C:\\work\\hershell'), 'hershell');
  assert.equal(folderName('C:\\work\\hershell\\'), 'hershell');
  assert.equal(folderName('C:\\'), 'C:\\');
  assert.equal(folderName('Microsoft.PowerShell.Core\\FileSystem::\\\\srv\\share'), 'share');
  assert.equal(folderName(''), '…');
});

test('compareItems: 가나다 order by folder name, stable ties', () => {
  const mk = (cwd: string, id: number) => ({ cwd, id });
  const items = [
    mk('C:\\work\\하', 1), mk('C:\\x\\가', 2), mk('C:\\work\\b', 3), mk('C:\\work\\A', 4),
    mk('C:\\work\\item10', 5), mk('C:\\work\\item2', 6), mk('C:\\a\\folder', 8), mk('C:\\b\\folder', 7),
  ];
  const names = [...items].sort(compareItems).map((i) => `${folderName(i.cwd)}#${i.id}`);
  // Korean collation puts Hangul before Latin; numbers compare numerically; same name -> full path.
  assert.deepEqual(names, ['가#2', '하#1', 'A#4', 'b#3', 'folder#8', 'folder#7', 'item2#6', 'item10#5']);
  assert.equal(compareItems(mk('C:\\same', 1), mk('C:\\same', 2)) < 0, true);
});

test('parseLayout: valid, clamped, broken', () => {
  assert.deepEqual(parseLayout('{"cwds":["C:\\\\a","C:\\\\b"],"active":1}'), { cwds: ['C:\\a', 'C:\\b'], active: 1 });
  assert.deepEqual(parseLayout('{"cwds":["a"],"active":5}'), { cwds: ['a'], active: 0 });
  assert.deepEqual(parseLayout('{"cwds":[1,"b"],"active":0}'), { cwds: ['', 'b'], active: 0 });
  assert.equal(parseLayout('{"cwds":[]}'), null);
  assert.equal(parseLayout('not json'), null);
  assert.equal(parseLayout(null), null);
});

test('load/save round trip', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(loadLayout(store), null);
  saveLayout({ cwds: ['C:\\new'], active: 0 }, store);
  assert.deepEqual(loadLayout(store), { cwds: ['C:\\new'], active: 0 });
});


test('message delivery: serial per recipient, independent across recipients', async () => {
  const sent: { id: number; to: number; message: string }[] = [];
  const delivery = new MessageDelivery((id, to, message) => sent.push({ id, to, message }));
  try {
    const first = delivery.deliver(1, 2, 'first');
    const second = delivery.deliver(1, 2, 'second');
    const other = delivery.deliver(1, 3, 'other');
    await new Promise(setImmediate);
    assert.deepEqual(sent.map(s => s.to), [2, 3]);
    assert.match(sent[0].message, /first$/);
    delivery.acknowledge(sent[0].id, true);
    await first;
    await new Promise(setImmediate);
    assert.match(sent[2].message, /second$/);
    delivery.acknowledge(sent[1].id, true);
    delivery.acknowledge(sent[2].id, true);
    await Promise.all([second, other]);
  } finally { delivery.close(); }
});

test('message delivery: failed recipient does not block later delivery; close cancels pending work', async () => {
  const ids: number[] = [];
  const delivery = new MessageDelivery(id => ids.push(id));
  const failed = assert.rejects(delivery.deliver(1, 2, 'first'), /Delivery failed/);
  const next = delivery.deliver(1, 2, 'second');
  const cancelled = assert.rejects(next, /Delivery failed/);
  await new Promise(setImmediate);
  delivery.acknowledge(ids[0], false);
  await failed;
  await new Promise(setImmediate);
  assert.equal(ids.length, 2);
  delivery.close();
  await cancelled;
  await assert.rejects(delivery.deliver(1, 2, 'after close'), /Delivery stopped/);
  assert.equal(ids.length, 2);
});


test('message delivery: unbinding cancels pending and queued Telegram submissions', async () => {
  const ids: number[] = [];
  const delivery = new MessageDelivery(id => ids.push(id));
  const controller = new AbortController();
  const pending = assert.rejects(delivery.deliver(0, 1, 'first', controller.signal), /Delivery failed/);
  const queued = assert.rejects(delivery.deliver(0, 1, 'second', controller.signal), /Delivery stopped/);
  await new Promise(setImmediate);
  assert.equal(delivery.isPending(ids[0]), true);
  controller.abort();
  assert.equal(delivery.isPending(ids[0]), false);
  await Promise.all([pending, queued]);
  assert.equal(ids.length, 1);
  delivery.close();
});

test('Telegram config: require bot token and a safe private chat ID', () => {
  assert.deepEqual(validateTelegramConfig({ token: ' 123:FakeToken ', chatId: ' 42 ' }), { token: '123:FakeToken', chatId: '42' });
  for (const chatId of ['-42', '0', 'abc', '9007199254740993']) {
    assert.throws(() => validateTelegramConfig({ token: '123:FakeToken', chatId }));
  }
  assert.throws(() => validateTelegramConfig({ token: 'not-a-token', chatId: '42' }));
});


test('shell addresses: folder IDs survive ordering and new earlier shells', () => {
  const shells = [{ sessionId: 3, cwd: 'C:/work/minecraft' }, { sessionId: 7, cwd: 'C:/work/hershell' }];
  assert.deepEqual(shellAddresses(shells).map(s => s.id), ['minecraft', 'hershell']);
  const reordered = [{ sessionId: 11, cwd: 'C:/work/aaa' }, shells[1], shells[0]];
  assert.equal(resolveShell(reordered, 'minecraft').sessionId, 3);
  assert.equal(resolveShell(reordered, 'HERSHELL').sessionId, 7);
  assert.equal(resolveShell(reordered, 'c:/work/minecraft/').sessionId, 3);
  assert.throws(() => resolveShell(reordered, 1), (e: unknown) => e instanceof ShellAddressError && e.status === 400);
  assert.throws(() => resolveShell(reordered, 'missing'), (e: unknown) => e instanceof ShellAddressError && e.status === 404);
});

test('shell addresses: ambiguous folders require path; identical paths are never guessed', () => {
  const shells = [{ sessionId: 1, cwd: 'C:/a/same' }, { sessionId: 2, cwd: 'C:/b/same' }];
  assert.deepEqual(shellAddresses(shells).map(s => s.id), ['C:/a/same', 'C:/b/same']);
  assert.throws(() => resolveShell(shells, 'same'), (e: unknown) => e instanceof ShellAddressError && e.status === 409);
  assert.equal(resolveShell(shells, 'C:/b/same').sessionId, 2);
  shells.push({ sessionId: 3, cwd: 'c:/b/same' });
  assert.throws(() => resolveShell(shells, 'C:/b/same'), (e: unknown) => e instanceof ShellAddressError && e.status === 409);
});


test('parseLayout: persistent shell keys survive sorting; invalid and duplicate keys are ignored', () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  assert.deepEqual(parseLayout(JSON.stringify({ cwds: ['b', 'a'], active: 1, shellKeys: [b, a] })), { cwds: ['b', 'a'], active: 1, shellKeys: [b, a] });
  for (const shellKeys of [[a], [a, a], [a, 'invalid']]) {
    assert.deepEqual(parseLayout(JSON.stringify({ cwds: ['b', 'a'], active: 1, shellKeys })), { cwds: ['b', 'a'], active: 1 });
  }
  assert.deepEqual(parseLayout('{"cwds":["old"],"active":0}'), { cwds: ['old'], active: 0 });
});
