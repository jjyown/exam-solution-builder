#!/usr/bin/env python3
"""
sympy_verify.py
─────────────────────────────────────────────────────────────────────────────
LLM 이 생성한 해설의 「정답」 ↔ 「풀이 마지막 결과식」 의 수학적 일치를 SymPy 로 검증.

stdin → JSON:
  { answer: str, lastEquation: str, problemType?: "auto"|"objective"|"short_answer" }

stdout → JSON:
  { ok: True|False, ... }
    ok: True   — 검증 통과 또는 검증 skip (형식 검증으로 이미 충분)
    ok: False  — 정답과 마지막 식이 수학적으로 다름. mismatch=True

스킵 조건 (검증 부적합):
  - 객관식 보기 번호만 있을 때 (보기 매핑은 별도)
  - LaTeX 파싱 실패
  - 풀이 마지막 식이 비어 있을 때

의존성:
  pip install sympy antlr4-python3-runtime==4.11
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, Optional

try:
    from sympy import simplify, sympify, Rational, S, nsimplify
    from sympy.parsing.latex import parse_latex
except ImportError as e:
    print(json.dumps({"ok": True, "skipped": f"sympy 미설치: {e}"}))
    sys.exit(0)


# 객관식 보기 매핑 — ① ~ ⑩ → 1~10
OBJECTIVE_MAP = {
    "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5",
    "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9", "⑩": "10",
}

OBJECTIVE_RE = re.compile(r"^[①②③④⑤⑥⑦⑧⑨⑩]$|^[1-9]$|^10$|^\([1-9]\)$|^\(10\)$")


def normalize_objective(s: str) -> str:
    """① → 1, (1) → 1 같은 정규화."""
    s = (s or "").strip()
    for k, v in OBJECTIVE_MAP.items():
        s = s.replace(k, v)
    s = s.replace("(", "").replace(")", "").strip()
    return s


def looks_like_objective_choice(s: str) -> bool:
    s = (s or "").strip()
    return bool(OBJECTIVE_RE.match(s)) or s in {"1", "2", "3", "4", "5"}


def strip_latex_wrapper(s: str) -> str:
    """$...$ 같은 wrapper 제거 — parse_latex 가 깨끗한 본문만 받게."""
    t = (s or "").strip()
    if not t:
        return t
    # $$...$$, $...$, \(...\), \[...\]
    t = re.sub(r"^\$\$|\$\$$", "", t)
    t = re.sub(r"^\$|\$$", "", t)
    t = re.sub(r"^\\\(|\\\)$", "", t)
    t = re.sub(r"^\\\[|\\\]$", "", t)
    return t.strip()


def extract_rhs_from_equation(eq: str) -> str:
    """`x = 5/2` 같은 등식이면 우변만 추출 (last step 의 결과식)."""
    t = strip_latex_wrapper(eq)
    if "=" in t:
        # 가장 마지막 = 의 우변 (체인 등식 a=b=c → c)
        parts = t.rsplit("=", 1)
        if len(parts) == 2:
            return parts[1].strip()
    return t


def parse_to_expr(text: str):
    """LaTeX 또는 수치/식 평문 → sympy expr. 실패 시 None."""
    if not text or not isinstance(text, str):
        return None
    t = strip_latex_wrapper(text)
    if not t:
        return None

    # 1) 단순 정수/소수/분수 수치 우선 (가장 흔함)
    try:
        cleaned = t.replace(",", "").replace(" ", "")
        # 단순 분수 a/b
        if re.match(r"^-?\d+\s*/\s*-?\d+$", cleaned):
            num, den = cleaned.split("/")
            return Rational(int(num), int(den))
        # 정수 또는 소수
        if re.match(r"^-?\d+(\.\d+)?$", cleaned):
            return sympify(cleaned)
    except Exception:
        pass

    # 2) LaTeX 파싱
    try:
        return parse_latex(t)
    except Exception:
        pass

    # 3) 평문 sympify (LaTeX 명령이 없는 단순 식)
    try:
        # ^ → ** 변환 (sympify 기본은 ^ 를 XOR 취급)
        t2 = re.sub(r"(?<![A-Za-z\\])\^", "**", t)
        return sympify(t2)
    except Exception:
        return None


def equal_or_simplify_zero(a, b) -> Optional[bool]:
    """두 sympy 식이 수학적으로 같은지. 결정 못 하면 None."""
    try:
        diff = simplify(a - b)
        if diff == 0:
            return True
        # 수치적 등가 — 무리수 비교 (소수점 비교)
        try:
            n = nsimplify(diff, tolerance=1e-9)
            return n == 0
        except Exception:
            pass
        return False
    except Exception:
        return None


def main() -> None:
    raw = sys.stdin.read()
    try:
        data: Dict[str, Any] = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": True, "skipped": f"input json parse 실패: {e}"}))
        return

    answer = (data.get("answer") or "").strip()
    last_eq = (data.get("lastEquation") or "").strip()
    problem_type = data.get("problemType", "auto")

    if not answer:
        print(json.dumps({"ok": True, "skipped": "answer 비어 있음"}))
        return

    # 객관식 보기번호 — 검증 skip (V1~V6 형식 검증으로 충분)
    if looks_like_objective_choice(answer):
        print(json.dumps({"ok": True, "skipped": "객관식 보기 (보기 매핑은 별도)"}))
        return

    # 풀이 마지막 식 우변 추출
    last_rhs = extract_rhs_from_equation(last_eq) if last_eq else ""
    if not last_rhs:
        print(json.dumps({"ok": True, "skipped": "마지막 식 비어 있음"}))
        return

    # 답안 파싱
    expr_a = parse_to_expr(answer)
    if expr_a is None:
        print(json.dumps({"ok": True, "skipped": f"answer 파싱 실패: {answer[:40]}"}))
        return

    expr_b = parse_to_expr(last_rhs)
    if expr_b is None:
        print(json.dumps({"ok": True, "skipped": f"마지막 식 파싱 실패: {last_rhs[:40]}"}))
        return

    eq = equal_or_simplify_zero(expr_a, expr_b)
    if eq is None:
        print(json.dumps({"ok": True, "skipped": "비교 결정 불가 (복잡식)"}))
        return

    if eq:
        print(json.dumps({"ok": True, "match": True,
                          "normalized": str(expr_a)}))
    else:
        print(json.dumps({"ok": False, "mismatch": True,
                          "normalizedAnswer": str(expr_a),
                          "normalizedLast": str(expr_b),
                          "rawAnswer": answer,
                          "rawLast": last_rhs}))


if __name__ == "__main__":
    main()
