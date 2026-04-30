# 하이로드 수학 해설 제작기 체크리스트

- 문서 기준일: 2026-04-30

## 이번 작업 사이클 체크
- [x] Drive 연동 방식을 서비스 계정 키 -> OAuth 토큰 방식으로 전환
- [x] Vercel 런타임 저장 오류(`ENOENT`, `body.pipe`) 원인 분류 및 코드 수정
- [x] 저장 API(`/api/save-result`)의 Drive 업로드 경로 정상화
- [x] 해설 생성 시스템 프롬프트를 신규 양식(`[정답]`, `[해설]`)으로 교체
- [x] 프론트 파서를 신규 양식 우선 인식 + 기존 양식 하위호환 유지
- [x] DOCX 출력 포맷을 섹션형 문서 구조로 개선
- [x] API 에러 메시지 상세화(운영 로그 추적성 강화)
- [x] `npm run build`로 타입/빌드 검증 완료

## 배포 전 체크
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` 동일 OAuth 세트 확인
- [ ] `GEMINI_API_KEY` 설정 확인
- [ ] Drive 폴더 구조(`해설제작/시험지`, `해설제작/작업완료`) 존재 확인
- [ ] 민감정보 재발급/키 회전 여부 확인(노출 이력 대응)
- [ ] Git 커밋/푸시 후 Vercel Redeploy

## 배포 후 스모크 테스트
- [ ] 시험지 목록 새로고침(`/api/exams`) 성공
- [ ] 시험지 파일 로드(`/api/exams/file`) 성공
- [ ] 해설 생성(`/api/generate-explanation`) 성공
- [ ] 저장(`/api/save-result`) 성공 및 Drive `작업완료`에 DOCX 생성 확인
- [ ] 결과 DOCX가 `[정답]`, `[해설]` 중심 양식으로 출력되는지 확인

## 장애 원인분류 기록(요약)
- [x] `invalid_grant`: OAuth 토큰 세트 불일치/만료 이슈
- [x] `ENOENT /var/task/작업 완료`: Drive 모드에서도 로컬 mkdir 수행하던 로직 이슈
- [x] `body.pipe is not a function`: Drive 업로드 `media.body` 타입 이슈(Buffer 직접 전달)

## 다음 개선 후보
- [ ] 문제 추출 품질 사전검증(선택지/조건 누락 감지) 추가
- [ ] 해설 포맷 검증 실패 시 자동 재생성 1회
- [ ] 교육과정 외 금지 용어/기호 후처리 필터 추가
