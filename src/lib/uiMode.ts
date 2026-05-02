/**
 * `NEXT_PUBLIC_UI_MODE=crop` — 배포(Railway 등)에서 영역 지정·크롭만 쓸 때.
 * 로컬 해설·DOCX 제작은 기본값(full)으로 실행.
 */
export type PublicUiMode = "full" | "crop";

export function getPublicUiMode(): PublicUiMode {
  const raw = (process.env.NEXT_PUBLIC_UI_MODE || "").trim().toLowerCase();
  if (raw === "crop" || raw === "railway" || raw === "crop-only") {
    return "crop";
  }
  return "full";
}

export const isCropOnlyUi = getPublicUiMode() === "crop";
