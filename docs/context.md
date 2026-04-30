# 하이로드 수학 해설 제작기 컨텍스트 노트

- 문서 기준일: 2026-04-30

## 제품/운영 컨텍스트
- 대상 사용자: 중고등 수학 학원 원장/강사
- 핵심 목표: 문제 추출 후 학생 눈높이 해설을 빠르게 생성하고 DOCX 결과물을 배포 가능한 환경(Vercel)에서 안정적으로 저장
- 현재 배포 환경: Vercel + GitHub `jjyown/exam-solution-builder`
- 현재 생성형 모델: Gemini (`GEMINI_API_KEY`)

## 현재 아키텍처 요약
- 프론트: Next.js App Router (`src/app/page.tsx`)
- 해설 생성 API: `src/app/api/generate-explanation/route.ts`
- 시험지 목록/파일 API: `src/app/api/exams/route.ts`, `src/app/api/exams/file/route.ts`
- 결과 저장 API: `src/app/api/save-result/route.ts`
- Drive 연동 공통 모듈: `src/lib/googleDrive.ts`

## 최근 의사결정 로그
| 날짜 | 결정 | 이유 | 영향 범위 |
|---|---|---|---|
| 2026-04-30 | 문제 추출 비전 사전검증 API(`/api/precheck-extraction`)를 추가하고 생성 전 선차단 정책을 적용 | 크롭 크기 기준만으로 놓치던 누락(선택지/조건/식)을 모델 기반으로 추가 판별 | `src/app/api/precheck-extraction/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 해설 생성 API 재시도 지시를 이슈 유형별(형식/정합/교육과정 이탈)로 분기하고 UI에 품질 경고 플래그를 노출 | 자동 보정 발생 사실과 원인을 운영자가 확인 가능하게 하여 품질 추적성 강화 | `src/app/api/generate-explanation/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 교육과정 외 용어/기호(로피탈, 편미분, 선형대수 등) 감지 필터를 생성 검증에 추가하고, 감지 시 재생성 지시로 교정 | 대학수학 용어 유입으로 학생 눈높이 해설 품질이 흔들리는 문제를 자동 차단 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 생성 결과 검증에 정답-본문 모순/형식 혼합(객관식·주관식) 감지를 추가하고, 실패 시 재생성 지시에 포함 | 형식은 맞아도 내용 정합이 어긋나는 응답을 자동으로 1차 정리 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 생성 결과 포맷 검증(`[정답]`, `[해설]`) 실패 시 동일 모델로 1회 자동 재생성하도록 적용 | 형식 누락으로 파서/저장 단계 품질 저하되는 케이스 감소 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 해설 생성 전 문제 추출 사전검증(크롭 크기/비율/면적) 도입, 기준 미달 시 생성 차단 | 선택지/조건 누락 상태로 잘못 생성되는 케이스 선제 차단 | `src/app/page.tsx` |
| 2026-04-30 | 작업 규칙을 `.cursor/rules/docs-workflow.mdc`로 고정(작업 전 docs 3종 확인, 작업 후 docs 기록 의무화) | 작업 누락/맥락 단절 방지, 연속 작업 안정성 확보 | `.cursor/rules/docs-workflow.mdc`, `docs/plan.md`, `docs/checklist.md` |
| 2026-04-30 | Google Drive 저장 시 `media.body`를 `Readable.from(buffer)` 스트림으로 변경 | Vercel 런타임에서 `body.pipe is not a function` 500 오류 해결 | `src/lib/googleDrive.ts` |
| 2026-04-30 | Drive 모드에서는 로컬 `작업 완료` 폴더 `mkdir`를 건너뛰도록 수정 | `/var/task/작업 완료` ENOENT 오류 해결 | `src/app/api/save-result/route.ts` |
| 2026-04-30 | `/api/exams`, `/api/exams/file`, `/api/save-result` 에러 메시지 상세화 | 운영 중 원인 추적 속도 개선 | `src/app/api/exams/route.ts`, `src/app/api/exams/file/route.ts`, `src/app/api/save-result/route.ts` |
| 2026-04-30 | Drive 인증을 서비스 계정 키 방식에서 OAuth(`CLIENT_ID/SECRET/REFRESH_TOKEN`) 방식으로 전환 | 조직 정책(`iam.disableServiceAccountKeyCreation`)으로 서비스 계정 키 생성 불가 | `src/lib/googleDrive.ts`, `.env.example` |
| 2026-04-30 | Gemini 시스템 프롬프트를 `[정답]`, `[해설]` 통합 문서 형식으로 교체 + 교육과정 외 용어 금지 강화 | 학생용 해설 품질 통제 및 원장 요구 포맷 반영 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 프론트 파서를 신규 형식(`[정답]`, `[해설]`) 우선 파싱 + 기존 포맷 하위호환 유지로 변경 | 배포 중 포맷 전환 시 사용자 경험 단절 방지 | `src/app/page.tsx` |
| 2026-04-30 | DOCX 출력 양식을 2단 표에서 섹션형 문서로 변경 | 테스트 양식(빠른 정답/해설 중심)과 출력 형태 일치 | `src/app/api/save-result/route.ts` |

## 현재 리스크
- OAuth 토큰(`GOOGLE_REFRESH_TOKEN`)이 `GOOGLE_CLIENT_ID/SECRET`와 다른 세트일 경우 `invalid_grant` 재발 가능
- 민감정보(클라이언트 시크릿/토큰) 노출 이력 존재: 재발급 및 키 회전 필요
- 시험지/작업완료 폴더명이 Drive에서 중복될 경우 잘못된 폴더를 선택할 위험

## 운영 메모
- Drive 폴더 기본값: `해설제작/시험지`, `해설제작/작업완료`
- Vercel env 필수: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GEMINI_API_KEY`
- 저장 실패 시 우선 확인 로그: `/api/save-result`
