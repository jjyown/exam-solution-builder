/**
 * postToolUse: MCP 해설 도구 직후 additional_context 주입 (Cursor hooks)
 * stdin: { tool_name, tool_input, tool_output, ... }
 */
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.stdout.write("{}");
  process.exit(0);
}

const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
if (!/generate_math_explanation/.test(toolName)) {
  process.stdout.write("{}");
  process.exit(0);
}

const CHECKLIST = `[MCP 해설 직후 필수 다듬기 — 아래 5항목을 모두 반영한 최종본만 저장]

1) 객관식 포맷: [정답]에 숫자만 덜렁 넣지 말 것. 반드시 「②번」또는 「②번 (구하는 값은 6)」 형태로 보기 번호 중심으로 교정.

2) 서술형/단답형: 정답이 복잡하거나 풀이 전체가 답인 경우 [정답]에는 「해설참고」로 기재.

3) 수식 무결성(최우선): LaTeX(\\frac, \\sqrt, \\sin 등) 깨짐 없는지 확인. $ / $$ 열고 닫는 짝이 맞는지 검사. DOCX 변환 시 뭉개지지 않게 텍스트 정제.

4) 논리 일치: 해설 마지막 결론과 최상단 [정답]이 같은 답을 가리키는지 한 번 더 검산.

5) 금지 문구: 「풀 수 없습니다」「화질이 나쁩니다」 등 회피 문구가 있으면 해당 문항만 MCP로 재풀이.

[파일 저장 규칙]
검수를 모두 마친 최종본만 「문항##_API초안.md」「합본_편집용.md」에 쓸 것. 미검수 초안은 저장하지 말 것.

[이번 턴 마무리 보고 — 필수]
한 문장으로: 체크리스트 5항목 검수 완료 여부, 수정한 항목(예: LaTeX·정답 포맷), 저장한 파일 경로를 명시.`;

process.stdout.write(JSON.stringify({ additional_context: CHECKLIST }));
process.exit(0);
