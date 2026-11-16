# hershell

A Windows terminal with a folder-sorted sidebar, agent messaging, an integrated test browser, and Telegram integration.

Each sidebar entry owns one real PowerShell terminal. Run Codex CLI, Claude Code, or other terminal applications yourself. There are no splits, tabs, or workspaces.

## Download and run on Windows

Download the Windows x64 ZIP from [GitHub Releases](https://github.com/kkalrak/hershell/releases/latest), extract the entire archive, and double-click **hershell.exe**. No installer, Node.js, or npm is required for the app itself. Keep its DLLs and folders together; the executable alone is not enough.

This release targets 64-bit Intel/AMD Windows PCs. Codex CLI and Claude Code are separate tools and must be installed independently if you want to use them. The build is unsigned, so Windows may show an unknown-publisher warning. Use the release's `SHA256SUMS.txt` to verify the download.

"Portable" means no installation. Settings and browser profiles still live in `%APPDATA%\hershell`, not beside the executable. Telegram credentials encrypted for one Windows account or PC are not intended to be moved to another.

## Build and run from source

Requirements: Windows, Node.js 24 or newer, and npm.

```powershell
git clone https://github.com/kkalrak/hershell.git
cd hershell
npm install
npm start
```

If npm blocks installation scripts and Electron is missing, run this once:

```powershell
node node_modules/electron/install.js
```

`npm start` rebuilds before launching. If a shortcut launches Electron directly, run `npm run build` after changing the source. Only one app instance runs per profile; launching again brings the existing window forward.

PowerShell 7 is used when found as `pwsh.exe` on PATH; otherwise Windows PowerShell is used.

## Terminal controls

| Control | Action |
| --- | --- |
| **+ 새 셸** / **Ctrl+Shift+T** | Open a new shell |
| Sidebar entry | Switch terminals |
| Hover and click **×** | Close that shell |
| **Ctrl+C** | Copy selected text, or interrupt when nothing is selected |
| **Ctrl+V** | Paste clipboard text |
| **F12** | Open developer tools |

Titles follow the current folder and sort automatically using Korean collation and numeric ordering. Hover over an entry to see its full path. Image pasting through Claude CLI's Ctrl+V is currently unsupported.

Status dots are estimates:

| Color | Meaning |
| --- | --- |
| Green | PowerShell is at its prompt |
| Yellow | Recent output suggests ongoing work |
| Red | Recent text resembles an approval question |
| Blue | No recent output and no recognized PowerShell prompt |
| Gray | The shell process exited |

Detection reads only 12 lines near the cursor every 300 ms. Silent work may look finished, and ordinary text may resemble an approval prompt. Approvals remain in the CLI; hershell does not implement its own approval dialog.

### Restart behavior

The sidebar remembers entries, folders, the selected entry, and the Telegram representative selection. **Terminal output, running programs, and agent conversations are not restored.** Each entry starts a new shell; launch your agent again yourself.

Folder tracking recognizes standard `PS <path>` prompts. Custom or wrapped prompts may prevent updates. Missing folders fall back to the home directory.

## Extension instructions

Click **추가기능 보기** (View extensions), above New shell. Each extension has a **사용법 복사** (Copy usage) button. Paste the instructions into the agent that should use it.

Copy instructions again after restarting: the local API port and credentials change. Instructions ask agents to keep prompts, inter-agent messages, and user replies short and terse while preserving accurate code and API fields.

## Agent messaging

Agents request delivery to another terminal through a local HTTP API. Recipients use **folder names**, not sidebar positions:

```json
{"from":"hershell","to":"minecraft","message":"Review the change and reply to this request."}
```

The app pastes the message and sends Enter once through xterm's normal input path. The sender only calls the API; it must not send another Enter. A size-dependent settling delay allows the receiving CLI to process the paste. This is a timing workaround, not a processing-completion guarantee.

**Recipient state is not checked.** A message is submitted even when the agent is busy or an approval screen is open.

### Discover addresses

Shells launched by hershell receive these environment variables:

| Variable | Purpose |
| --- | --- |
| `HERSHELL_API_URL` | Local HTTP API address |
| `HERSHELL_SHELL_TOKEN` | This shell's credential; required for self-identification and Telegram replies |
| `HERSHELL_API_TOKEN` | Shared credential for general API endpoints |
| `HERSHELL_SHELL_ID` | Initial folder name only; becomes stale after folder changes |

Use `/shells/me` for your current address:

```powershell
$headers = @{ Authorization = "Bearer $env:HERSHELL_SHELL_TOKEN" }
Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells" -Headers $headers
$me = Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells/me" -Headers $headers

$body = @{
  from = $me.id
  to = 'minecraft' # Replace with an actual ID from /shells.
  message = 'Review the change and reply to this request.'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$env:HERSHELL_API_URL/messages" `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

`GET /shells` returns `{id, cwd}` objects. Folder IDs survive sorting and adding entries. Changing a folder changes its address. Duplicate folder names use full paths. When multiple terminals have the same full path, delivery returns **409** instead of choosing one. Numeric IDs are rejected.

`{"delivered":true}` means terminal input was sent, not that the agent read it or completed the task. Messages to one recipient are delivered in order. The instructions ask agents to request a reply for new work, wait for the reply before sending the next message, and avoid endless acknowledgements. The app does not enforce reply semantics or retry failed messages automatically.

## Web test browser

The browser is integrated into hershell. No separate TstBro installation or server is required. An API request opens a separate window; it does not replace a terminal.

Use a distinct browser ID per agent: 1–60 letters, digits, hyphens, or underscores. The same ID reuses its window or restores saved state. Different IDs have isolated cookies and storage, including IDs that differ only in letter case.

| Request | Action |
| --- | --- |
| `GET /browsers` | List running browsers |
| `POST /browsers/:id` | Create, reuse, or restore |
| `DELETE /browsers/:id` | Save and close, keeping the profile |
| `GET /browsers/:id/state` | URL, title, activity, and capture information |
| `POST /browsers/:id/heartbeat` | Extend the idle timeout |
| `POST /browsers/:id/:action` | Perform an action; create the browser if needed |

| Action | JSON body |
| --- | --- |
| `navigate` | `{"url":"http://localhost:3000"}` |
| `click` | `{"selector":"#submit"}` or `{"x":100,"y":200}` |
| `type` | `{"selector":"#name","text":"hello","clear":true}`; selector is optional |
| `key` | `{"key":"Enter"}`; also Tab, Escape, Backspace, Delete, and arrow keys |
| `scroll` | `{"deltaY":500,"deltaX":0}` |
| `snapshot` | `{}`; page text and up to 250 elements with coordinates |
| `evaluate` | `{"expression":"document.title"}`; returns `{"value":...}` |
| `screenshot` | `{"format":"png"}` or `jpeg`; returns image bytes |
| `user-agent` | `{"value":"Your user agent"}`; applies to subsequent requests |
| `back`, `forward`, `reload` | `{}` |

Node.js example, run inside a hershell session:

```javascript
const fs = require('node:fs');

async function main() {
  const base = process.env.HERSHELL_API_URL + '/browsers/agent-a';
  async function command(action = '', params = {}) {
    const response = await fetch(base + (action ? '/' + action : ''), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.HERSHELL_SHELL_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(await response.text());
    return response;
  }
  await command();
  await command('navigate', { url: 'http://localhost:3000' });
  console.log(await (await command('snapshot')).json());
  fs.writeFileSync('screen.png', Buffer.from(await (await command('screenshot')).arrayBuffer()));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
```

Coordinates are CSS pixels relative to web content. Screenshots capture the visible web viewport, not the entire page or browser chrome. Selectors do not traverse iframes or shadow roots. After clicking or typing, use a snapshot or evaluation to check asynchronous changes.

After 10 idle minutes the browser saves and closes. Use `heartbeat` during long pauses. URL, scroll, window bounds, user agent, and cookies are saved; localStorage and IndexedDB remain in the profile. Running JavaScript, WebSockets, unfinished forms, and sessionStorage are not restored. Restoring reloads the page. Expired logins and dynamic scroll positions may need attention.

Only HTTP(S) navigation is supported. Camera and similar permission requests are denied. Closing a browser leaves hershell running. Closing the main terminal window closes its browsers too.

## Telegram representative agent

Telegram connects to **one representative shell**. That agent can delegate through `/messages`, collect answers, and reply to the user.

### Setup

1. Obtain a bot token from Telegram's [BotFather](https://t.me/BotFather) and your numeric private chat/user ID.
2. Open **View extensions → Telegram**. Enter the token and allowed private chat ID, then save. The token field is masked. Leaving it empty when saving keeps the existing token.
3. Click **연결 확인** (Check connection) to validate authentication without sending a message.
4. Right-click a sidebar entry and choose **텔레그램 대표로 지정** (Assign as Telegram representative).
5. Copy the Telegram usage instructions and give them to that agent.

Alternatively, copy `.env.example` to `.env`, fill it locally, and click **설정 파일 가져오기** (Import settings). Put it beside `hershell.exe` in the portable build, or in the project root when running from source. On the first normal-profile launch, that file is imported automatically if no saved settings or disconnect marker exist.

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
```

`TELEGRAM_CHAT_ID` is also accepted and takes precedence over `TELEGRAM_OWNER_ID`. Only private chats are supported: both chat and sender must match the configured positive numeric ID. Photos and voice messages are not forwarded.

Settings are encrypted with Electron `safeStorage` in the app profile. The saved bot token is not returned to the renderer or copied to agents. The original `.env` remains a plaintext local file and is ignored by Git. **Never upload it or include it in a shared project archive.**

### Selection and reconnection

- An airplane badge marks the representative. Assigning another entry replaces the previous selection and cancels pending input.
- Selection survives restart through a saved entry key, even when sorting or duplicate folders change runtime handles.
- **The shell is restored, but the agent program is not. Start Codex or Claude yourself before sending Telegram instructions.** Incoming messages can be pasted and submitted directly to the selected shell.
- Explicitly unassigning, deleting the entry, exiting its shell process, or deleting settings clears the saved selection.
- Connection errors retain the selection with an error badge. Right-click and choose **텔레그램 다시 연결** (Reconnect Telegram).
- Another program polling the same bot can cause a conflict. Stop it and reconnect. hershell does not automatically terminate external relays or remove their webhooks.
- Messages queued before representative assignment are skipped rather than automatically executed in a newly selected shell.

**연결 해제·설정 삭제** (Disconnect and delete settings) stops receiving and deletes saved credentials. A marker prevents automatic `.env` re-import on the next launch; importing or saving settings enables it again.

### Reply to the user

The representative calls `POST /telegram/send` with its own shell credential. A shared token or a different shell cannot send replies through this endpoint.

```powershell
$headers = @{ Authorization = "Bearer $env:HERSHELL_SHELL_TOKEN" }
$me = Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells/me" -Headers $headers
$body = @{ from = $me.id; text = 'Request #123 is complete.' } | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$env:HERSHELL_API_URL/telegram/send" `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

Replies are plain text for a phone conversation: lead with the result, use short paragraphs and line breaks, and avoid tables, deep nesting, Markdown decoration, and unnecessary long explanations. Copied instructions and incoming prompts include this guidance.

Terminal output is not streamed to Telegram. Only explicit reply requests are sent. Long replies are split into smaller messages. Partial delivery is possible on errors; do not blindly retry a failed send.

## Local data and security

The default app profile is `%APPDATA%\hershell`. `HERSHELL_USER_DATA` selects another profile and is used by tests.

The API binds to `127.0.0.1`, requires a Bearer credential, and rejects browser Origin headers. Keep API credentials, browser cookies, and Telegram settings private. These controls are not a boundary against malicious processes running as your Windows user.

Git ignores local environment files, runtime data, logs, default screenshots, dependencies, build output, and Telegram credential files. `.env.example` must contain empty placeholders only.

## Development and tests

Electron, xterm.js with WebGL, `@lydell/node-pty`, esbuild, and plain TypeScript power the app. Output is batched every 16 ms. Scrollback is capped at 10,000 lines. Only the visible terminal is refitted on resize. There is no frontend framework.

Build the Windows x64 portable ZIP:

```powershell
npm run dist:win
npm run test:packaged
```

Artifacts are written to `release/`, including `hershell-<version>-windows-x64.zip`. The packaging configuration includes only compiled app files, production dependencies, icons, and public documentation/templates. It excludes local `.env`, app profiles, tests, source maps, and Git metadata. `test:packaged` extracts the actual ZIP and checks native shell input, restart persistence, browser rendering, settings import, and accidental inclusion of local secrets. It launches the app with a minimal system PATH, without Node/npm directories.

```powershell
npm run build
npx tsc -p .
npm test
node tools/drive.mjs "$env:TEMP\hershell-shots"
node tools/test-agent-api.mjs
node tools/test-browser-api.mjs
node tools/test-telegram.mjs
```

Tests use temporary profiles. Telegram tests use a local mock server and send no real messages. Run UI suites sequentially because they share desktop clipboard and focus.

The optional real Codex test requires an installed, signed-in CLI and can consume model quota:

```powershell
node tools/test-codex-submit.mjs
```

Performance relative to a stock PowerShell window or Windows Terminal has not been benchmarked. See [AGENTS.md](AGENTS.md) for detailed development notes.
