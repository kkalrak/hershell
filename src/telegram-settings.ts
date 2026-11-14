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
  private encryptionAvailable() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 암호화 저장소를 사용할 수 없습니다.');
  }
  load(): TelegramConfig | null {
    if (existsSync(this.file + '.disabled') || !existsSync(this.file)) return null;
    this.encryptionAvailable();
    try { return validateTelegramConfig(JSON.parse(safeStorage.decryptString(readFileSync(this.file)))); }
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
  save(config: TelegramConfig) {
    this.encryptionAvailable();
    const encrypted = safeStorage.encryptString(JSON.stringify(validateTelegramConfig(config)));
    writeFileSync(this.file + '.tmp', encrypted);
    renameSync(this.file + '.tmp', this.file);
    if (existsSync(this.file + '.disabled')) unlinkSync(this.file + '.disabled');
  }
  importFile() {
    if (!existsSync(this.envFile)) throw new Error('프로젝트 루트의 .env 설정 파일이 없습니다.');
    const env = parseEnv(readFileSync(this.envFile, 'utf8'));
    const config = validateTelegramConfig({ token: env.TELEGRAM_BOT_TOKEN ?? '', chatId: env.TELEGRAM_CHAT_ID ?? env.TELEGRAM_OWNER_ID ?? '' });
    this.save(config);
    return config;
  }
  clear() {
    writeFileSync(this.file + '.disabled', ''); // Do not re-import .env automatically after disconnect.
    if (existsSync(this.file)) unlinkSync(this.file);
    this.saveRepresentative(null);
  }
}
