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
