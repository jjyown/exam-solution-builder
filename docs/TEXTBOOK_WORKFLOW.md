# 시중교재 해설 워크플로우

## 목적

- 시중교재 입력을 시험지 일반 입력과 분리해, OCR/가독성 보정 정책을 안정적으로 적용한다.

## 실행 커맨드

```bash
npm run final:from-textbook -- --input "./크롭된 시험지" --exam-name "[교재] 2026 6평"
```

## 0) 교재 참고자료(단원/유형/난이도) 구축

- 입력 폴더 구조를 아래처럼 맞추면 자동으로 메타가 붙는다.
  - `<입력루트>/<단원>/<유형>/<난이도>/*.png|jpg|pdf`
- **경로가 2단뿐일 때**(예: `<단원>/<파일명>.pdf`): 유형 폴더는 **파일명에서 확장자를 뺀 stem**으로 만들어지고, 난이도는 `미분류난이도`가 된다. (예: `확률과 통계/1. 여러가지 순열.pdf` → 출력 `…/확률과 통계/1. 여러가지 순열/미분류난이도/`)
- **실험·튜닝 산출물**은 레포 루트에 흩뿌리지 말고 `scratch/ocr-mapping-runs/` 아래에 둔다(용도는 해당 README 참고).
- Mathpix OCR로 참고 md를 생성:

```bash
npm run textbook:build-reference -- --input "./교재 입력" --output "./교재 참고자료"
```

- 원본 PDF가 **`참고용 문제/`** 아래에만 있을 때도 동일하게 `--input`에 그 폴더(또는 그 아래 단원 폴더)를 지정하면 된다.

- 생성 산출: `./교재 참고자료/<단원>/<유형>/<난이도>/*.md`
- 입력이 PDF이면: 페이지를 Mathpix `line_data`로 문항 구간 분할한 뒤, `*_problemNN.png`+`*_problemNN.md`로 생성된다.
- 각 md에는 frontmatter(`unit/type/difficulty`) + OCR 본문이 저장된다.
- 기본 동작: 같은 경로의 md가 이미 있으면 **스킵**
- 강제 재OCR: `--force`

```bash
npm run textbook:build-reference -- --input "./교재 입력" --output "./교재 참고자료" --force
```

## 0-1) 한 페이지에 문제가 여러 개: Mathpix bbox로 문항 분할(실전형 Multi-Mapping)

- **문제**: `1페이지 = 이미지 1장`인데 문항은 3~4개면, 파일명 번호만으로 이미지↔md 1:1 매핑이 깨진다.
- **해결**: Mathpix `include_line_data`로 줄 단위 `cnt`(바운딩 박스)를 받아, 문항 시작 패턴(`1.`, `22)` 등)마다 구간을 나누고 **구간별 bbox 합집합**으로 페이지 이미지를 크롭한다.
- **의존성**: `pip install pillow` (Pillow)
- **실행 예**:

```bash
npm run textbook:split-pages -- --input "./페이지이미지폴더" --output "./문항별산출"
```

- (참고) `textbook:build-reference`는 PDF에서 이 분할을 자동 적용하므로, `split-pages`는 이미 페이지 PNG로 렌더되어 있는 경우에만 유용하다.

- **옵션**: `--force`(덮어쓰기), `--padding 0.02`(크롭 여백 비율), `--max-workers 3`(페이지 병렬, 최대 5), `--unit` / `--type` / `--difficulty`(md frontmatter 보강)
- **3차(기본 ON)**: 한 세그먼트 안에 소유 번호와 다른 `N) [정답]` / `N. [정답]` 줄이 있으면 그 줄에서 잘라 별도 세그먼트로 만든다(줄–bbox 정렬은 `LinePiece`로 보존). 끄려면 `--no-foreign-answer-split`.
- **2차(기본 ON)**: 해설이 있는 페이지에서만 해설·정답+해설 세그먼트를 남기고 빠른정답 전용 페이지는 비운다. 끄려면 `--no-explanation-priority`.
- **산출**: `{페이지파일명_stem}_problem01.png` + 동명 `.md` … (한 페이지에서 검출된 문항 수만큼)
- **한계(전문가 메모)**: 문항 번호가 OCR에서 누락되거나 줄 단위 bbox가 비면 **1문항 폴백**(전체 페이지 1세트)으로 떨어질 수 있다. 이 경우 원본 스캔 품질·레이아웃(단락)을 점검하거나 `--force`로 재시도한다.

- **산출 md 품질 감사(재실행 전후 비교)**: `tools/audit_textbook_split_md.py`로 `printedNumber`와 본문 `N) [정답]` / `N. [정답]` 불일치를 집계할 수 있다. 예: `python tools/audit_textbook_split_md.py ./scratch/ocr-mapping-runs/tmp_split_v3_force --strict --max-answer-headers 5` (`--strict`는 소유 번호와 같은 [정답] 헤더가 있는 파일만 대상으로, 타 번호 혼입을 좁혀 본다.)
- **폴더 트리 감사(정리 상태 점검)**: `npm run textbook:audit-tree` 또는 `python tools/audit_textbook_reference_tree.py "./교재 참고자료"` — 정식 깊이(`단원/유형/난이도/파일`) 대비 얕은·깊은 경로, 유형 폴더명이 `.pdf`로 끝나는 구버전 레이아웃, `미분류*` 이름 사용 빈도를 집계한다(파일 이동 없음). `--json`으로 기계 판독 출력.
- **구버전 경로 정규화**: 과거 빌드에서 유형 폴더가 `1. 함수.pdf`처럼 보이거나 frontmatter `type`에 `.pdf`가 붙어 있으면 `python tools/normalize_textbook_reference_layout.py "./교재 참고자료"`(dry-run) 후 `... --apply`로 유형 디렉터리를 stem으로 바꾸고 md의 `type`·`sourceImage`를 맞춘다. npm: `npm run textbook:normalize-ref -- ./교재 참고자료 --apply`.

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
