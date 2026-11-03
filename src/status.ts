// Pure helpers for the sidebar: status detection and folder names.
// No DOM / xterm imports here so this file can be unit-tested with plain Node.

export type Status = 'working' | 'blocked' | 'done' | 'idle' | 'exited';

/** How many lines above the cursor are inspected. Keep small: this runs every STATUS_MS for every shell. */
export const TAIL_LINES = 12;
export const STATUS_MS = 300;
export const WORKING_WINDOW_MS = 1000;

const BLOCKED_RE =
  /(do you want to|allow (once|always)|approve|\(y\/n\)|\[y\/n\]|yes, and don't ask|press enter to confirm|waiting for (your )?approval)/i;
// The PowerShell prompt "PS C:\path> " also tells us the current folder.
const PROMPT_RE = /^PS ([^>]*)>\s*$/;

export interface Detection {
  status: Status;
  /** Current folder, only known when the shell is sitting at its prompt. */
  cwd?: string;
}

/**
 * Decide a shell's status from the last lines of its buffer.
 * Order matters: exited > idle prompt > approval question > recent output > done.
 */
export function detect(lines: string[], msSinceOutput: number, exited: boolean): Detection {
  if (exited) return { status: 'exited' };
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { last = lines[i]; break; }
  }
  const prompt = PROMPT_RE.exec(last);
  if (prompt) return { status: 'idle', cwd: prompt[1].trim() || undefined };
  if (lines.some((l) => BLOCKED_RE.test(l))) return { status: 'blocked' };
  if (msSinceOutput < WORKING_WINDOW_MS) return { status: 'working' };
  return { status: 'done' };
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/**
 * Sidebar sort order: 가나다 / alphabetical by folder name (Korean collation, numbers in numeric order).
 * Ties fall back to the full path, then to creation order, so the order is stable.
 */
export function compareItems(a: { cwd: string; id: number }, b: { cwd: string; id: number }): number {
  return collator.compare(folderName(a.cwd), folderName(b.cwd))
    || collator.compare(a.cwd, b.cwd)
    || a.id - b.id;
}

/** Sidebar title for a folder: last path segment, or the drive root itself ("C:\"). */
export function folderName(cwd: string): string {
  if (!cwd) return '…';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && !/^[A-Za-z]:$/.test(last) ? last : cwd;
}
