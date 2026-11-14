import type { PtyApi } from './preload';
import type { TelegramStatus } from './telegram';
import { telegramUsage } from './extension-usage';

export function initTelegram(api: PtyApi, focusActive: () => void) {
  let status: TelegramStatus | null = null;
  let target: number | null = null;
  const menu = document.getElementById('shell-menu')!;
  const assign = document.getElementById('telegram-assign') as HTMLButtonElement;
  const unassign = document.getElementById('telegram-unassign') as HTMLButtonElement;
  const token = document.getElementById('telegram-token') as HTMLInputElement;
  const chatId = document.getElementById('telegram-chat') as HTMLInputElement;
  const result = document.getElementById('telegram-result')!;
  const form = document.getElementById('telegram-settings') as HTMLFormElement;
  const sidebarStatus = document.getElementById('telegram-sidebar-status')!;
  const labels = { unconfigured: '미설정', ready: '대표 셸 지정 대기', connecting: '연결 중', connected: '연결됨', retrying: '연결 재시도 중', error: '연결 오류' };
  function refresh() {
    if (!status) return;
    const representativeName = document.querySelector(`#list li[data-shell-id="${status.representative}"] .title`)?.textContent || '폴더 확인 중';
    document.getElementById('telegram-status')!.textContent = `${labels[status.phase]}${status.botName ? ` · @${status.botName}` : ''}${status.representative !== null ? ` · ${representativeName}` : ''}${status.error ? ` · ${status.error}` : ''}`;
    sidebarStatus.hidden = !status.error && status.representative === null;
    sidebarStatus.textContent = status.error || `✈ ${representativeName} · ${labels[status.phase]}`;
    sidebarStatus.title = sidebarStatus.textContent;
    token.placeholder = status.configured ? '저장됨 · 변경하려면 새 토큰 입력' : '봇 토큰';
    if (document.activeElement !== chatId) chatId.value = status.chatId;
    for (const li of document.querySelectorAll<HTMLLIElement>('#list li[data-shell-id]')) {
      const selected = Number(li.dataset.shellId) === status.representative;
      let badge = li.querySelector('.telegram-badge');
      if (selected && !badge) {
        badge = document.createElement('span'); badge.className = 'telegram-badge';
        badge.textContent = '✈'; badge.setAttribute('title', '텔레그램 대표 셸');
        li.querySelector('.title')!.after(badge);
      } else if (!selected) badge?.remove();
      if (selected && badge) {
        badge.classList.toggle('connection-error', status.phase === 'error');
        badge.setAttribute('title', status.phase === 'error' ? '텔레그램 대표 셸 · 연결 오류' : '텔레그램 대표 셸');
      }
    }
  }
  function update(value: TelegramStatus) { status = value; refresh(); }
  async function act(operation: () => Promise<TelegramStatus>) {
    result.textContent = '';
    try { update(await operation()); token.value = ''; result.textContent = status?.error || '적용했습니다.'; }
    catch (e) {
      result.textContent = (e as Error).message;
      sidebarStatus.hidden = false; sidebarStatus.textContent = result.textContent; sidebarStatus.title = result.textContent;
    }
  }
  api.onTelegramStatus(update);
  void api.telegramStatus().then(update).catch(() => { result.textContent = '텔레그램 상태를 읽지 못했습니다.'; });
  form.addEventListener('submit', e => { e.preventDefault(); void act(() => api.telegramSave({ token: token.value, chatId: chatId.value })); });
  document.getElementById('telegram-import')!.addEventListener('click', () => { void act(() => api.telegramImport()); });
  document.getElementById('telegram-clear')!.addEventListener('click', () => { void act(() => api.telegramClear()); });
  document.getElementById('telegram-check')!.addEventListener('click', async () => {
    try { result.textContent = `연결 확인: @${await api.telegramVerify(token.value ? { token: token.value, chatId: chatId.value } : undefined)}`; }
    catch (e) { result.textContent = (e as Error).message; }
  });
  document.getElementById('copy-telegram-usage')!.addEventListener('click', async () => {
    try {
      const info = await api.agentInfo();
      if (!info) throw new Error('로컬 API를 사용할 수 없습니다.');
      api.writeClipboard(telegramUsage(info)); result.textContent = '복사했습니다. 대표 에이전트에게 붙여넣으세요.';
    } catch (e) { result.textContent = (e as Error).message; }
  });
  function hideMenu() { menu.hidden = true; }
  document.getElementById('list')!.addEventListener('contextmenu', e => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-shell-id]');
    if (!li) return;
    e.preventDefault(); target = Number(li.dataset.shellId);
    assign.disabled = li.dataset.exited === 'true';
    assign.textContent = status?.representative === target ? '텔레그램 다시 연결' : '텔레그램 대표로 지정';
    unassign.disabled = status?.representative !== target;
    menu.hidden = false;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
    assign.focus();
  });
  assign.addEventListener('click', () => { hideMenu(); void act(() => api.telegramSelect(target)); });
  unassign.addEventListener('click', () => { hideMenu(); void act(() => api.telegramSelect(null)); });
  document.addEventListener('click', e => { if (!menu.contains(e.target as Node)) hideMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { hideMenu(); focusActive(); } });
  window.addEventListener('blur', hideMenu);
  return { refresh };
}
