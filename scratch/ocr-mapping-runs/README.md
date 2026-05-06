# OCR·Multi-Mapping 실험 산출물 (로컬)

이 폴더는 **교재 참고자료 정식 출력이 아니라**, Mathpix 분할·튜닝 검증용으로 쌓인 `tmp_*` 작업물을 한곳에 모은 것입니다.

## 정식 산출 위치

- `npm run textbook:build-reference -- --input "..." --output "./교재 참고자료"`
- 결과 트리: `<출력 루트>/<단원>/<유형>/<난이도>/*.{md,png}`

입력 폴더는 가능하면 **`단원/유형/난이도/파일`** 깊이(3단)를 맞추면 메타가 정확히 붙습니다. PDF만 `단원/파일.pdf` 두 단이면 `난이도`는 `미분류난이도`이고, 유형 폴더명은 **파일 stem**(확장자 제외)을 씁니다.

## 이 디렉터리에 있는 것 (예시)

| 폴더 | 용도 |
|------|------|
| `tmp_split_v3_force` | 3차(타 문항 `[정답]` 분리) 적용 후 `--force` 재생성 샘플 |
| `tmp_split_output_tuned*` | 과분할 억제 튜닝 중간 산출 |
| `tmp_split_output` | 초기 Multi-Mapping 검증 산출 |
| `tmp_input_permutation_only` | 순열 PDF 단독 입력 스모크 |

불필요해지면 폴더 단위로 삭제해도 됩니다. 정식 파이프라인에는 영향 없습니다.

## 품질 감사

```bash
python tools/audit_textbook_split_md.py ./scratch/ocr-mapping-runs/tmp_split_v3_force --strict --max-answer-headers 5
```
