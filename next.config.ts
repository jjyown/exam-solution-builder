import type { NextConfig } from "next";

/**
 * Railway(Nixpacks) 배포 설정.
 * - serverExternalPackages: 큰 외부 의존성을 서버 번들에서 분리.
 *   (output: 'standalone' 은 next start 와 충돌해서 제거 — Railway Nixpacks 는
 *    어차피 풀 node_modules 를 들고 가서 standalone 의 슬림 이득이 없음.)
 */
const nextConfig: NextConfig = {
  serverExternalPackages: [
    "pdfjs-dist",
    "@google/generative-ai",
    "googleapis",
    "pg",
  ],
};

export default nextConfig;
