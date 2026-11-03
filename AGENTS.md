# hershell 개발 문서

> Claude, Codex 등 어떤 에이전트나 개발자가 이어서 작업하더라도 이 문서만 보고 진행할 수 있도록 정리한 문서입니다.
> 코드를 바꾸면 이 문서도 함께 갱신하세요.

---

## 1. 목적 (가장 중요)

**PowerShell 창보다 빠른 터미널.**

- 사용자는 `claude`(Claude Code)와 `codex`(Codex CLI)를 터미널에서 씁니다. 그런데 Windows PowerShell 창은 출력이 많이 쌓이면 느려집니다. 이 앱은 그 문제를 해결하려고 만든 것입니다.
- **모든 설계 결정은 속도를 기준으로 합니다.** 기능을 추가할 때는 그 기능이 출력 처리나 화면 그리기를 느리게 만들지 않는지 먼저 확인하세요.
- 화면 구성은 herdr(터미널 멀티플렉서)의 **사이드바 기능만** 참고했습니다.

## 2. 확정된 요구사항 (사용자가 직접 정한 것, 바꾸지 말 것)

| 요구사항 | 내용 |
|---|---|
| 방식 | 앱 안에 진짜 터미널을 넣는 방식입니다. claude나 codex의 출력을 따로 받아서 GUI를 직접 그리는 방식은 쓰지 않습니다. |
| 사이드바 | 사이드바 항목 1개 = 터미널 창 1개 |
| 화면 분할 | **만들지 않습니다.** 한 항목에 창을 여러 개 넣는 것, 탭, 워크스페이스도 만들지 않습니다. |
| 셸 | 앱은 **셸 화면만 열어 줍니다.** `claude`나 `codex`를 자동으로 실행하거나 명령을 대신 입력하지 않습니다. |
| 권한 | 직접 구현하지 않습니다. CLI가 가진 승인 화면을 터미널에서 그대로 씁니다. 앱은 승인을 기다리는 상태를 🔴로 표시하기만 합니다. |
| 초기 범위 | 최대한 단순하게 만듭니다. |

## 3. 기술 구성

- **Electron 45** (메인 프로세스와 화면 프로세스로 나뉨)
- **@xterm/xterm 6** + `@xterm/addon-webgl` (GPU로 화면 그리기) + `@xterm/addon-fit`
- **@lydell/node-pty**: node-pty 포크입니다. Windows용 바이너리가 미리 빌드되어 있고 N-API 기반이라서 **Electron에 맞춰 다시 빌드할 필요가 없습니다.**
- **esbuild**: 번들링. **TypeScript**는 타입 검사에만 씁니다.
- 화면 쪽은 **React 같은 프레임워크 없이 순수 TypeScript**로 만들었습니다. 속도 때문에 일부러 정한 것입니다.

## 4. 파일 구조

```
hershell/
├─ src/
│  ├─ main.ts       메인 프로세스: 창 생성, pty(셸) 실행/입력/크기/종료, 출력 묶음 전송, 클립보드
│  ├─ preload.ts    화면에 공개하는 API(window.pty). contextBridge를 사용
│  ├─ renderer.ts   화면: xterm 생성, 사이드바 항목 추가/전환/닫기, 상태 루프, 단축키
│  ├─ status.ts     순수 함수: 상태 판단(detect), 폴더 이름(folderName). DOM/xterm 의존 없음
│  ├─ layout.ts     사이드바 저장/복원 (parseLayout, loadLayout, saveLayout)
│  ├─ styles.css    레이아웃과 상태 색상
│  ├─ index.html    CSP 설정, 사이드바와 터미널 영역
│  └─ css.d.ts      CSS import 타입 선언
├─ test/
│  └─ unit.test.ts  status.ts, layout.ts 단위 테스트 (npm test)
├─ tools/
│  └─ drive.mjs     Playwright로 앱을 조작하는 자동 테스트 (마우스, 키보드, 스크린샷)
├─ build.mjs        esbuild로 main, preload, renderer를 dist/에 번들
├─ dist/            빌드 결과 (git 제외)
└─ AGENTS.md        이 문서
```

## 5. 구조와 데이터 흐름

```
[화면 renderer.ts]                      [메인 main.ts]
 xterm.onData(키 입력) ──pty:write──▶    pty.write
                                        pty.onData → 버퍼에 쌓음 → 16ms마다 전송
 term.write(data)   ◀──pty:data────     (FLUSH_MS)
 term.onResize      ──pty:resize──▶     pty.resize
 × 버튼             ──pty:kill────▶     pty.kill
                    ◀──pty:exit────     pty.onExit
 Ctrl+C/V           ◀─clip:read/write─▶ electron.clipboard
```

### IPC 채널

| 채널 | 방향 | 방식 | 인자 |
|---|---|---|---|
| `pty:create` | 화면 → 메인 | invoke | `(cols, rows)` → 반환값 `id` |
| `pty:write` | 화면 → 메인 | send | `(id, data)` |
| `pty:resize` | 화면 → 메인 | send | `(id, cols, rows)` |
| `pty:kill` | 화면 → 메인 | send | `(id)` |
| `pty:data` | 메인 → 화면 | send | `(id, data)` (16ms 단위로 묶어서 보냄) |
| `pty:exit` | 메인 → 화면 | send | `(id, exitCode)` |
| `clip:read` | 화면 → 메인 | invoke | → 클립보드 텍스트 |
| `clip:write` | 화면 → 메인 | send | `(text)` |

**클립보드를 IPC로 처리하는 이유:** 화면 쪽은 `sandbox: true`라서 preload에서 Electron의 `clipboard` 모듈을 쓸 수 없습니다.

### 보안 설정 (유지할 것)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- `index.html`의 CSP는 `default-src 'self'`입니다. 외부 스크립트를 불러오지 마세요.
- 화면 쪽은 `window.pty`로 공개된 함수만 쓸 수 있습니다.

## 6. 셸 실행
- `main.ts`의 `findShell()` 함수가 PATH에서 `pwsh.exe`를 찾고, 없으면 `powershell.exe`(5.1)를 씁니다.
  - **알려진 문제:** 사용자 PC에서는 pwsh가 PATH의 실제 파일로 잡히지 않아서 지금은 `powershell.exe`로 실행됩니다. pwsh 7을 쓰려면 경로를 직접 지정하거나 `where.exe pwsh`로 찾게 고쳐야 합니다. 아직 사용자가 요청하지 않았습니다.
- 실행 인자는 `-NoLogo`, 시작 폴더는 사용자 홈 폴더, 환경 변수는 `process.env`를 그대로 넘깁니다.

## 6-1. 사이드바 저장과 복원 (`layout.ts`, `renderer.ts`의 `persist`, `start`)

- **사이드바 제목은 항상 현재 폴더 이름입니다** (사용자 요구사항). 예를 들어 `C:\work\hershell`이면 `hershell`, 드라이브 루트이면 `C:\`로 표시합니다. 폴더를 알기 전에는 `…`로 표시하고, 마우스를 올리면 전체 경로가 보입니다 (`folderName`, `setCwd`). 사용자가 이름을 직접 바꾸는 기능은 없습니다.
- 저장하는 것: 항목 순서, **항목별 마지막 작업 폴더(cwd)**, 선택된 항목 번호
- 작업 폴더 추적: 상태 감지 루프(0.3초)가 마지막 줄의 PowerShell 프롬프트 `PS <경로>>`에서 경로를 읽습니다. 경로가 바뀌면 저장합니다. 별도 처리 비용은 없습니다.
  - 프롬프트 모양을 바꾸면(oh-my-posh 등) 폴더를 추적하지 못합니다. 이 경우 홈 폴더에서 시작합니다.
  - 메인 프로세스가 `validDir()`로 폴더가 실제로 있는지 확인합니다. 없으면 홈 폴더에서 시작합니다.
- 저장 위치: `localStorage`의 키 `hershell.layout.v2` (Electron userData 폴더 `%APPDATA%\hershell`에 저장됨). 없으면 이전 키 `hershe.layout.v2`, `hershe.layout.v1`에서 cwds를 읽습니다.
- 저장 시점: 항목 전환(`activate`), 닫기(`removeItem`), 폴더 변경 감지
- 앱을 켜면 저장된 항목마다 **빈 셸을 새로 엽니다.** 출력 내용이나 실행 중이던 프로그램은 복원하지 않습니다.
- 복원하는 동안에는 `restoring` 플래그로 저장을 막고, 마지막에 한 번만 저장합니다.
- 항목을 모두 닫으면 다음 실행 때 홈 폴더 셸 하나로 시작합니다.
- 환경 변수 `HERSHELL_USER_DATA`를 지정하면 userData 폴더를 바꿉니다. 테스트가 사용자의 저장 데이터를 덮어쓰지 않게 하려고 넣은 것입니다.

## 7. 사이드바 상태 감지 (`status.ts`의 `detect`, 루프는 `renderer.ts`)

0.3초(`STATUS_MS`)마다 각 터미널 버퍼의 **커서 위치부터 위로 12줄만** 읽어서 판단합니다. 판단 순서는 다음과 같습니다.

| 순서 | 상태 | 색 | 조건 |
|---|---|---|---|
| 1 | `exited` | ⚫ 회색 | 셸 프로세스가 종료됨 |
| 2 | `idle` | 🟢 초록 | 비어 있지 않은 마지막 줄이 `PS ...>` 프롬프트 (`PROMPT_RE`) |
| 3 | `blocked` | 🔴 빨강 | 12줄 안에 승인 문구가 있음 (`BLOCKED_RE`): do you want to, allow once/always, approve, (y/n), [y/n], yes, and don't ask, press enter to confirm, waiting for approval |
| 4 | `working` | 🟡 노랑 | 1초(`WORKING_WINDOW_MS`) 안에 출력이 있었음 |
| 5 | `done` | 🔵 파랑 | 그 외 (에이전트가 끝나고 입력을 기다리는 상태) |

- **아직 확인하지 못한 것:** 실제 claude/codex 승인 화면에서 🔴가 잘 뜨는지는 검증하지 않았습니다. 지금은 PowerShell의 `Read-Host` 질문으로만 확인했습니다. 잘못 표시되면 `BLOCKED_RE`를 고치세요.
- 상태 감지가 무거워지면 안 됩니다. 버퍼 전체를 훑거나 출력이 올 때마다 정규식을 돌리는 방식은 쓰지 마세요.

## 8. 속도 원칙 (새 기능도 반드시 지킬 것)

1. **WebGL 렌더러**를 씁니다. 컨텍스트가 끊기면(`onContextLoss`) 애드온을 해제하고 기본 렌더러로 돌아갑니다.
2. **출력 묶음 전송**: 메인 프로세스에서 16ms 동안 모은 출력을 한 번에 보냅니다. 출력 조각을 하나씩 IPC로 보내지 마세요.
3. **스크롤 기록**은 10000줄로 제한합니다.
4. **숨겨진 터미널**은 `display:none`으로 둡니다. 출력은 계속 받지만, xterm이 보이지 않는 터미널은 그리지 않습니다.
5. **창 크기 변경 시 다시 맞추기(fit)는 보이는 터미널 하나만**, 프레임당 한 번만 합니다 (`requestAnimationFrame`).
6. 프레임워크(React 등)를 넣지 마세요.

## 9. 단축키와 조작

| 입력 | 동작 |
|---|---|
| `+ 새 셸` 버튼 / `Ctrl+Shift+T` | 새 항목과 셸 추가 |
| 사이드바 항목 클릭 | 해당 셸로 전환 |
| 사이드바 항목 위아래 드래그 | 순서 변경. 놓으면 순서를 저장합니다. HTML5 드래그 앤 드롭을 쓰고, `#list`의 DOM 순서가 곧 저장 순서입니다 (`renderer.ts`의 drag 핸들러) |
| `×` (마우스를 올리면 보임) | 셸 종료 후 항목 삭제. 선택된 항목을 닫으면 바로 아래 항목(없으면 위 항목)으로 이동 |
| `Ctrl+C` | 선택한 텍스트가 있으면 복사, 없으면 셸에 중단 신호 전달 |
| `Ctrl+V` | 텍스트 붙여넣기 (`term.paste` 사용, bracketed paste 지원) |
| `F12` | 개발자 도구 |

- **알려진 한계:** `Ctrl+V`를 앱이 가져가기 때문에 claude CLI의 이미지 붙여넣기(Ctrl+V)는 동작하지 않습니다.
- 앱 메뉴바는 없습니다 (`Menu.setApplicationMenu(null)`).

## 10. 설치, 빌드, 실행

```powershell
cd C:\work\hershell
npm install
node node_modules\electron\install.js   # 아래 주의 참고
npm start                               # 빌드 후 실행
npm run build                           # 빌드만
npx tsc -p .                            # 타입 검사
```

**주의 (중요):** 이 PC의 npm은 패키지 설치 스크립트를 자동으로 실행하지 않습니다 (`allow-scripts` 설정). 그래서 다음 문제가 생깁니다.
- Electron 실행 파일이 다운로드되지 않습니다. `node node_modules\electron\install.js`를 직접 실행해야 합니다. `node_modules\electron\dist\electron.exe`가 있으면 정상입니다.
- esbuild는 설치 스크립트 없이도 동작하는 것을 확인했습니다.

**바탕화면 바로가기:** `C:\Users\gello\OneDrive\Desktop\hershell.lnk`
- 대상: `node_modules\electron\dist\electron.exe "C:\work\hershell"`
- 빌드된 `dist/`를 그대로 실행합니다. **코드를 고친 뒤에는 `npm run build`를 해야 바로가기에 반영됩니다.**

## 11. 테스트

```powershell
npm test                                  # 단위 테스트 (Node가 TS 타입을 직접 제거해서 실행, 빌드 불필요)
npm run test:ui -- <스크린샷 저장 폴더>      # 빌드 후 UI 자동 조작 테스트
```

- 상태 판단이나 저장 형식을 바꾸면 `test/unit.test.ts`에 테스트를 추가하세요. 이 로직은 `status.ts`, `layout.ts`에 순수 함수로 두고, DOM이나 xterm 코드는 넣지 마세요.

### UI 테스트 (`tools/drive.mjs`)

- `playwright-core`의 `_electron`으로 앱을 띄우고, 실제 마우스와 키보드 입력을 보낸 뒤 스크린샷을 저장합니다.
- 확인하는 항목: 입력, 5만 줄 출력(시간 측정), working, blocked, idle 상태, 새 셸, 전환, 폴더 이동 시 제목 변경, Ctrl+Shift+T, 닫기, 앱 재시작 후 사이드바 복원
- 테스트는 임시 프로필(`%TEMP%\hershell-test-profile`)을 쓰기 때문에 실제 앱의 사이드바 저장 데이터에 영향을 주지 않습니다.
- **WebGL은 글자를 캔버스에 그려서 DOM에 텍스트가 없습니다.** 그래서 터미널 내용은 `window.__hershell.tail(n)`으로 읽습니다. `renderer.ts`에 있는 테스트용 읽기 전용 함수입니다.
- 마지막 결과(2026-11-01): 모든 항목 통과. 5만 줄 출력 4.1초 (출력 없이 실행하면 0.3초. 차이에는 PowerShell 5.1의 콘솔 출력 시간과 ConPTY 처리 시간이 포함됨). 기존 PowerShell 창과 비교한 측정은 아직 없습니다.

## 12. 넣지 않는 것 (사용자가 명시적으로 제외함)

- 화면 분할, 탭, 워크스페이스
- claude나 codex 자동 실행, 명령 자동 입력, 재시작 버튼
- 권한 승인 UI를 직접 구현하는 것
- 백그라운드 세션 유지 (앱을 닫으면 셸도 종료됨. 사이드바 구성만 복원됨)

## 13. 다음 작업 후보 (사용자 확인 후 진행)

1. 실제 claude와 codex에서 🔴 감지가 맞는지 확인하고 `BLOCKED_RE`를 조정
2. 기존 PowerShell 창이나 Windows Terminal과 속도 비교 측정
3. pwsh 7 실행 지원 (`findShell` 수정)
4. 앱 아이콘 지정, 실행 파일(.exe) 패키징 (예: electron-builder)

## 14. 작업 규칙

- 범위를 넓히기 전에 사용자에게 먼저 확인하세요. 사용자는 "최대한 단순하게"를 원합니다.
- 변경 후에는 `npm run build`, `npx tsc -p .`, `node tools/drive.mjs`로 확인하세요.
- 이 폴더는 아직 git 저장소가 아닙니다 (`.gitignore`만 있음).
- 사용자와는 한국어로 소통합니다.
