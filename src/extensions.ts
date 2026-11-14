import type { PtyApi } from './preload';
import { browserUsage, messageUsage } from './extension-usage';

interface CurrentShell { id: number; cwd: string; exited: boolean }

/** Extension UI is initialized once; terminal ownership stays in renderer.ts. */
export function initExtensions(api: PtyApi, getActive: () => CurrentShell | null, focusActive: () => void) {
  const extensionDialog = document.getElementById('extensions-dialog') as HTMLDialogElement;
  const copyUsage = document.getElementById('copy-usage') as HTMLButtonElement;
  const copyResult = document.getElementById('copy-result')!;
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
