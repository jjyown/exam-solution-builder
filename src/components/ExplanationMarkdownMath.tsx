"use client";

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { splitMethodBlocks } from "@/lib/explanationBlocks";

const markdownShell =
  "max-w-none text-[15px] leading-7 text-slate-800 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_.katex]:text-[1em] [&_.katex-display]:my-3";

type Props = {
  source: string;
  className?: string;
};

/** react-markdown + remark-math + rehype-katex: $...$ / $$...$$ LaTeX 렌더링 */
export function ExplanationMarkdownMath({ source, className = "" }: Props) {
  if (!source.trim()) {
    return <p className="text-sm text-slate-500">(내용 없음)</p>;
  }
  return (
    <div className={`${markdownShell} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, errorColor: "#b91c1c" }]]}
        components={{
          // 인라인 코드가 $와 충돌하지 않게
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
        {source}
      </ReactMarkdown>
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
