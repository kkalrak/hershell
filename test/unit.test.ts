// Unit tests for pure logic. Run: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareItems, detect, folderName, WORKING_WINDOW_MS } from '../src/status.ts';
import { parseLayout, loadLayout, saveLayout } from '../src/layout.ts';

const QUIET = WORKING_WINDOW_MS + 1;

test('detect: exited wins over everything', () => {
  assert.deepEqual(detect(['PS C:\\> '], 0, true), { status: 'exited' });
});

test('detect: prompt means idle and gives the folder', () => {
  assert.deepEqual(detect(['out', 'PS C:\\work\\hershe> ', '', ''], 0, false), { status: 'idle', cwd: 'C:\\work\\hershe' });
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
  assert.equal(folderName('C:\\work\\hershe'), 'hershe');
  assert.equal(folderName('C:\\work\\hershe\\'), 'hershe');
  assert.equal(folderName('C:\\'), 'C:\\');
  assert.equal(folderName('Microsoft.PowerShell.Core\\FileSystem::\\\\srv\\share'), 'share');
  assert.equal(folderName(''), '…');
});

test('compareItems: 가나다 order by folder name, stable ties', () => {
  const mk = (cwd: string, id: number) => ({ cwd, id });
  const items = [
    mk('C:\\work\\하', 1), mk('C:\\x\\가', 2), mk('C:\\work\\b', 3), mk('C:\\work\\A', 4),
    mk('C:\\work\\item10', 5), mk('C:\\work\\item2', 6), mk('C:\\a\\gello', 8), mk('C:\\b\\gello', 7),
  ];
  const names = [...items].sort(compareItems).map((i) => `${folderName(i.cwd)}#${i.id}`);
  // Korean collation puts Hangul before Latin; numbers compare numerically; same name -> full path.
  assert.deepEqual(names, ['가#2', '하#1', 'A#4', 'b#3', 'gello#8', 'gello#7', 'item2#6', 'item10#5']);
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
