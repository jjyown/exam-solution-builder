"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { splitLabeledQuestionMarkdownChunks, splitMethodBlocks } from "@/lib/explanationBlocks";
import { normalizeLatexSourceText } from "@/lib/latexSourceNormalize";

const markdownShell =
  "max-w-none text-[15px] leading-7 text-slate-800 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_.katex]:text-[1em] [&_.katex-display]:my-3";

type Props = {
  source: string;
  className?: string;
};

const katexOptions = { strict: false, throwOnError: false, errorColor: "#b91c1c" } as const;

/**
 * Supabase 미리보기에서도 DOCX 렌더와 유사하게 보이도록
 * \(...\), \[...\] 구분자를 markdown 수학 구분자($, $$)로 맞춘다.
 */
function normalizeMathDelimitersForPreview(source: string): string {
  let s = normalizeLatexSourceText(source);
  // 축약 분수 표기(\frac12)를 명시 분수(\frac{1}{2})로 보정해 렌더 안정성을 높인다.
  s = s.replace(/\\frac(?!\{)\s*([A-Za-z0-9])\s*([A-Za-z0-9])(?![A-Za-z0-9])/g, "\\frac{$1}{$2}");
  s = s.replace(/#wfrac\b/gi, "\\frac");
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => `$${inner}$`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`);
  return s;
}

function MarkdownBlock({ source, className = "" }: Props) {
  const normalizedSource = normalizeMathDelimitersForPreview(source);
  if (!normalizedSource.trim()) {
    return <p className="text-sm text-slate-500">(내용 없음)</p>;
  }
  return (
    <div className={`${markdownShell} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        components={{
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = String(codeClass ?? "").includes("language-");
            if (isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.9em]" {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {normalizedSource}
      </ReactMarkdown>
    </div>
  );
}

/** 첫 두 구간은 바로 렌더(인트로+첫 문항 등), 나머지는 스크롤 근처에서 마운트해 메인 스레드 피크를 줄인다. */
function LazyLabeledChunk({
  chunk,
  className,
  index,
}: {
  chunk: string;
  className: string;
  index: number;
}) {
  const eager = index < 2;
  const holderRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(eager);

  useEffect(() => {
    if (eager || show) return;
    const el = holderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShow(true);
            obs.disconnect();
            break;
          }
        }
      },
      { root: null, rootMargin: "280px 0px 120px 0px", threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [eager, show]);

  return (
    <div ref={holderRef} className="min-h-[48px] scroll-mt-2 [&:not(:last-child)]:mb-5">
      {show ? (
        <MarkdownBlock source={chunk} className={className} />
      ) : (
        <div className="rounded border border-dashed border-slate-200/90 bg-slate-50 py-8 text-center text-[11px] leading-snug text-slate-500">
          아래로 스크롤하면 이 문항 구간의 수식이 렌더링됩니다.
        </div>
      )}
    </div>
  );
}

/** react-markdown + remark-math + rehype-katex: $...$ / $$...$$ LaTeX 렌더링 */
export function ExplanationMarkdownMath({ source, className = "" }: Props) {
  const normalizedSource = useMemo(() => normalizeMathDelimitersForPreview(source), [source]);
  const chunks = useMemo(() => splitLabeledQuestionMarkdownChunks(normalizedSource), [normalizedSource]);
  if (!source.trim()) {
    return <p className="text-sm text-slate-500">(내용 없음)</p>;
  }

  const multiLabeled = chunks.length >= 2;

  if (!multiLabeled) {
    return <MarkdownBlock source={normalizedSource} className={className} />;
  }

  return (
    <div className={`${className}`.trim()}>
      {chunks.map((chunk, idx) => (
        <LazyLabeledChunk
          key={`labeled-md-${idx}-${chunk.length}-${chunk.slice(0, 32)}`}
          chunk={chunk}
          className={className}
          index={idx}
        />
      ))}
    </div>
  );
}

/** [방법 n] 섹션이 있으면 구획·없으면 통째로 Markdown */
export function MethodBlocksMarkdown({ source, className = "" }: Props) {
  const { intro, methods } = splitMethodBlocks(source);
  if (methods.length === 0) {
    return <ExplanationMarkdownMath source={source} className={className} />;
  }
  return (
    <div className={`space-y-4 ${className}`.trim()}>
      {intro ? (
        <div className="rounded-md border border-slate-100 bg-white/80 p-3">
          <ExplanationMarkdownMath source={intro} />
        </div>
      ) : null}
      {methods.map((block, idx) => (
        <section
          key={`method-md-${idx}`}
          className="rounded-md border border-indigo-100 bg-indigo-50/40 p-4 shadow-sm"
        >
          <ExplanationMarkdownMath source={block} />
        </section>
      ))}
    </div>
  );
}
