/**
 * GET /api/textbook-ocr/list?scope=textbook|exam
 *
 * /textbook-ocr 페이지가 표시할 PDF 목록 + 각 책의 OCR 진행도 + 실패 정보.
 *
 *  scope=textbook (기본): 분석용 자료/시중교재
 *  scope=exam:           분석용 자료/시험지 원안
 *
 * 응답:
 * {
 *   ok: true,
 *   scope: "textbook" | "exam",
 *   books: [{ id, name, sizeBytes, ocrMdCount, totalPages, failedPages, lastBuiltAt, status }]
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getDriveClient,
  resolveDriveAnalysisFolderId,
  findOrCreateChildFolder,
  listDriveFolderFiles,
  downloadDriveFileById,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

const SCOPE_TO_FOLDER: Record<"textbook" | "exam", string> = {
  textbook: "시중교재",
  exam: "시험지 원안",
};

export type TextbookOcrBookStatus =
  | "untouched" // OCR md 0개
  | "partial" // OCR md 있지만 totalPages 미달 또는 manifest 없음
  | "completed" // OCR md ≥ totalPages
  | "has_failures"; // 실패 페이지 있음 — 가장 우선 표시

export type TextbookOcrBookInfo = {
  id: string;
  name: string;
  sizeBytes: number;
  ocrMdCount: number;
  totalPages: number | null;
  failedPages: Array<{ page: number; error: string }>;
  lastBuiltAt: string | null;
  status: TextbookOcrBookStatus;
  /** PR-B 헬스체크가 manifest.json 에 누적한 경고들 — UI 카드 ⚠️/❌ 배지용. PR-A 시점엔 항상 빈 배열. */
  warnings: string[];
};

export async function GET(req: NextRequest): Promise<Response> {
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope: "textbook" | "exam" = scopeParam === "exam" ? "exam" : "textbook";
  const folderName = SCOPE_TO_FOLDER[scope];

  try {
    const drive = getDriveClient();
    const analysisRootId = await resolveDriveAnalysisFolderId(drive);
    if (!analysisRootId) {
      return NextResponse.json(
        { ok: false, error: "「분석용 자료」 Drive 폴더를 찾지 못했습니다." },
        { status: 500 },
      );
    }
    const targetFolderId = await findOrCreateChildFolder(analysisRootId, folderName);
    const pdfFiles = (await listDriveFolderFiles(targetFolderId, new Set([".pdf"]))).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );

    const books: TextbookOcrBookInfo[] = await Promise.all(
      pdfFiles.map(async (pdf): Promise<TextbookOcrBookInfo> => {
        const bookName = pdf.name.replace(/\.pdf$/i, "");
        let ocrMdCount = 0;
        let totalPages: number | null = null;
        let failedPages: Array<{ page: number; error: string }> = [];
        let lastBuiltAt: string | null = null;
        let warnings: string[] = [];

        try {
          const workFolderId = await findOrCreateChildFolder(targetFolderId, bookName);
          const ocrFolderId = await findOrCreateChildFolder(workFolderId, "ocr");
          const ocrFiles = await listDriveFolderFiles(ocrFolderId, new Set([".md"]));
          ocrMdCount = ocrFiles.length;

          // manifest.json 다운로드 → totalPages, pageStatuses, warnings 추출
          const workFiles = await listDriveFolderFiles(workFolderId, new Set([".json"]));
          const manifestFile = workFiles.find((f) => f.name === "manifest.json");
          if (manifestFile) {
            const dl = await downloadDriveFileById(manifestFile.id);
            const parsed = JSON.parse(dl.buffer.toString("utf-8")) as {
              totalPages?: number;
              builtAt?: string;
              pageStatuses?: Array<{ page?: number; ok?: boolean; error?: string }>;
              warnings?: string[];
            };
            totalPages = typeof parsed.totalPages === "number" ? parsed.totalPages : null;
            lastBuiltAt = typeof parsed.builtAt === "string" ? parsed.builtAt : null;
            if (Array.isArray(parsed.pageStatuses)) {
              failedPages = parsed.pageStatuses
                .filter((p) => p && p.ok === false && typeof p.page === "number")
                .map((p) => ({
                  page: p.page as number,
                  error: typeof p.error === "string" ? p.error.slice(0, 200) : "",
                }));
            }
            if (Array.isArray(parsed.warnings)) {
              warnings = parsed.warnings
                .filter((w): w is string => typeof w === "string" && w.length > 0)
                .map((w) => w.slice(0, 300));
            }
          }
        } catch {
          // 책 정보 조회 중 일시 오류는 무시 — 빈 값으로 표시 (사용자가 force 재처리 가능)
        }

        const status: TextbookOcrBookStatus = (() => {
          if (failedPages.length > 0) return "has_failures";
          if (ocrMdCount === 0) return "untouched";
          if (totalPages !== null && ocrMdCount >= totalPages) return "completed";
          return "partial";
        })();

        return {
          id: pdf.id,
          name: bookName,
          sizeBytes: pdf.size ?? 0,
          ocrMdCount,
          totalPages,
          failedPages,
          lastBuiltAt,
          status,
          warnings,
        };
      }),
    );

    // 책 이름 알파벳/한글 정렬 (사용자가 찾기 쉽게)
    books.sort((a, b) => a.name.localeCompare(b.name, "ko"));

    return NextResponse.json({ ok: true, scope, books });
  } catch (e) {
    return NextResponse.json(
      { ok: false, scope, error: (e as Error).message },
      { status: 500 },
    );
  }
}
