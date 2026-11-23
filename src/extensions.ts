import type { PtyApi } from './preload';
import { autoUsage, browserUsage, messageUsage } from './extension-usage';

interface CurrentShell { id: number; cwd: string; exited: boolean }

/** Extension UI is initialized once; terminal ownership stays in renderer.ts. */
export function initExtensions(api: PtyApi, getActive: () => CurrentShell | null, focusActive: () => void) {
  const extensionDialog = document.getElementById('extensions-dialog') as HTMLDialogElement;
  const copyUsage = document.getElementById('copy-usage') as HTMLButtonElement;
  const copyResult = document.getElementById('copy-result')!;
  const kinds = ['message', 'browser', 'auto', 'telegram'];
  for (const [index, article] of [...extensionDialog.querySelectorAll('article')].entries()) {
    const kind = kinds[index];
    const actions = document.createElement('div'); actions.className = 'telegram-actions';
    const result = document.createElement('p'); result.setAttribute('role', 'status');
    result.dataset.sendResult = kind;
    for (const all of [false, true]) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = all ? '모든 셸에 전달' : '현재 셸에 전달';
      button.dataset.sendKind = kind; button.dataset.sendTarget = all ? 'all' : 'current';
      button.addEventListener('click', async () => {
        const current = getActive();
        if (!all && (!current || current.exited)) return;
        const buttons = actions.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
        result.textContent = '전달 중…';
        try {
          const sent = await api.sendUsage(kind, all ? 'all' : current!.id);
          result.textContent = `${sent.sent}개 전달 완료${sent.failed ? ` · ${sent.failed}개 실패. 자동 재전송 안 함` : ''}`;
        } catch { result.textContent = '전달 실패. 에이전트가 실행 중인지 확인하세요.'; }
        finally { buttons.forEach(b => b.disabled = false); }
      });
      actions.appendChild(button);
    }
    article.append(actions, result);
  }
  const note = document.createElement('p');
  note.textContent = '전달은 프롬프트 입력과 Enter까지 보냅니다. 대상 셸에서 에이전트를 먼저 실행하세요. 모든 셸은 현재 열린 셸 전체에 보냅니다.';
  extensionDialog.querySelector('header')!.after(note);
  document.getElementById('copy-auto-usage')!.addEventListener('click', async () => {
    const result = document.getElementById('auto-copy-result')!;
    try {
      const info = await api.agentInfo(); if (!info) throw new Error('API unavailable');
      api.writeClipboard(autoUsage(info)); result.textContent = '복사했습니다. 에이전트에게 붙여넣으세요.';
    } catch { result.textContent = '사용법을 복사하지 못했습니다.'; }
  });
  document.getElementById('extensions')!.addEventListener('click', () => {
    const active = getActive();
    copyResult.textContent = '';
    document.getElementById('browser-copy-result')!.textContent = '';
    copyUsage.disabled = !active || active.exited;
    document.getElementById('extension-context')!.textContent = active && !active.exited
      ? `현재 셸 · ${active.cwd || '폴더 확인 중'}` : '사용법을 복사하려면 실행 중인 셸을 선택하세요.';
    extensionDialog.showModal();
  });

  document.getElementById('copy-browser-usage')!.addEventListener('click', async () => {
    const result = document.getElementById('browser-copy-result')!;
    const active = getActive();
    const suggestedId = active ? `shell-${active.id}` : 'agent-a';
    try {
      const info = await api.agentInfo();
      if (!info) { result.textContent = 'API를 시작하지 못했습니다. 앱을 다시 실행하세요.'; return; }
      api.writeClipboard(browserUsage(info, suggestedId));
      result.textContent = '복사했습니다. 에이전트에게 붙여넣으세요.';
    } catch { result.textContent = '사용법을 복사하지 못했습니다.'; }
  });
  document.getElementById('extensions-close')!.addEventListener('click', () => extensionDialog.close());
  extensionDialog.addEventListener('click', e => { if (e.target === extensionDialog) {
    const r = extensionDialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) extensionDialog.close();
  } });
  extensionDialog.addEventListener('close', focusActive);
  copyUsage.addEventListener('click', async () => {
    const shell = getActive();
    if (!shell || shell.exited) return;
    try {
      const info = await api.agentInfo();
      if (!info) { copyResult.textContent = 'API를 시작하지 못했습니다. 앱을 다시 실행하세요.'; return; }
      api.writeClipboard(messageUsage(info, await api.shellAddress(shell.id)));
      copyResult.textContent = '복사했습니다. 에이전트에게 붙여넣으세요.';
    } catch { copyResult.textContent = '사용법을 복사하지 못했습니다.'; }
  });
}
