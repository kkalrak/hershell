import type { Status } from './status.ts';

export type TaskState = 'working' | 'waiting' | 'complete' | 'blocked';
export interface AutoState { enabled: boolean; state: TaskState; version: number; error: string }
export const AUTO_QUIET_MS = 10000;
export const newAutoState = (): AutoState => ({ enabled: false, state: 'complete', version: 0, error: '' });
export function isTaskState(value: unknown): value is TaskState {
  return ['working', 'waiting', 'complete', 'blocked'].includes(value as string);
}

/** Silence alone never means ready. Require an empty agent input prompt as well. */
export function readyToContinue(lines: string[], quietMs: number, status: Status): boolean {
  if (status !== 'done' || quietMs < AUTO_QUIET_MS) return false;
  if (lines.some(line => /(?:esc\s+to\s+(?:interrupt|cancel)|thinking|working|正在|생각 중|작업 중)/i.test(line))) return false;
  // Codex › and Claude ❯. Other prompts need explicit support, never a generic fallback.
  return /^\s*[›❯]\s*$/.test(lines.filter(line => line.trim()).at(-1) ?? '');
}
