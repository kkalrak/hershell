// Sidebar persistence: each item's last folder and the active item.
// Shell contents are never restored; each saved item reopens as an empty shell in its folder.

export interface Layout {
  cwds: string[];
  active: number;
  shellKeys?: string[];
}

export function isShellKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

const KEY = 'hershell.layout.v2';

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function parseLayout(raw: string | null): Layout | null {
  try {
    const l = JSON.parse(raw ?? 'null');
    if (l && Array.isArray(l.cwds) && l.cwds.length > 0) {
      const cwds = l.cwds.map((c: unknown) => (typeof c === 'string' ? c : ''));
      const active = Number.isInteger(l.active) && l.active >= 0 && l.active < cwds.length ? l.active : 0;
      const keys = Array.isArray(l.shellKeys) && l.shellKeys.length === cwds.length && l.shellKeys.every(isShellKey)
        ? l.shellKeys.map((key: string) => key.toLowerCase()) : null;
      return { cwds, active, ...(keys && new Set(keys).size === keys.length ? { shellKeys: keys } : {}) };
    }
  } catch { /* broken data: start fresh */ }
  return null;
}

export function loadLayout(store: KV = localStorage): Layout | null {
  try {
    return parseLayout(store.getItem(KEY));
  } catch {
    return null; // storage unavailable
  }
}

export function saveLayout(layout: Layout, store: KV = localStorage): void {
  try { store.setItem(KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ }
}
