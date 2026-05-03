import { validateObjectiveMcAnswer } from "./explanationAnswerValidators";

export type SolverProfile = "easy" | "balanced" | "killer";

export type ExplanationProgressReport = {
  /** 단계 요약 (UI·Cursor·배치 로그 공용) */
  phases: {
    phase1_gemini: {
      label: string;
      status: "completed" | "failed";
      detail: string;
      modelHint: string;
    };
    phase1b_autoChecks: {
      objectiveMcFormatOk: boolean;
      objectiveMcIssues: string[];
      truncatedSuspected: boolean;
      explanationCharCount: number;
      explanationTooLongForProfile: boolean;
      profileMaxCharsHint: number;
      killerStyleSuspected: boolean;
      unsolvableOrNegativeMeta: boolean;
    };
    phase2_crossVerify: {
      applied: boolean;
      detail: string;
    };
  };
  /** Cursor에서 수동 수정 시 우선 볼 체크리스트 */
  cursorManualChecklist: string[];
  /** API가 넘기던 경고 문자열 그대로 */
  rawQualityWarnings: string[];
};

function profileMaxChars(profile: SolverProfile): number {
  if (profile === "killer") return 5500;
  if (profile === "easy") return 2000;
  return 3200;
}

export function buildExplanationProgressReport(params: {
  finalText: string;
  model: string;
  qualityWarnings: string[];
  crossVerified: boolean;
  verifyWarning?: string;
  retriedForFormat?: boolean;
  solverModelProfile: SolverProfile;
}): ExplanationProgressReport {
  const mc = validateObjectiveMcAnswer(params.finalText);
  const expl = params.finalText.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  const maxChars = profileMaxChars(params.solverModelProfile);
  const truncatedSuspected =
    expl.length < 50 || /[,:+\-*/=]$/.test(expl) || /\[[^\]]*$/.test(expl.slice(-80));
  const explanationTooLongForProfile = expl.length > maxChars;
  const killerStyleSuspected =
    params.solverModelProfile !== "killer" && expl.length > 4200;

  const unsolvableOrNegativeMeta =
    /풀\s*수\s*없|추가\s*조건이\s*필요|이대로는\s*(?:답을\s*)?구할\s*수\s*없|문제\s*오류|출제\s*오류|논리(?:적)?\s*모순/i.test(
      expl,
    );

  const modelHint = params.model.split("+")[0]?.trim() || params.model;

  const cursorManualChecklist: string[] = [];
  if (!mc.ok) {
    mc.issues.forEach((s) => cursorManualChecklist.push(`[객관식·정답 형식] ${s}`));
  }
  if (truncatedSuspected) {
    cursorManualChecklist.push(
      "[잘림·미완성 의심] 해설이 짧거나 끝이 연산자/불완전 괄호 → 재생성·토큰·이미지 확인",
    );
  }
  if (explanationTooLongForProfile) {
    cursorManualChecklist.push(
      `[분량] 해설 약 ${expl.length}자 (이번 프로필 권장 상한 ${maxChars}자 초과) → 킬러급·압축 필요 여부 검토`,
    );
  } else if (killerStyleSuspected) {
    cursorManualChecklist.push(
      "[분량] 일반 프로필인데 해설이 매우 김 → 난이도·중복 서술·킬러 여부 확인",
    );
  }
  if (unsolvableOrNegativeMeta) {
    cursorManualChecklist.push(
      "[톤] 불가·출제오류·모순류 표현 → 교과서형 정석 풀이로 교체 검토",
    );
  }
  (params.qualityWarnings ?? []).forEach((w) => {
    cursorManualChecklist.push(`[자동 경고] ${w}`);
  });
  if (params.verifyWarning) {
    cursorManualChecklist.push(`[2차 교차검증] ${params.verifyWarning}`);
  }

  return {
    phases: {
      phase1_gemini: {
        label: "1차 Gemini(비전) 풀이",
        status: "completed",
        detail: params.retriedForFormat
          ? "형식·정합 재요청 후 통과한 응답"
          : "1차 생성 응답 확정",
        modelHint,
      },
      phase1b_autoChecks: {
        objectiveMcFormatOk: mc.ok,
        objectiveMcIssues: mc.issues,
        truncatedSuspected,
        explanationCharCount: expl.length,
        explanationTooLongForProfile,
        profileMaxCharsHint: maxChars,
        killerStyleSuspected,
        unsolvableOrNegativeMeta,
      },
      phase2_crossVerify: {
        applied: params.crossVerified,
        detail:
          params.verifyWarning?.trim() ||
          (params.crossVerified
            ? "OpenAI 등 교차검증 적용됨"
            : "교차검증 미적용·실패 시 1차 초안 유지"),
      },
    },
    cursorManualChecklist,
    rawQualityWarnings: params.qualityWarnings ?? [],
  };
}

/** 배치·터미널·텍스트 파일용 한국어 요약 */
export function formatProgressReportKo(
  questionLabel: string,
  report: ExplanationProgressReport,
): string {
  const p = report.phases;
  const lines: string[] = [];
  lines.push(`──────── 문항 ${questionLabel} ────────`);
  lines.push(`[1차] ${p.phase1_gemini.label}: ${p.phase1_gemini.detail}`);
  lines.push(`      모델 힌트: ${p.phase1_gemini.modelHint}`);
  lines.push(`[자동검사] 객관식·정답 형식: ${p.phase1b_autoChecks.objectiveMcFormatOk ? "통과" : "주의"}`);
  if (p.phase1b_autoChecks.objectiveMcIssues.length > 0) {
    p.phase1b_autoChecks.objectiveMcIssues.forEach((x) => lines.push(`          · ${x}`));
  }
  lines.push(
    `          잘림 의심: ${p.phase1b_autoChecks.truncatedSuspected ? "예" : "아니오"} · 해설 글자수: ${p.phase1b_autoChecks.explanationCharCount} (권장≤${p.phase1b_autoChecks.profileMaxCharsHint})`,
  );
  lines.push(
    `          킬러급 분량 의심: ${p.phase1b_autoChecks.killerStyleSuspected || p.phase1b_autoChecks.explanationTooLongForProfile ? "예(검토)" : "아니오"}`,
  );
  lines.push(
    `          부정 메타(못 푼다 등): ${p.phase1b_autoChecks.unsolvableOrNegativeMeta ? "감지됨" : "없음"}`,
  );
  lines.push(`[2차] 교차검증: ${p.phase2_crossVerify.applied ? "적용" : "미적용/유지"} — ${p.phase2_crossVerify.detail}`);
  if (report.cursorManualChecklist.length > 0) {
    lines.push(`[Cursor 수동 확인 권장]`);
    report.cursorManualChecklist.forEach((c) => lines.push(`  · ${c}`));
  }
  lines.push("");
  return lines.join("\n");
}
