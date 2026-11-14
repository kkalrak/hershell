import { CONVERSATION_RULE, TELEGRAM_FORMAT_RULE } from './agent-instructions.ts';

export interface ApiConnection { url: string; token: string }

export function telegramUsage(info: ApiConnection): string {
  return `hershell 텔레그램 사용법
${CONVERSATION_RULE}
${TELEGRAM_FORMAT_RULE}
너 대표 에이전트면 텔레그램 지시 받는다. 다른 셸에는 기존 POST /messages로 일 나눈다.
사용자 답장은 너가 모아서 보낸다. 터미널 출력은 자동 전송 안 한다.
API 주소: ${info.url}
GET /telegram : 연결 상태·대표 셸 ID 본다.
POST /telegram/send : 사용자에게 답장 보낸다.
본문: {"from":"너의폴더명","text":"요청 #번호에 대한 결과"}
Authorization: Bearer <HERSHELL_SHELL_TOKEN 환경 변수 값>
Content-Type: application/json
이 API는 대표 셸만 쓴다. 공통 HERSHELL_API_TOKEN으로는 답장 못 한다.
봇 토큰은 hershell만 가진다. 너는 봇 토큰 몰라도 된다.

PowerShell 예시:
$headers = @{ Authorization = "Bearer $env:HERSHELL_SHELL_TOKEN" }
$me = Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells/me" -Headers $headers
$body = @{ from = $me.id; text = '요청 #123에 대한 결과다. 작업 끝났다.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$env:HERSHELL_API_URL/telegram/send" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

새 지시 받으면 결과 답장한다. 어느 요청의 답인지 적는다. 다른 에이전트 답장 오면 다음 일 시킨다.
사진·음성은 못 받는다. 개인 텍스트 채팅만 받는다. 실패하면 또 보내지 말고 사용자에게 알린다.
대표 셸 지정 기억한다. 앱 다시 켜면 같은 셸에 자동 연결한다.
셸은 새로 열린다. 코덱스·클로드는 직접 다시 켠다. 이전 셸 토큰은 다시 못 쓴다.
`;
}

export function browserUsage(info: ApiConnection, suggestedId: string): string {
  return `hershell 웹 테스트 브라우저 API 사용법
${CONVERSATION_RULE}
너 전용 브라우저 쓸 수 있다. hershell이 별도 창 연다. TstBro 설치, 별도 서버 필요 없다.
API 주소: ${info.url}
인증: Authorization: Bearer ${info.token}
접속 정보는 이번 실행에만 쓴다. 앱 다시 켜면 새 사용법 받는다. 환경 변수는 HERSHELL_API_URL / HERSHELL_API_TOKEN 쓴다.
권장 브라우저 ID: ${suggestedId} (서로 다른 에이전트는 다른 ID 사용; 영문·숫자·하이픈·밑줄 1~60자)

GET /browsers : 열린 브라우저 목록
POST /browsers/:id : 생성·재사용·복원
DELETE /browsers/:id : 상태 저장 후 닫기 (프로필 보관)
GET /browsers/:id/state : URL·제목·활동·캡처 정보
POST /browsers/:id/heartbeat : 유휴 시간 연장
POST /browsers/:id/:action : 브라우저 조작 (없으면 자동 생성·복원)
본문은 JSON 쓴다. Content-Type: application/json 붙인다.

action별 본문:
navigate {"url":"http://localhost:3000"}
click {"selector":"#submit"} 또는 {"x":100,"y":200}
type {"selector":"#name","text":"내용","clear":true} (selector 생략 시 현재 포커스에 입력)
key {"key":"Enter"} (Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right 지원)
scroll {"deltaY":500,"deltaX":0}
snapshot {} : 페이지 텍스트와 최대 250개 요소·좌표
evaluate {"expression":"document.title"} : 페이지 JS 결과를 {value: ...}로 반환
screenshot {"format":"png"} 또는 jpeg : 이미지 바이너리 (JSON 아님)
user-agent {"value":"원하는 User-Agent"} : 다음 요청부터 적용
back / forward / reload {}

Node.js 예시 (셸에서 실행하는 스크립트):
const fs = require('node:fs');
const base = (process.env.HERSHELL_API_URL || '${info.url}') + '/browsers/${suggestedId}';
const token = process.env.HERSHELL_API_TOKEN || '${info.token}';
async function command(action = '', params = {}) {
  const r = await fetch(base + (action ? '/' + action : ''), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw Error(await r.text());
  return r;
}
// async 함수 안에서 실행한다:
await command();
await command('navigate', { url: 'http://localhost:3000' }); // 실제 테스트 주소로 변경
console.log(await (await command('snapshot')).json());
fs.writeFileSync('screen.png', Buffer.from(await (await command('screenshot')).arrayBuffer()));
await command('heartbeat');

좌표는 웹 화면 기준 CSS 픽셀이다. 스크린샷은 지금 보이는 웹 화면만 찍는다.
같은 ID 요청은 차례로 간다. 다른 ID는 동시에 간다. 클릭·키 입력 뒤 snapshot/evaluate로 결과 본다.
10분 안 쓰면 저장하고 닫는다. 오래 생각할 땐 heartbeat 보낸다.
URL·스크롤·창 위치/크기·User-Agent·쿠키 저장한다. localStorage/IndexedDB는 ID별로 따로 둔다.
작성 중인 폼·실행 중 JS·WebSocket·sessionStorage는 못 살린다. 다시 요청하면 페이지 새로 연다.
iframe/Shadow DOM 안쪽 selector는 못 찾는다. HTTP(S) 사이트만 연다. 카메라 같은 권한은 안 준다.
hershell 끄면 브라우저도 닫힌다. 사용자가 알려준 기능만 쓴다.
`;
}

export function messageUsage(info: ApiConnection, shellId: string): string {
  return `hershell 에이전트 간 메시지 API 사용법
${CONVERSATION_RULE}
너의 현재 셸 ID: ${shellId}
API 주소: ${info.url}
인증 토큰: ${info.token}
이 정보는 이번 실행에만 쓴다. 앱 다시 켜면 사용법 다시 복사한다.

셸 목록: GET /shells (응답 예: [{"id":"minecraft","cwd":"전체 경로"}])
내 ID: GET /shells/me (인증은 HERSHELL_SHELL_TOKEN 쓴다)
메시지 보내기: POST /messages
Authorization: Bearer <인증 토큰>
Content-Type: application/json
본문: {"from":${JSON.stringify(shellId)},"to":"minecraft","message":"전달할 내용"}

PowerShell 예시다. hershell 셸에는 환경 변수 이미 있다:
$headers = @{ Authorization = "Bearer $env:HERSHELL_SHELL_TOKEN" }
Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells" -Headers $headers
$me = Invoke-RestMethod -Uri "$env:HERSHELL_API_URL/shells/me" -Headers $headers
$body = @{ from = $me.id; to = 'minecraft'; message = '이 설계 검토해라. 이 요청에 답장 줘라.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$env:HERSHELL_API_URL/messages" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

먼저 GET /shells 조회한다. ID는 폴더명이다. to에는 실제 상대 폴더명 넣는다. 숫자 순서 안 쓴다.
폴더명이 겹치면 목록의 전체 경로를 ID로 쓴다. 같은 전체 경로도 여러 개면 409다. 임의로 고르지 않는다.
정렬돼도 ID 그대로다. 폴더 이동하면 ID 바뀐다. 보내기 전에 목록과 GET /shells/me 다시 본다.
HERSHELL_SHELL_ID는 시작 폴더 이름이라 이동 후 오래된 값일 수 있다. 현재 ID는 GET /shells/me로 찾는다.
받은 말 앞에 [hershell 발신폴더 → 수신폴더] 있다. 발신 폴더 ID로 답장 보낸다.

대화 규칙이다. 너가 지킨다:
- 새 작업·질문 보낼 때 원하는 답 적는다. 답장 꼭 달라고 한다.
- 같은 상대에게는 답장 오면 다음 말 보낸다. HTTP 전송 성공은 답장 아니다.
- 답장할 때 어떤 요청에 대한 답인지 적는다.
- 단순 확인·마지막 답변에는 또 답장 요구 안 한다. 끝없이 주고받지 않는다.
- 답장 없으면 또 보내지 않는다. 사용자에게 알린다.

메시지는 POST /messages API만 호출해서 보낸다. 붙여넣기와 Enter는 허셀이 처리한다. 너는 Enter 따로 누르지 않는다.
허셀은 상대 작업·승인·답장 상태 안 본다.
셸 끝났으면 404, 전달 실패면 503이다. 실패하면 무작정 다시 보내지 않는다.
{"delivered":true}는 입력 보냈다는 뜻이다. 상대가 읽었거나 일 끝냈다는 뜻 아니다.
`;
}
