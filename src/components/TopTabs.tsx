"use client";

/**
 * 최상단 탭 네비게이션 — 모든 작업 페이지 위에 고정 노출.
 * 1) 해설제작  /auto
 * 2) 크롭      /crop
 * 3) 시험지 편집 /edit  (placeholder)
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<{ href: string; label: string; hint: string; comingSoon?: boolean }> = [
  { href: "/auto", label: "해설 제작", hint: "PDF/이미지/텍스트 → 자동 풀이 + DOCX" },
  { href: "/crop", label: "크롭", hint: "필요한 문항만 잘라 비용 절약 OCR" },
  {
    href: "/edit",
    label: "시험지 편집",
    hint: "원안 사진 → AI/수동 자르기 → 학교명 자동 → Drive 「시험지」 저장",
  },
  {
    href: "/inbox",
    label: "이어서 작업",
    hint: "이전 풀이 이력에서 자동/크롭 모두 이어서 진행 (DOCX·복원·검수)",
  },
];

export default function TopTabs() {
  const pathname = usePathname() || "/";
  return (
    <nav className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <Link
              key={t.href}
              href={t.href}
              title={t.hint}
              className={`relative -mb-px border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
                active
                  ? "border-indigo-600 text-indigo-700"
                  : t.comingSoon
                    ? "border-transparent text-slate-400 hover:text-slate-600"
                    : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
              }`}
            >
              {t.label}
              {t.comingSoon && (
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                  곧
                </span>
              )}
            </Link>
          );
        })}
        <div className="ml-auto text-[11px] text-slate-500">하이로드 수학 해설지 제작기</div>
      </div>
    </nav>
  );
}
