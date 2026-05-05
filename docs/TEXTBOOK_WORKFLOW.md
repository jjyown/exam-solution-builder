# 시중교재 해설 워크플로우

## 목적

- 시중교재 입력을 시험지 일반 입력과 분리해, OCR/가독성 보정 정책을 안정적으로 적용한다.

## 실행 커맨드

```bash
npm run final:from-textbook -- --input "./크롭된 시험지" --exam-name "[교재] 2026 6평"
```

## 0) 교재 참고자료(단원/유형/난이도) 구축

- 입력 폴더 구조를 아래처럼 맞추면 자동으로 메타가 붙는다.
  - `<입력루트>/<단원>/<유형>/<난이도>/*.png|jpg`
- Mathpix OCR로 참고 md를 생성:

```bash
npm run textbook:build-reference -- --input "./교재 입력" --output "./교재 참고자료"
```

- 생성 산출: `./교재 참고자료/<단원>/<유형>/<난이도>/*.md`
- 각 md에는 frontmatter(`unit/type/difficulty`) + OCR 본문이 저장된다.
- 기본 동작: 같은 경로의 md가 이미 있으면 **스킵**
- 강제 재OCR: `--force`

```bash
npm run textbook:build-reference -- --input "./교재 입력" --output "./교재 참고자료" --force
```

## 0-1) 한 페이지에 문제가 여러 개: Mathpix bbox로 문항 분할(실전형 Multi-Mapping)

- **문제**: `1페이지 = 이미지 1장`인데 문항은 3~4개면, 파일명 번호만으로 이미지↔md 1:1 매핑이 깨진다.
- **해결**: Mathpix `include_line_data`로 줄 단위 `cnt`(바운딩 박스)를 받아, 문항 시작 패턴(`1.`, `22)` 등)마다 구간을 나누고 **구간별 bbox 합집합**으로 페이지 이미지를 크롭한다.
- **의존성**: `pip install -r scripts/requirements-textbook-ocr.txt` (Pillow)
- **실행 예**:

```bash
npm run textbook:split-pages -- --input "./페이지이미지폴더" --output "./문항별산출"
```

- **옵션**: `--force`(덮어쓰기), `--padding 0.02`(크롭 여백 비율), `--max-workers 3`(페이지 병렬, 최대 5), `--unit` / `--type` / `--difficulty`(md frontmatter 보강)
- **산출**: `{페이지파일명_stem}_problem01.png` + 동명 `.md` … (한 페이지에서 검출된 문항 수만큼)
- **한계(전문가 메모)**: 문항 번호가 OCR에서 누락되거나 줄 단위 bbox가 비면 **1문항 폴백**(전체 페이지 1세트)으로 떨어질 수 있다. 이 경우 원본 스캔 품질·레이아웃(단락)을 점검하거나 `--force`로 재시도한다.

## 기본 동작

- 내부적으로 `final:from-input`을 호출하되, 시중교재 전용 프리셋을 적용한다.
- 기본 프리셋:
  - Mathpix ON
  - Mathpix confidence 하한 0.75
  - strict gate ON
  - solver profile balanced
  - delay 1000ms

## 선택 옵션

- `--fast`: strict gate 대신 빠른 산출
- `--mathpix-strict`: Mathpix 실패 시 문항 실패 처리
- `--mathpix-no-cache`: OCR 캐시 무시
- `--no-mathpix`: Mathpix 비활성화

## 산출물 위치

- 초안: `해설 작업중/<시험명>/`
- 최종 DOCX: `해설지 최종본/`

## 운영 팁

- 모델 과부하(503) 시에는 초안 폴더 유지 후 아래로 DOCX 재생성:
  - `npm run write-final-docx -- --workdir "./해설 작업중/<시험명>"`
- 문제 텍스트가 짧은 문항은 DOCX 단계에서 OCR 발문/선지가 자동 병기된다(키 설정 시).
- 생성 API에 `textbookUnit/textbookType/textbookDifficulty`를 주면, 동일 태그의 참고 md가 자동 선택되어 프롬프트에 주입된다.
