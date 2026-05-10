/**
 * explanationSolverVerify.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LLM 이 생성한 해설의 「정답」 ↔ 「풀이 마지막 결과식」 수학적 일치를
 *  SymPy(Python subprocess) 로 검증한다.
 *
 *  V1~V6 자동 검증은 형식 (JSON·필드·LaTeX·단계 수) 만 체크 — 답이 틀려도 통과.
 *  이 모듈은 답 자체의 수학적 정확성을 검증해 환각을 차단한다.
 *
 *  활성화: SYMPY_VERIFY_ENABLED=true (선택, Python + sympy 의존성 있을 때)
 *
 *  결과:
 *   - ok: true  → 검증 통과 또는 검증 skip (객관식·파싱 실패 등)
 *   - ok: false + mismatch: true → 답과 마지막 식이 다름 → retryHint 로 자동 재시도
 *
 *  보수적 동작:
 *   - SymPy 미설치, Python 없음, timeout → 모두 skip 처리 (ok: true)
 *   - 객관식 보기는 별도로 검증 안 함 (V1~V6 의 객관식 매핑 검증으로 충분)
 *   - 5초 timeout (복잡 식이라도 빠르게 포기)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { ParsedExplanation } from "./explanationValidator";

export type SolverVerifyResult = {
  ok: boolean;
  match?: boolean;
  skipped?: string;
  mismatch?: boolean;
  normalizedAnswer?: string;
  normalizedLast?: string;
  rawAnswer?: string;
  rawLast?: string;
  error?: string;
};

export function isSolverVerifyEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SYMPY_VERIFY_ENABLED || "");
}

/** 마지막 단계의 식 추출 — equation 우선, 없으면 text 의 마지막 등식 */
function extractLastEquation(parsed: ParsedExplanation): string {
  const steps = parsed.explanation_steps || [];
  // 뒤에서부터 equation 이 채워진 step 찾기
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const eq = (steps[i]?.equation || "").trim();
    if (eq) return eq;
  }
  // equation 비어있으면 마지막 step.text 에서 등식 찾기
  const lastText = (steps[steps.length - 1]?.text || "").trim();
  const m = lastText.match(/(?:=\s*)([^\s,。.]+)\s*$/);
  return m ? m[1] : "";
}

/**
 * SymPy 로 정답 검증. SYMPY_VERIFY_ENABLED 안 켜져 있으면 null (검증 안 함).
 * Python/sympy 없으면 스크립트가 자체 skip 응답 → ok: true.
 */
export async function verifyExplanationWithSolver(
  parsed: ParsedExplanation,
): Promise<SolverVerifyResult | null> {
  if (!isSolverVerifyEnabled()) return null;
  if (!parsed) return null;

  const lastEq = extractLastEquation(parsed);
  const payload = {
    answer: parsed.answer || "",
    lastEquation: lastEq,
    problemType: "auto",
  };

  return new Promise<SolverVerifyResult>((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "sympy_verify.py");
    const pythonBin = process.env.SYMPY_VERIFY_PYTHON || "python";
    let proc;
    try {
      proc = spawn(pythonBin, [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: true, skipped: `python spawn 실패: ${(e as Error).message}` });
      return;
    }
    let out = "";
    let err = "";
    const timeoutMs = Number(process.env.SYMPY_VERIFY_TIMEOUT_MS) || 5000;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ ok: true, skipped: `solver timeout ${timeoutMs}ms` });
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: true, skipped: `python error: ${e.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: true, skipped: `solver exit ${code}: ${err.slice(0, 100)}` });
        return;
      }
      try {
        const result = JSON.parse(out.trim());
        resolve(result as SolverVerifyResult);
      } catch {
        resolve({ ok: true, skipped: "solver json parse 실패" });
      }
    });
    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: true, skipped: `stdin write 실패: ${(e as Error).message}` });
    }
  });
}

/** retryHint 메시지 — autoPipeline 에서 재시도 프롬프트에 주입 */
export function buildSolverRetryHint(result: SolverVerifyResult): string {
  if (!result.mismatch) return "";
  const a = result.normalizedAnswer || result.rawAnswer || "(?)";
  const b = result.normalizedLast || result.rawLast || "(?)";
  return (
    `정답 ${a}와 풀이 마지막 결과식 ${b}가 수학적으로 일치하지 않습니다. ` +
    `계산을 다시 검증하고, 정답과 마지막 단계의 결과가 같도록 풀이를 수정하세요. ` +
    `(특히 부호·분수·근호·계산 단계 점검)`
  );
}
