# 하이로드 수학 해설 제작기 작업 계획서

- 문서 기준일: 2026-04-30

## 프로젝트 목표
- 고화질 시험지 기준으로 문제 추출 및 해설 생성 정확도를 높인다.
- 중고등 교육과정 범위를 벗어나는 용어/기호를 강하게 통제한다.
- 배포 환경(Vercel + Google Drive)에서도 저장 실패 없이 결과물을 안정적으로 생성한다.

## 최근 완료 작업
- Google Drive OAuth 기반 연동 전환 및 런타임 오류 수정
- DOCX 저장 경로 안정화(Drive 모드에서 로컬 파일시스템 접근 제거)
- 해설 생성 시스템 프롬프트 신규 양식 반영(`[정답]`, `[해설]`)
- 프론트 파서 하위호환 포함 포맷 전환 대응
- DOCX 출력 양식 섹션형 개선

## 다음 작업 우선순위(정확도 중심)
1. 문제 추출 품질 사전검증 추가
   - 선택지/조건 누락 감지
   - 품질 기준 미달 시 생성 중단 + 재추출 안내
2. 해설 포맷/정합 검증 강화
   - `[정답]`, `[해설]` 누락 시 재생성 1회
   - 정답/본문 모순 검출 시 검토필요 플래그
3. 교육과정 범위 통제 자동화
   - 대학수학 용어/기호 금지어 필터
   - 탐지 시 후처리 또는 재생성

## 운영 실행 절차(고정)
1) 로컬 테스트 -> 2) 커밋/푸시 -> 3) Vercel redeploy -> 4) 스모크 테스트 -> 5) docs 3종 업데이트

## 배포/운영 체크 포인트
- Vercel 환경변수는 반드시 동일 OAuth 세트 사용:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REFRESH_TOKEN`
- Drive 폴더명 환경변수:
  - `GOOGLE_DRIVE_PARENT_FOLDER_NAME=해설제작`
  - `GOOGLE_DRIVE_EXAMS_FOLDER_NAME=시험지`
  - `GOOGLE_DRIVE_COMPLETED_FOLDER_NAME=작업완료`

## 검증 기준(완료 조건)
- `/api/exams`, `/api/exams/file`, `/api/generate-explanation`, `/api/save-result` 전부 200
- Drive `해설제작/작업완료`에 DOCX 파일 생성 확인
- 생성 문서가 `[정답]` + `[해설]` 양식을 유지
