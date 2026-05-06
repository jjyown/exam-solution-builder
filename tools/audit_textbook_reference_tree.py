#!/usr/bin/env python3
"""
교재 참고자료(또는 지정 루트) 폴더 트리 감사.

전문가 운영 관점:
- 정식 규칙: <루트>/<단원>/<유형>/<난이도>/*.{md,png,...} (디렉터리 깊이 3 + 파일)
- 구버전: 유형 폴더명에 `.pdf`가 붙은 레이아웃(파일명이 경로에 그대로 들어가던 시기)
- 얕은 경로: 단원만 있거나 유형만 있고 난이도가 없으면 태그·선택기 정합이 흔들릴 수 있음

이 스크립트는 파일을 이동하지 않고 집계·표본 경로만 출력한다.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

# 참고 md·분할 산출에 흔한 확장자
_REF_EXT = {".md", ".png", ".jpg", ".jpeg", ".webp", ".gif"}

_SKIP_DIR_NAMES = {"_tmp_pdf_pages", ".git", "node_modules", ".cache"}


def should_skip_dir(name: str) -> bool:
    if name in _SKIP_DIR_NAMES or name.startswith("."):
        return True
    return False


def audit(root: Path) -> dict:
    root = root.resolve()
    if not root.is_dir():
        return {"error": f"not a directory: {root}"}

    rel_files: list[tuple[Path, list[str]]] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in _REF_EXT:
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        parts = [x for x in rel.parts if x]
        if any(should_skip_dir(x) or x == "_tmp_pdf_pages" for x in parts[:-1]):
            continue
        rel_files.append((rel, parts))

    dir_depths: Counter[int] = Counter()
    legacy_pdf_dir: list[str] = []
    shallow: list[str] = []
    deep: list[str] = []
    has_mis: Counter[str] = Counter()
    by_ext: Counter[str] = Counter()
    triples: Counter[tuple[str, str, str]] = Counter()

    for rel, parts in rel_files:
        by_ext[Path(parts[-1]).suffix.lower()] += 1
        dirs = parts[:-1]
        dlen = len(dirs)
        dir_depths[dlen] += 1

        if any(name.endswith(".pdf") for name in dirs):
            legacy_pdf_dir.append(rel.as_posix())

        if dlen < 3:
            shallow.append(rel.as_posix())
        elif dlen > 3:
            deep.append(rel.as_posix())
        else:
            u, t, diff = dirs[0], dirs[1], dirs[2]
            triples[(u, t, diff)] += 1
            for token, label in (
                (u, "unit"),
                (t, "type"),
                (diff, "difficulty"),
            ):
                if token.startswith("미분류"):
                    has_mis[f"{label}:{token}"] += 1

    def sample(xs: list[str], n: int = 12) -> list[str]:
        return xs[:n]

    return {
        "root": str(root),
        "file_counts_by_ext": dict(by_ext),
        "file_count_total": sum(by_ext.values()),
        "dir_depth_histogram": {str(k): v for k, v in sorted(dir_depths.items())},
        "unique_unit_type_difficulty_buckets": len(triples),
        "legacy_type_folder_name_endswith_pdf": {
            "count": len(legacy_pdf_dir),
            "sample": sample(legacy_pdf_dir),
        },
        "shallow_paths_less_than_3_dirs": {
            "count": len(shallow),
            "sample": sample(shallow),
        },
        "deep_paths_more_than_3_dirs": {
            "count": len(deep),
            "sample": sample(deep),
        },
        "misclassified_name_flags_in_canonical_depth": dict(has_mis),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="교재 참고자료 폴더 트리 감사(이동 없음)")
    ap.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path("교재 참고자료"),
        help="감사 루트(기본: ./교재 참고자료)",
    )
    ap.add_argument("--json", action="store_true", help="JSON만 stdout")
    args = ap.parse_args()
    data = audit(args.root)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    if "error" in data:
        print(data["error"])
        raise SystemExit(1)
    print(f"루트: {data['root']}")
    print(f"대상 파일 수: {data['file_count_total']} (확장자: {data['file_counts_by_ext']})")
    print(f"디렉터리 깊이(파일 기준 상위 폴더 개수) 분포: {data['dir_depth_histogram']}")
    print(f"(단원,유형,난이도) 조합 수(깊이 정확히 3인 파일만): {data['unique_unit_type_difficulty_buckets']}")
    leg = data["legacy_type_folder_name_endswith_pdf"]
    print(f"구버전 의심(경로 중 폴더명이 .pdf로 끝남): {leg['count']}건")
    for s in leg["sample"]:
        print(f"  - {s}")
    sh = data["shallow_paths_less_than_3_dirs"]
    print(f"얕은 경로(<3단 폴더): {sh['count']}건")
    for s in sh["sample"]:
        print(f"  - {s}")
    dp = data["deep_paths_more_than_3_dirs"]
    print(f"깊은 경로(>3단 폴더): {dp['count']}건")
    for s in dp["sample"]:
        print(f"  - {s}")
    mis = data["misclassified_name_flags_in_canonical_depth"]
    if mis:
        print("깊이 3 충족 파일 중 '미분류*' 이름 포함 집계:")
        for k, v in sorted(mis.items(), key=lambda x: -x[1]):
            print(f"  {k}: {v}")
    else:
        print("깊이 3 충족 파일 중 '미분류*' 접두: (없음)")


if __name__ == "__main__":
    main()
