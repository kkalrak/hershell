import { folderName } from './status.ts';

export interface ShellSession { sessionId: number; cwd: string }
export interface ShellAddress { id: string; cwd: string }
const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC').toLowerCase();

/** Folder names are public addresses; the numeric PTY handle stays private. */
export function shellAddresses(shells: ShellSession[]): ShellAddress[] {
  return shells.map(shell => {
    const name = folderName(shell.cwd);
    const duplicated = shells.filter(s => key(folderName(s.cwd)) === key(name)).length > 1;
    return { id: duplicated ? shell.cwd : name, cwd: shell.cwd };
  });
}

export class ShellAddressError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function resolveShell(shells: ShellSession[], address: unknown): ShellSession {
  if (typeof address !== 'string' || !address.trim()) throw new ShellAddressError(400, 'Use a folder name or full path as shell ID');
  const matches = shells.filter(s => key(folderName(s.cwd)) === key(address) || key(s.cwd) === key(address));
  if (!matches.length) throw new ShellAddressError(404, 'Shell not found or exited');
  if (matches.length > 1) throw new ShellAddressError(409, 'Ambiguous shell folder. Use its unique full path from GET /shells; identical paths cannot be distinguished.');
  return matches[0];
}
