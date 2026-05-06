#!/usr/bin/env python3
"""
교재 참고자료: 구버전 레이아웃(유형 폴더·frontmatter type이 `*.pdf`)을 stem 기준으로 정리.

전문가 운영 메모:
- `textbookReferenceSelector`는 주로 frontmatter `unit`/`type`/`difficulty`로 매칭하므로,
  `type: 9. 통계.pdf`처럼 `.pdf`가 붙으면 API에서 넘긴 유형 태그와 정확 일치가 깨지기 쉽다.
- 기본은 **dry-run**(변경 없음). 실제 반영은 `--apply`.

처리 순서:
1) 모든 `.md` frontmatter에서 `type:`·`sourceImage:`의 `.pdf` 접미 제거(경로형)
2) `<단원>/<이름.pdf>/` 디렉터리를 `<단원>/<이름>/` 로 rename (대상이 이미 있으면 스킵·경고)
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

_SKIP = {"_tmp_pdf_pages", ".git", "node_modules"}


def repair_concatenated_fm_close(md: str) -> str:
    """구버전 스크립트가 `sourceImage: ...#page=N---` 처럼 닫는 ---를 붙여 쓴 경우 복구."""
    return re.sub(r"(#page=\d+)---", r"\1\n---", md)


def patch_frontmatter(md: str) -> tuple[str, bool]:
    """Return (new_text, changed)."""
    if not md.startswith("---"):
        return md, False
    parts = md.split("---", 2)
    if len(parts) < 3:
        return md, False
    fm, body = parts[1], parts[2]
    changed = False
    new_lines: list[str] = []
    for line in fm.splitlines():
        raw = line
        if re.match(r"^type:\s*", line, re.I):
            val = line.split(":", 1)[1].strip()
            if val.lower().endswith(".pdf"):
                stem = Path(val).stem
                line = f"type: {stem}"
                if line != raw:
                    changed = True
        elif re.match(r"^sourceImage:\s*", line, re.I):
            val = line.split(":", 1)[1].strip()
            new_val = re.sub(r"([^/\\]+)\.pdf(?=#|/|$)", r"\1", val)
            if new_val != val:
                line = f"sourceImage: {new_val}"
                changed = True
        new_lines.append(line)
    if not changed:
        return md, False
    new_fm = "\n".join(new_lines)
    # 원본과 동일하게 개행을 유지해 `---` 구분자가 본문과 붙지 않게 한다.
    return f"---\n{new_fm}\n---\n{body}", True


def collect_pdf_named_dirs(root: Path) -> list[Path]:
    out: list[Path] = []
    for p in root.rglob("*"):
        if not p.is_dir():
            continue
        if p.name.endswith(".pdf") and not p.name.startswith("."):
            if any(x in _SKIP or x.startswith(".") for x in p.parts):
                continue
            out.append(p)
    # 깊은 경로부터 처리(이 스키마에서는 보통 동일 깊이지만 안전)
    return sorted(out, key=lambda x: len(x.parts), reverse=True)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="교재 참고자료 .pdf 유형 폴더명·frontmatter 정규화(dry-run 기본)"
    )
    ap.add_argument("root", nargs="?", type=Path, default=Path("교재 참고자료"))
    ap.add_argument("--apply", action="store_true", help="실제 쓰기·rename 수행")
    args = ap.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit(f"디렉터리 없음: {root}")

    md_files = [p for p in root.rglob("*.md") if p.is_file()]
    md_changed = 0
    for p in md_files:
        if any(x in _SKIP for x in p.parts):
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        repaired = repair_concatenated_fm_close(text)
        new_text, _ = patch_frontmatter(repaired)
        if new_text != text:
            md_changed += 1
            if args.apply:
                p.write_text(new_text, encoding="utf-8")

    pdf_dirs = collect_pdf_named_dirs(root)
    rename_ok = 0
    rename_skip = 0
    for d in pdf_dirs:
        parent = d.parent
        stem = Path(d.name).stem
        target = parent / stem
        if target.exists():
            rename_skip += 1
            print(f"[skip] 이미 존재: {target}")
            continue
        print(f"{'[apply] ' if args.apply else '[dry-run] '}rename: {d} -> {target}")
        if args.apply:
            d.rename(target)
        rename_ok += 1

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"\n[{mode}] md frontmatter 수정 대상: {md_changed} / {len(md_files)}")
    print(f"[{mode}] 유형 폴더 rename 예정/완료: {rename_ok}, 충돌 스킵: {rename_skip}")


if __name__ == "__main__":
    main()
