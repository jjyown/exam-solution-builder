/**
 * src/app/api/drive/thumb/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  GET /api/drive/thumb?fileId=...&size=320
 *    Drive 의 thumbnailLink 를 서버가 대신 가져와 브라우저에 그대로 스트리밍.
 *    - 시험지 편집 탭의 「시험지 편집 전」 폴더 picker 가 학교/시험을 시각으로
 *      먼저 식별할 수 있도록 100~115개 파일에 일괄 썸네일 표시.
 *    - 클라이언트에서 직접 thumbnailLink 를 부르면 인증 쿠키 차단으로 실패할 수
 *      있어 항상 서버 프록시를 거친다.
 *
 *  thumbnailLink 가 없으면(드물게) 폴백으로 원본을 다운로드해서 그대로 반환.
 *  큰 파일 폴백 시 트래픽 부담이 있어 max ~10MB 까지만.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getDriveClient, isGoogleDriveConfigured } from "@/lib/googleDrive";

const MAX_FALLBACK_BYTES = 10 * 1024 * 1024; // 10MB

export async function GET(req: Request) {
  if (!isGoogleDriveConfigured()) {
    return new Response("Drive not configured", { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get("fileId");
  const sizeRaw = Number.parseInt(searchParams.get("size") || "320", 10);
  const size = Number.isFinite(sizeRaw) && sizeRaw >= 64 && sizeRaw <= 800 ? sizeRaw : 320;
  if (!fileId) return new Response("fileId required", { status: 400 });

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId,
      fields: "thumbnailLink, mimeType, name",
    });
    let thumbUrl = meta.data.thumbnailLink || "";
    // thumbnailLink 는 보통 `=s220` 같은 사이즈 접미가 붙어 있어 사용자가 원하는 크기로 치환
    if (thumbUrl) {
      thumbUrl = thumbUrl.replace(/=s\d+(-[a-z])?$/, `=s${size}`);
    }
    const fetchHeaders: Record<string, string> = {};

    // 1차: thumbnailLink 시도
    if (thumbUrl) {
      const r = await fetch(thumbUrl, { headers: fetchHeaders });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return new Response(new Uint8Array(buf), {
          headers: {
            "Content-Type": r.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400, immutable",
          },
        });
      }
    }

    // 2차: 원본 다운로드 (이미지 한정·크기 제한). PDF 등은 placeholder 응답.
    const mime = String(meta.data.mimeType || "");
    if (!mime.startsWith("image/")) {
      // 빈 1x1 GIF 로 응답 → 클라이언트가 onError 이미지 fallback 사용
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      return new Response(new Uint8Array(gif), {
        headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
      });
    }
    const dl = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const data = dl.data as ArrayBuffer;
    if (data.byteLength > MAX_FALLBACK_BYTES) {
      return new Response("file too large for thumbnail fallback", { status: 413 });
    }
    return new Response(new Uint8Array(Buffer.from(data)), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (e) {
    return new Response(`thumb error: ${(e as Error).message}`, { status: 500 });
  }
}
