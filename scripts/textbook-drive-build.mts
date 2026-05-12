/**
 * textbook-drive-build.mts (CLI wrapper)
 * ────────────────────────────────────────────────────────────────────────────
 *  실제 로직은 src/lib/textbookDriveBuildRunner.ts.
 *  이 스크립트는 인자 파싱 + 환경변수 로드 + lib 호출만 담당하는 얇은 래퍼.
 *
 *  Railway 자동 실행 (textbookDriveBuildAutoRun.ts) 도 같은 lib 함수를 사용해
 *  로컬 CLI 와 서버 자동 실행이 동일한 동작·동일한 산출물을 보장한다.
 *
 *  실행 예:
 *    npm run textbook:drive-build
 *    npm run textbook:drive-build -- --book "고1) 쎈 공통수학1 (22개정)"
 *    npm run textbook:drive-build -- --max-pages 3 --force
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import dotenv from "dotenv";

type Cli = {
  bookFilter: string | null;
  maxPages: number;
  force: boolean;
};

function parseArgs(argv: string[]): Cli {
  let bookFilter: string | null = null;
  let maxPages = 0;
  let force = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--book" && argv[i + 1]) {
      bookFilter = argv[i + 1]!;
      i += 1;
    } else if (a === "--max-pages" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) maxPages = Math.floor(n);
      i += 1;
    } else if (a === "--force") {
      force = true;
    }
  }
  return { bookFilter, maxPages, force };
}

async function main() {
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  const cli = parseArgs(process.argv);

  const { runTextbookDriveBuild } = await import("../src/lib/textbookDriveBuildRunner.ts");

  await runTextbookDriveBuild({
    bookFilter: cli.bookFilter,
    maxPages: cli.maxPages,
    force: cli.force,
    log: (m) => console.log(m),
  });

  console.log("  ▷ Drive: 분석용 자료/<폴더>/<PDF>/{pages, ocr, manifest.json}");
  console.log("  ▷ 로컬:  교재 참고자료/<폴더>/<PDF>/*.md  ← retriever 자동 합산");
}

void main().catch((e) => {
  console.error(`[textbook-drive-build] 실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
