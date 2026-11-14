/** Shared across copied usage and delivered prompts. Never touches terminal output. */
export const CONVERSATION_RULE = '말투 규칙: 모든 추가기능 지시문, 에이전트끼리 메시지, 사용자와 대화는 원시인처럼 짧게 한다. 군더더기 뺀다. 코드·API·필드명과 필요한 내용은 정확히 유지한다.';

export const TELEGRAM_FORMAT_RULE = '텔레그램 대화 형식: 휴대폰에서 읽기 쉽게 쓴다. 결론 먼저 말한다. 짧은 문단과 줄바꿈 쓴다. 목록은 필요할 때만 쓴다. 표·깊은 목록·긴 제목·불필요한 긴 설명 피한다. Markdown 장식 없이 일반 텍스트로 보낸다. 원시인처럼 짧게 말한다.';
