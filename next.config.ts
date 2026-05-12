import type { NextConfig } from "next";

/**
 * Railway(Nixpacks) 배포 설정.
 * - serverExternalPackages: 큰 외부 의존성을 서버 번들에서 분리.
 *   (output: 'standalone' 은 next start 와 충돌해서 제거 — Railway Nixpacks 는
 *    어차피 풀 node_modules 를 들고 가서 standalone 의 슬림 이득이 없음.)
 * - headers: 정적 자산 long-term cache, API 응답 캐시 금지.
 *   Next.js hash 가 붙은 _next/static 은 immutable 이므로 1년 캐시 안전.
 *   페이지 로드 시 자산 재요청 트래픽이 0 → 사용자 체감 속도 ↑.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: [
    "pdfjs-dist",
    "pdf-to-img",
    "@napi-rs/canvas",
    "@google/generative-ai",
    "googleapis",
    "pg",
  ],
  async headers() {
    return [
      {
        // hash 가 붙은 정적 자산 — 영원히 안전하게 캐시 가능
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // public/ 의 일반 정적 파일 (favicon 등) — 짧은 캐시 + revalidate
        source: "/:file(favicon\\.ico|robots\\.txt|sitemap\\.xml)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
        ],
      },
      {
        // 모든 API 라우트 — 캐시 금지 (실시간 데이터·인증·사용자 입력 처리)
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
