import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { validateTelegramConfig, type TelegramConfig } from './telegram';
import { isShellKey } from './layout';

/** Only the main process handles plaintext tokens. UI reads status, never the saved token. */
export class TelegramSettings {
  private file: string;
  private envFile: string;
  constructor(file: string, envFile: string) { this.file = file; this.envFile = envFile; }
  private async encryptionAvailable() {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('OS 암호화 저장소를 사용할 수 없습니다.');
  }
  async load(): Promise<TelegramConfig | null> {
    if (existsSync(this.file + '.disabled') || !existsSync(this.file)) return null;
    await this.encryptionAvailable();
    try { return validateTelegramConfig(JSON.parse((await safeStorage.decryptStringAsync(readFileSync(this.file))).result)); }
    catch { throw new Error('저장된 텔레그램 설정을 읽지 못했습니다. 설정을 다시 저장하세요.'); }
  }
  hasSavedChoice() { return existsSync(this.file) || existsSync(this.file + '.disabled'); }
  loadRepresentative(): string | null {
    try {
      const key = JSON.parse(readFileSync(this.file + '.representative', 'utf8'));
      return isShellKey(key) ? key.toLowerCase() : null;
    } catch { return null; }
  }
  saveRepresentative(key: string | null) {
    const file = this.file + '.representative';
    if (key === null) { if (existsSync(file)) unlinkSync(file); return; }
    if (!isShellKey(key)) throw new Error('Invalid shell key');
    writeFileSync(file + '.tmp', JSON.stringify(key));
    renameSync(file + '.tmp', file);
  }
  async save(config: TelegramConfig) {
    await this.encryptionAvailable();
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(validateTelegramConfig(config)));
    writeFileSync(this.file + '.tmp', encrypted);
    renameSync(this.file + '.tmp', this.file);
    if (existsSync(this.file + '.disabled')) unlinkSync(this.file + '.disabled');
  }
  async importFile() {
    if (!existsSync(this.envFile)) throw new Error('앱 폴더의 .env 설정 파일이 없습니다. 개발 중에는 프로젝트 루트에 두세요.');
    const env = parseEnv(readFileSync(this.envFile, 'utf8'));
    const config = validateTelegramConfig({ token: env.TELEGRAM_BOT_TOKEN ?? '', chatId: env.TELEGRAM_CHAT_ID ?? env.TELEGRAM_OWNER_ID ?? '' });
    await this.save(config);
    return config;
  }
  clear() {
    writeFileSync(this.file + '.disabled', ''); // Do not re-import .env automatically after disconnect.
    if (existsSync(this.file)) unlinkSync(this.file);
    this.saveRepresentative(null);
  }
}
