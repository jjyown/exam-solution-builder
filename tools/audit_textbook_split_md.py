#!/usr/bin/env python3
"""교재 분할 산출 md 감사: frontmatter printedNumber와 본문 N) [정답] 헤더 불일치 검출."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

_RE_ANS_PAREN = re.compile(r"^(\d{1,3})\s*\)\s*(?:\[정답\]|정답\])")
_RE_ANS_DOT = re.compile(r"^(\d{1,3})\s*\.\s+(?:\[정답\]|정답\])")


def strip_frontmatter(body: str) -> tuple[str, dict[str, str]]:
    if not body.startswith("---"):
        return body, {}
    parts = body.split("---", 2)
    if len(parts) < 3:
        return body, {}
    fm_raw, rest = parts[1], parts[2]
    d: dict[str, str] = {}
    for line in fm_raw.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            d[k.strip()] = v.strip()
    return rest, d


def normalize_line_start(raw: str) -> str:
    t = (raw or "").strip()
    t = re.sub(r"^\$+\s*", "", t)
    t = re.sub(r"^\\\(\s*", "", t)
    return t.strip()


def answer_header_numbers(body: str) -> list[int]:
    out: list[int] = []
    for line in body.splitlines():
        t = normalize_line_start(line)
        m = _RE_ANS_PAREN.match(t) or _RE_ANS_DOT.match(t)
        if m:
            out.append(int(m.group(1)))
    return out


def foreign_answer_lines(body: str, owner: int) -> list[tuple[int, str]]:
    bad: list[tuple[int, str]] = []
    for line in body.splitlines():
        t = normalize_line_start(line)
        m = _RE_ANS_PAREN.match(t) or _RE_ANS_DOT.match(t)
        if m:
            n = int(m.group(1))
            if n != owner:
                bad.append((n, line.strip()[:160]))
    return bad


def strict_owner_foreign_mix(body: str, owner: int) -> list[tuple[int, str]]:
    """
    3차 분할 대상에 가깝게: 본문에 owner 번호의 [정답] 헤더가 있으면서
    다른 번호의 [정답] 헤더도 함께 있는 경우.
    (빠른정답 전용 페이지처럼 owner만 있고 나머지는 연속 나열인 경우와 구분)
    """
    nums = answer_header_numbers(body)
    if owner not in nums:
        return []
    return foreign_answer_lines(body, owner)


def audit_dir(
    root: Path,
    *,
    strict: bool,
    max_answer_headers: int | None,
) -> tuple[int, int, int, list[tuple[str, list[tuple[int, str]]]]]:
    violations: list[tuple[str, list[tuple[int, str]]]] = []
    checked = 0
    skipped = 0
    for md in sorted(root.rglob("*_problem*.md")):
        checked += 1
        text = md.read_text(encoding="utf-8", errors="replace")
        body, fm = strip_frontmatter(text)
        pn = fm.get("printedNumber", "")
        if not pn.isdigit():
            skipped += 1
            continue
        owner = int(pn)
        if strict:
            nums = answer_header_numbers(body)
            if max_answer_headers is not None and len(nums) > max_answer_headers:
                continue
            bad = strict_owner_foreign_mix(body, owner)
        else:
            bad = foreign_answer_lines(body, owner)
        if bad:
            violations.append((str(md.relative_to(root)), bad))
    return checked, skipped, len(violations), violations


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", type=Path, help="산출 루트(예: scratch/ocr-mapping-runs/tmp_split_v3_force)")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="소유 번호와 동일한 [정답] 헤더가 있는 파일만(타 번호 혼입 = 3차 대상에 근접)",
    )
    ap.add_argument(
        "--max-answer-headers",
        type=int,
        default=None,
        metavar="N",
        help="--strict 와 함께: 본문 [정답] 헤더 개수가 N 이하인 파일만 집계(빠른정답 목록 페이지 제외)",
    )
    ap.add_argument("--max-print", type=int, default=30, help="위반 샘플 최대 출력")
    args = ap.parse_args()
    root: Path = args.root
    if not root.is_dir():
        raise SystemExit(f"폴더 없음: {root}")

    checked, skipped, vcount, violations = audit_dir(
        root, strict=args.strict, max_answer_headers=args.max_answer_headers
    )
    print(f"root: {root.resolve()}")
    print(f"md_files: {checked}, skipped(no printedNumber): {skipped}")
    mode = "strict_owner_foreign_mix" if args.strict else "any_foreign_vs_printedNumber"
    if args.strict and args.max_answer_headers is not None:
        mode += f"_maxHeaders<={args.max_answer_headers}"
    print(f"{mode}: {vcount}")
    for rel, bad in violations[: args.max_print]:
        print(f"  {rel}")
        for n, line in bad:
            print(f"    headerN={n} {line!r}")
    if vcount > args.max_print:
        print(f"  ... 외 {vcount - args.max_print}건")


if __name__ == "__main__":
    main()
