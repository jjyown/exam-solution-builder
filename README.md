# 하이로드 수학 해설지 제작기

시험지 폴더에서 이미지/PDF를 선택하고 문제 영역을 지정하면 해설을 생성하고, 결과를 PDF/텍스트로 저장할 수 있는 Next.js 웹앱입니다.

## 주요 기능

- 좌측: `시험지`(또는 `exams`) 폴더 파일 선택, 문제 영역 크롭, 문제 텍스트 입력
- PDF 지원: 페이지 이동 후 원하는 문제 영역만 지정 가능
- 우측: 해설지 스타일 미리보기
  - 상단 `[빠른 정답 체크]` 박스
  - 하단 상세 해설 2단 레이아웃(`column-count: 2`)
- 수식 렌더링: `react-katex` (LaTeX 지원)
- PDF 저장: `html2canvas` + `jspdf`
- 작업 완료 저장: `작업 완료` 폴더에 PDF + TXT 자동 저장
- 백엔드 API: Gemini/OpenAI 기반 해설 생성

## 실행 방법

### 방법 A) 더블클릭 실행 (권장)

- 프로젝트 루트의 `실행.bat` 더블클릭
- 또는 상위 폴더의 `해설지_실행.bat` 더블클릭

### 방법 A-2) Docker 더블클릭 실행 (어느 PC든 동일 환경)

- Docker Desktop만 설치되어 있으면 Node 설치 없이 실행됩니다.
- 프로젝트 루트의 `도커로_실행.bat` 더블클릭
- 내부적으로 `docker compose up -d --build`를 실행합니다.
- 종료 시:

```bash
docker compose down
```

### 방법 B) 터미널 실행

1) 의존성 설치

```bash
npm install
```

2) 개발 서버 실행

```bash
npm run dev
```

3) 브라우저에서 접속

[http://localhost:3000](http://localhost:3000)

## 폴더 기반 작업 흐름

1) `시험지` 또는 `exams` 폴더에 시험지 파일(png/jpg/pdf)을 넣습니다.  
2) 앱에서 `시험지 폴더 새로고침` 클릭 후 원하는 파일을 클릭합니다.  
3) PDF인 경우 페이지를 이동한 뒤 문제 영역을 드래그해 지정합니다.  
4) 문제 번호/문제 텍스트를 입력합니다.  
5) `해설 생성 (한 문제)` 클릭  
6) 검토 후 `작업 완료 폴더로 저장` 클릭  
7) `작업 완료` 폴더에 PDF와 TXT가 생성됩니다.

## 다른 컴퓨터에서도 쓰는 방법

1) 프로젝트 폴더 전체를 복사합니다.  
2) `.env.local`에 `GEMINI_API_KEY`를 설정합니다.  
3) 아래 중 하나를 실행합니다.
- Node가 설치된 PC: `해설지_실행.bat`
- Node가 없는 PC: `도커로_실행.bat` (Docker Desktop 필요)

## Railway 배포(운영 권장)

1) GitHub에 현재 프로젝트를 push  
2) Railway에서 **New Project -> Deploy from GitHub Repo** 선택  
3) Root Directory를 `highroad-math-solution`로 지정  
4) Railway Variables에 `.env.local.example` 항목을 기준으로 키 등록  
5) Deploy 후 생성된 Railway URL로 접속

권장 환경변수:
- 필수: `GEMINI_API_KEY`, `OPENAI_API_KEY`
- 선택: `OPENAI_MODEL_GENERATE_FALLBACK`, `OPENAI_MODEL_REPAIR_FALLBACK`
- 선택: `GEMINI_MODELS_*` (모델 후보를 환경변수로 관리)

운영 체크:
- 5문항 배치 생성 테스트(순차 + 딜레이 + 백오프 적용 상태)
- DOCX 생성 및 자동 보정 경로 확인
- 실패 시 UI의 `상세` 로그로 어떤 모델 경로에서 실패했는지 점검

## 구현 위치

- 화면/UI: `src/app/page.tsx`
- Gemini API 라우트: `src/app/api/generate-explanation/route.ts`
- 시험지 목록 API: `src/app/api/exams/route.ts`
- 시험지 파일 API: `src/app/api/exams/file/route.ts`
- 작업 완료 저장 API: `src/app/api/save-result/route.ts`
- 전역 스타일(2단 레이아웃): `src/app/globals.css`

## 참고

- Gemini 응답 형식을 안정화하기 위해 시스템 프롬프트를 API 라우트에 고정했습니다.
- PDF는 A4 기준으로 저장되며, 내용이 길면 자동으로 다음 페이지를 추가합니다.
- 현재 파이프라인 모델 목록은 `docs/models.md`를 참고하세요.

## 모델 운영 가이드

- Gemini 경로: `docs/models.md` 기준으로 환경변수에서 후보를 관리합니다.
- 생성/보정 API는 Gemini 실패 시 OpenAI 폴백을 사용합니다.
- 모델명은 코드 하드코딩보다 `.env.local`/배포 환경변수에서 운영하는 것을 권장합니다.

## 도형 보조 이미지(바나나) 자동 판정 가이드 (고정)

기본은 텍스트 해설로 진행하고, 아래 신호가 강할 때만 도형 보조 이미지를 추가하는 것을 권장합니다.

- 권장 신호(예시)
  - 도형/기하 키워드: `도형`, `기하`, `삼각형`, `원`, `닮음`, `합동`
  - 작도/보조선 지시: `작도`, `보조선`, `연장선`, `수선의 발`
  - 좌표/그래프 중심 문제: `좌표평면`, `그래프`, `포물선`, `절편`
  - 시각자료 직접 언급: `다음 그림`, `도표`, `도식`
- 운영 원칙
  - 전체 문항 일괄 적용 금지, 필요한 문항에만 선택 적용
  - 보조 이미지는 1~2장으로 제한(비용/속도 관리)
  - 텍스트 해설이 충분하면 이미지 생성은 생략
