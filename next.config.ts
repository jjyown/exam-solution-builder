import type { NextConfig } from "next";

/**
 * Railway 배포에 최적화된 Next 설정.
 * - `output: 'standalone'` 으로 컨테이너 빌드 산출물을 가볍게.
 * - serverExternalPackages: 큰 외부 의존성을 서버 번들에서 분리.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "pdfjs-dist",
    "@google/generative-ai",
    "googleapis",
  ],
};

export default nextConfig;
