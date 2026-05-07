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
    hint: "(준비 중) 시험지 본문 직접 편집",
    comingSoon: true,
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
