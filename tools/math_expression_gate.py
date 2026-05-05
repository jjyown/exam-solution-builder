import json
import re
import sys
from pathlib import Path


def _safe_expr(expr: str) -> str:
    s = expr.strip()
    s = s.replace("×", "*").replace("÷", "/")
    s = s.replace("^", "**")
    s = re.sub(r"\s+", "", s)
    return s


def _looks_symbolic_or_text(s: str) -> bool:
    # 한글/영문 변수/LaTeX 토큰이 있으면 파이썬 게이트에서 건너뜀(오탐 방지)
    if re.search(r"[A-Za-z가-힣\\_]", s):
        return True
    return False


def _eval_num(expr: str):
    try:
        import sympy as sp

        v = sp.N(sp.sympify(expr))
        if not v.is_real:
            return None
        return float(v)
    except Exception:
        return None


def _check_line(question_no: int, line: str):
    issues = []
    cleaned = line.replace("$", "").strip()
    if not cleaned:
        return issues
    if _looks_symbolic_or_text(cleaned):
        return issues

    # 단순 등식
    if cleaned.count("=") == 1:
        lhs_raw, rhs_raw = cleaned.split("=", 1)
        lhs = _eval_num(_safe_expr(lhs_raw))
        rhs = _eval_num(_safe_expr(rhs_raw))
        if lhs is not None and rhs is not None and abs(lhs - rhs) > 1e-9:
            issues.append(
                {
                    "questionNo": question_no,
                    "severity": "fatal",
                    "code": "E_PY_ARITH_MISMATCH",
                    "message": f"Python 검산 불일치: {cleaned} (계산값 {lhs} != {rhs})",
                }
            )
        return issues

    # 체인 등식
    if cleaned.count("=") >= 2:
        parts = [p.strip() for p in cleaned.split("=") if p.strip()]
        vals = [_eval_num(_safe_expr(p)) for p in parts]
        if all(v is not None for v in vals):
            for i in range(1, len(vals)):
                if abs(vals[i - 1] - vals[i]) > 1e-9:
                    issues.append(
                        {
                            "questionNo": question_no,
                            "severity": "fatal",
                            "code": "E_PY_CHAIN_EQ_MISMATCH",
                            "message": f"Python 체인 등식 불일치: {cleaned} (항 {i}~{i+1} 불일치)",
                        }
                    )
                    break
    return issues


def main():
    try:
        if len(sys.argv) >= 2:
            input_path = Path(sys.argv[1])
            payload = json.loads(input_path.read_text(encoding="utf-8"))
        else:
            raw = sys.stdin.read()
            payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"read_failed: {e}"}, ensure_ascii=False))
        return 1

    try:
        import sympy  # noqa: F401
    except Exception:
        print(json.dumps({"ok": True, "sympyAvailable": False, "issues": []}, ensure_ascii=False))
        return 0

    drafts = payload.get("drafts", [])
    issues = []
    for d in drafts:
        q = int(d.get("questionNo", 0) or 0)
        exp = str(d.get("explanation", "") or "")
        for line in exp.splitlines():
            issues.extend(_check_line(q, line))

    print(json.dumps({"ok": True, "sympyAvailable": True, "issues": issues}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

