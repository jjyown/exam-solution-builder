/**
 * autoPipelineRetriever.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 파이프라인 KB 검색기를 모듈 전역으로 1회 인덱싱해 재사용.
 *   - reference/kb.jsonl (시드)
 *   - Google Drive 「분석용 자료」 폴더 (있으면 자동 합산)
 *  분석용 자료 강제 재동기화: resetRetrieverCache() → 다음 호출 때 재로딩.
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import { ReferenceRetriever } from "./referenceRetriever";

let retrieverPromise: Promise<ReferenceRetriever> | null = null;

export function getAutoPipelineRetriever(): Promise<ReferenceRetriever> {
  if (!retrieverPromise) {
    const kbPath =
      process.env.REFERENCE_KB_PATH ||
      path.join(process.cwd(), "reference", "kb.jsonl");
    retrieverPromise = ReferenceRetriever.fromJsonl(kbPath).then(async (r) => {
      try {
        const { loadDriveAnalysisRecords } = await import("./driveAnalysisLearner");
        const { records } = await loadDriveAnalysisRecords();
        if (records.length > 0) r.addRecords(records);
      } catch {
        // best-effort
      }
      return r;
    });
  }
  return retrieverPromise;
}

export function resetAutoPipelineRetriever(): void {
  retrieverPromise = null;
}
