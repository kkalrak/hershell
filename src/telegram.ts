import { setTimeout as delay } from 'node:timers/promises';
import { TELEGRAM_FORMAT_RULE } from './agent-instructions.ts';

export interface TelegramConfig { token: string; chatId: string }
export interface TelegramStatus {
  configured: boolean;
  chatId: string;
  representative: number | null;
  phase: 'unconfigured' | 'ready' | 'connecting' | 'connected' | 'retrying' | 'error';
  botName: string;
  error: string;
}
interface Update {
  update_id: number;
  message?: { message_id: number; text?: string; date: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean } };
}
class TelegramError extends Error {
  code: number;
  constructor(code: number) {
    super(code === 409 ? '다른 프로그램이 같은 봇을 수신 중입니다. 기존 릴레이를 종료하고 다시 지정하세요.' : `텔레그램 요청 실패 (${code})`);
    this.code = code;
  }
}
export function validateTelegramConfig(config: TelegramConfig): TelegramConfig {
  if (!config || typeof config.token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(config.token.trim())) throw new Error('봇 토큰 형식을 확인하세요.');
  if (typeof config.chatId !== 'string' || !/^[1-9]\d*$/.test(config.chatId.trim()) || !Number.isSafeInteger(Number(config.chatId))) throw new Error('본인의 개인 채팅 ID(양의 정수)를 입력하세요.');
  return { token: config.token.trim(), chatId: config.chatId.trim() };
}

/** No terminal output inspection. Only explicit agent replies are sent to Telegram. */
export class TelegramBridge {
  private config: TelegramConfig | null = null;
  private state: TelegramStatus = { configured: false, chatId: '', representative: null, phase: 'unconfigured', botName: '', error: '' };
  private controller = new AbortController();
  private epoch = 0;
  private outgoing: Promise<unknown> = Promise.resolve();
  private polling: Promise<void> | null = null;
  private readonly base: string;
  private readonly hasShell: (id: number) => boolean;
  private readonly deliver: (id: number, text: string, signal: AbortSignal) => Promise<void>;
  private readonly changed: (status: TelegramStatus) => void;

  constructor(options: { base?: string; hasShell: (id: number) => boolean; deliver: (id: number, text: string, signal: AbortSignal) => Promise<void>; changed: (status: TelegramStatus) => void }) {
    this.base = options.base ?? 'https://api.telegram.org';
    this.hasShell = options.hasShell; this.deliver = options.deliver; this.changed = options.changed;
  }
  status(): TelegramStatus { return { ...this.state }; }
  private publish() { this.changed(this.status()); }
  configure(config: TelegramConfig | null) {
    this.stop();
    this.config = config ? validateTelegramConfig(config) : null;
    this.state = { configured: !!this.config, chatId: this.config?.chatId ?? '', representative: null, phase: this.config ? 'ready' : 'unconfigured', botName: '', error: '' };
    this.publish();
  }
  setError(error: string) { this.state.error = error; this.state.phase = 'error'; this.publish(); }
  private connectionFailed(error: string) {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();
    // Keep the selected shell visible so a connection failure does not look like
    // the user never assigned a representative. No polling continues in error.
    this.setError(error);
  }
  stop() {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();
    this.state.representative = null;
    this.state.phase = this.config ? 'ready' : 'unconfigured'; this.state.error = '';
    this.publish();
  }
  shellClosed(id: number) { if (this.state.representative === id) this.stop(); }
  private async call(config: TelegramConfig, method: string, body: object, signal = this.controller.signal): Promise<any> {
    try {
      const r = await fetch(`${this.base}/bot${config.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
      });
      const result = await r.json();
      if (!result.ok) throw new TelegramError(Number(result.error_code) || r.status);
      return result.result;
    } catch (e) {
      // fetch errors may contain a URL with the token. Never propagate those details.
      if (e instanceof TelegramError) throw e;
      throw new Error('텔레그램 네트워크 요청이 중단되었거나 실패했습니다.');
    }
  }
  async verify(config?: TelegramConfig): Promise<string> {
    const credentials = config ? validateTelegramConfig(config) : this.config;
    if (!credentials) throw new Error('텔레그램 설정을 먼저 저장하세요.');
    const bot = await this.call(credentials, 'getMe', {});
    return String(bot.username ?? bot.first_name ?? 'bot');
  }
  async select(id: number | null) {
    const previousPoll = this.polling;
    this.stop();
    const epoch = this.epoch, signal = this.controller.signal;
    // Finish cancelling our old long poll before requesting a new connection.
    await previousPoll;
    if (epoch !== this.epoch) return this.status();
    if (id === null) return this.status();
    const config = this.config;
    if (!config) throw new Error('추가기능에서 텔레그램 설정을 먼저 저장하세요.');
    if (!this.hasShell(id)) throw new Error('종료된 셸입니다.');
    this.state.representative = id; this.state.phase = 'connecting'; this.publish();
    try {
      const botName = await this.verify();
      if (epoch !== this.epoch) return this.status();
      const webhook = await this.call(config, 'getWebhookInfo', {}, signal);
      if (webhook.url) throw new Error('이 봇에 웹훅이 설정되어 있습니다. 기존 연결에서 해제한 뒤 다시 지정하세요.');
      if (epoch !== this.epoch) return this.status();
      // Do not execute instructions left in the bot queue while no shell was bound.
      const latest: Update[] = await this.call(config, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] }, signal);
      if (epoch !== this.epoch) return this.status();
      const offset = latest.length ? latest.at(-1)!.update_id + 1 : 0;
      this.state.botName = botName; this.state.phase = 'connected'; this.publish();
      this.polling = this.poll(config, id, offset, epoch, signal);
    } catch (e) {
      if (epoch === this.epoch) this.connectionFailed((e as Error).message);
    }
    return this.status();
  }
  private async poll(config: TelegramConfig, id: number, offset: number, epoch: number, signal: AbortSignal) {
    while (epoch === this.epoch && !signal.aborted) {
      try {
        const updates: Update[] = await this.call(config, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal);
        if (epoch !== this.epoch) return;
        this.state.phase = 'connected'; this.state.error = ''; this.publish();
        for (const update of updates) {
          if (epoch !== this.epoch) return;
          if (update.update_id < offset) continue;
          offset = update.update_id + 1; // At most once per binding; no automatic replay on failure.
          const m = update.message;
          if (!m || m.chat.type !== 'private' || String(m.chat.id) !== config.chatId || String(m.from?.id) !== config.chatId || m.from?.is_bot) continue;
          if (!m.text?.trim()) {
            this.state.error = '텍스트 메시지만 지원합니다. 사진·음성은 전달하지 않았습니다.'; this.publish(); continue;
          }
          if (!this.hasShell(id)) { this.stop(); return; }
          const text = m.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
          await this.deliver(id, `[텔레그램 요청 #${m.message_id}]\n${text}\n\n${TELEGRAM_FORMAT_RULE}\n결과는 POST /telegram/send로 사용자에게 답장해라. from은 너의 폴더 ID다. GET /shells/me로 찾는다. 인증은 HERSHELL_SHELL_TOKEN 환경 변수 쓴다. 요청 #${m.message_id}에 대한 답인지 적어라.`, signal);
        }
      } catch (e) {
        if (epoch !== this.epoch || signal.aborted) return;
        if (e instanceof TelegramError && [401, 403, 409].includes(e.code)) { this.connectionFailed(e.message); return; }
        this.state.phase = 'retrying'; this.state.error = (e as Error).message; this.publish();
        try { await delay(3000, undefined, { signal }); } catch { return; }
      }
    }
  }
  send(from: number, text: string): Promise<void> {
    const config = this.config, epoch = this.epoch, signal = this.controller.signal;
    const assertRepresentative = () => {
      if (!config || epoch !== this.epoch || from !== this.state.representative || !this.hasShell(from) || !['connected', 'retrying'].includes(this.state.phase)) throw new Error('연결된 텔레그램 대표 셸만 회신할 수 있습니다.');
    };
    assertRepresentative();
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('회신은 1~32000자 텍스트로 보내세요.');
    const task = this.outgoing.catch(() => {}).then(async () => {
      const points = Array.from(text);
      for (let i = 0; i < points.length; i += 1700) {
        assertRepresentative();
        // No auto retry for sendMessage: a network timeout could already have sent it.
        await this.call(config!, 'sendMessage', { chat_id: config!.chatId, text: points.slice(i, i + 1700).join(''), link_preview_options: { is_disabled: true } }, signal);
        if (i + 1700 < points.length) await delay(1100, undefined, { signal });
      }
    });
    this.outgoing = task;
    return task;
  }
}
