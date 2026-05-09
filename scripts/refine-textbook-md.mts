#!/usr/bin/env tsx
/**
 * scripts/refine-textbook-md.mts
 * ────────────────────────────────────────────────────────────────────────────
 *  「교재 참고자료」 디렉토리의 *_problemNN.md 들을 같은 stem 의 *_problemNN.png
 *  크롭 이미지를 참조해 Gemini Vision 으로 다시 보정한다.
 *
 *  사용:
 *    npx tsx scripts/refine-textbook-md.mts --root "./교재 참고자료" --dry
 *    npx tsx scripts/refine-textbook-md.mts --root "./교재 참고자료" --max 20
 *    npx tsx scripts/refine-textbook-md.mts --root "./교재 참고자료/확률과 통계"
 *
 *  옵션:
 *    --root <path>      대상 디렉토리 (필수)
 *    --dry              실제로 쓰지 않고 변경 미리보기만
 *    --max <N>          한 번에 처리할 최대 파일 수 (기본 30, Gemini 한도 보호)
 *    --force            이미 표준 마커가 있어도 강제 보정
 *    --no-backup        .md.bak 백업 안 만들기
 *
 *  환경:
 *    GEMINI_API_KEY (필수) — Gemini Vision 호출
 *    GEMINI_OCR_DISABLED=true 면 비용 보호 킬스위치 활성, 호출 거부
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import dotenv from "dotenv";
import {
  findRefineCandidates,
  refineOneCandidate,
  type RefineOptions,
} from "../src/lib/textbookMdRefiner";

type Cli = {
  root: string;
  dry: boolean;
  max: number;
  force: boolean;
  backup: boolean;
};

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { root: "", dry: false, max: 30, force: false, backup: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) {
      cli.root = argv[i + 1];
      i += 1;
    } else if (a === "--dry") {
      cli.dry = true;
    } else if (a === "--max" && argv[i + 1]) {
      cli.max = Math.max(1, Number(argv[i + 1]) || 30);
      i += 1;
    } else if (a === "--force") {
      cli.force = true;
    } else if (a === "--no-backup") {
      cli.backup = false;
    }
  }
  if (!cli.root) {
    console.error("--root <path> 가 필요합니다. 예: --root \"./교재 참고자료\"");
    process.exit(1);
  }
  return cli;
}

async function main() {
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  const cli = parseArgs(process.argv);
  const opts: RefineOptions = {
    dryRun: cli.dry,
    backup: cli.backup,
    max: cli.max,
    force: cli.force,
  };

  const rootAbs = path.isAbsolute(cli.root) ? cli.root : path.join(process.cwd(), cli.root);
  console.log(`[refine-md] 대상: ${rootAbs}`);
  console.log(`[refine-md] 모드: ${cli.dry ? "DRY-RUN (변경 없음)" : "APPLY (덮어쓰기)"}, 최대 ${cli.max}개, force=${cli.force}, backup=${cli.backup}`);

  const candidates = await findRefineCandidates(rootAbs);
  console.log(`[refine-md] 보정 후보: ${candidates.length}건`);
  if (candidates.length === 0) {
    console.log("[refine-md] 모든 md 가 표준 마커·본문 길이 충족. 종료.");
    return;
  }

  const target = candidates.slice(0, cli.max);
  const remaining = candidates.length - target.length;
  if (remaining > 0) {
    console.log(`[refine-md] (이번 실행에선 ${target.length}건만 처리, ${remaining}건은 다음 실행에)`);
  }

  let refined = 0;
  let skipped = 0;
  let failed = 0;
  for (const cand of target) {
    const rel = path.relative(rootAbs, cand.mdPath);
    console.log(`\n[refine-md] ▶ ${rel}`);
    console.log(`              사유: ${cand.reasons.join(" / ")}`);
    const r = await refineOneCandidate(cand, opts);
    switch (r.status) {
      case "refined":
        console.log(`              ✓ 보정 완료 — ${r.bytesBefore}B → ${r.bytesAfter}B, 적용 룰: ${r.addedMarkers.join(", ") || "(추가 마커 없음, 본문 갱신만)"}`);
        refined += 1;
        break;
      case "dry":
        console.log(`              [DRY] 적용 룰: ${r.addedMarkers.join(", ") || "(없음)"}`);
        console.log(`                BEFORE: ${r.previewBefore.replace(/\s+/g, " ").slice(0, 120)}…`);
        console.log(`                AFTER : ${r.previewAfter.replace(/\s+/g, " ").slice(0, 120)}…`);
        refined += 1;
        break;
      case "skipped":
        console.log(`              · skip — ${r.reason}`);
        skipped += 1;
        break;
      case "failed":
        console.log(`              ✗ 실패 — ${r.error}`);
        failed += 1;
        break;
    }
  }

  console.log(`\n[refine-md] 완료: 보정 ${refined}, 스킵 ${skipped}, 실패 ${failed}, 남음 ${remaining}`);
}

void main();
