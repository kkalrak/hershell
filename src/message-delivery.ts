import { CONVERSATION_RULE } from './agent-instructions.ts';

/** Serializes paste/submit for each recipient; different shells remain independent. */
export class MessageDelivery {
  private nextId = 0;
  private closed = false;
  private chains = new Map<number, Promise<void>>();
  private pending = new Map<number, (ok: boolean) => void>();

  private readonly send: (requestId: number, to: number, message: string) => void;
  private readonly timeoutMs: number;
  private readonly shellName: (id: number) => string;

  constructor(send: (requestId: number, to: number, message: string) => void, timeoutMs = 20000, shellName: (id: number) => string = id => `#${id}`) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.shellName = shellName;
  }

  deliver(from: number, to: number, message: string, signal?: AbortSignal): Promise<void> {
    const previous = this.chains.get(to) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.sendMessage(from, to, message, signal));
    this.chains.set(to, next);
    void next.finally(() => { if (this.chains.get(to) === next) this.chains.delete(to); }).catch(() => {});
    return next;
  }

  acknowledge(id: number, ok: boolean) { this.pending.get(id)?.(ok); }
  isPending(id: number) { return this.pending.has(id); }

  close() {
    this.closed = true;
    for (const finish of this.pending.values()) finish(false);
  }

  private sendMessage(from: number, to: number, message: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Delivery stopped'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        if (ok) resolve(); else reject(new Error('Delivery failed'));
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.pending.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      const sender = from === -1 ? '허셀' : from === 0 ? '텔레그램' : this.shellName(from);
      try { this.send(id, to, `[hershell ${sender} → ${this.shellName(to)}]\n${CONVERSATION_RULE}\n${message}`); }
      catch { finish(false); }
    });
  }
}
