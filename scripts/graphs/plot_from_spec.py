#!/usr/bin/env python3
"""
해설용 matplotlib 그래프 렌더러 (JSON 명세 → 고해상도 PNG)
의존성: pip install -r scripts/graphs/requirements.txt

보안: expr_python 은 np·x·아래 safe 이름만 eval 합니다. 임의 파일·import 금지.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True, help="graph_spec.json 경로")
    p.add_argument("--out", required=True, help="출력 PNG 경로")
    p.add_argument("--dpi", type=int, default=200)
    args = p.parse_args()

    spec_path = Path(args.spec)
    out_path = Path(args.out)
    raw = spec_path.read_text(encoding="utf-8")
    spec = json.loads(raw)

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as e:
        print("matplotlib 이 필요합니다: pip install -r scripts/graphs/requirements.txt", file=sys.stderr)
        raise SystemExit(1) from e

    # Word 에서도 잘 보이도록 선 두께·글꼴
    plt.rcParams["lines.linewidth"] = float(spec.get("line_width_pt", 2))
    plt.rcParams["axes.linewidth"] = 1.0
    plt.rcParams["figure.dpi"] = args.dpi
    plt.rcParams["font.size"] = 11

    font_candidates = spec.get("font_family") or ["Malgun Gothic", "AppleGothic", "NanumGothic", "DejaVu Sans"]
    plt.rcParams["font.family"] = font_candidates

    xlim = spec.get("xlim") or [-6, 6]
    ylim = spec.get("ylim") or [-4, 4]
    fig, ax = plt.subplots(figsize=(6.4, 4.2))
    ax.set_xlim(float(xlim[0]), float(xlim[1]))
    ax.set_ylim(float(ylim[0]), float(ylim[1]))
    ax.axhline(0, color="#888", linewidth=0.8)
    ax.axvline(0, color="#888", linewidth=0.8)
    ax.grid(True, linestyle="--", alpha=0.35)
    ax.set_xlabel(spec.get("xlabel") or "$x$")
    ax.set_ylabel(spec.get("ylabel") or "$y$")
    title = spec.get("title")
    if title:
        ax.set_title(title)

    safe_eval_globals = {
        "__builtins__": {},
        "np": np,
        "sin": np.sin,
        "cos": np.cos,
        "tan": np.tan,
        "pi": np.pi,
        "exp": np.exp,
        "sqrt": np.sqrt,
        "abs": np.abs,
    }

    curves = spec.get("curves") or []
    for i, c in enumerate(curves):
        expr = (c.get("expr_python") or "").strip()
        if not expr:
            continue
        n = int(c.get("samples") or 800)
        x0, x1 = float(xlim[0]), float(xlim[1])
        xs = np.linspace(x0, x1, max(50, n))
        g = dict(safe_eval_globals)
        g["x"] = xs
        try:
            ys = eval(expr, g, {})
        except Exception as ex:
            print(f"expr_python 평가 실패 ({expr}): {ex}", file=sys.stderr)
            raise SystemExit(2) from ex
        ys = np.asarray(ys, dtype=float)
        if ys.shape != xs.shape:
            print("expr_python 결과가 x 와 같은 길이의 배열이어야 합니다.", file=sys.stderr)
            raise SystemExit(3)
        label = c.get("label") or f"curve_{i + 1}"
        color = c.get("color") or f"C{i % 10}"
        ax.plot(xs, ys, label=label, color=color)

    for pt in spec.get("points") or []:
        px, py = float(pt["x"]), float(pt["y"])
        sz = float(pt.get("size") or 40)
        open_marker = bool(pt.get("marker_open"))
        ec = pt.get("edgecolor") or "k"
        fc = "none" if open_marker else (pt.get("color") or "C3")
        ax.scatter(
            [px],
            [py],
            zorder=5,
            s=sz,
            facecolors=fc,
            edgecolors=ec,
            linewidths=2.0 if open_marker else 0.8,
        )
        lb = pt.get("label")
        if lb:
            ax.annotate(lb, (px, py), textcoords="offset points", xytext=(4, 4))

    for vl in spec.get("vlines") or []:
        x = float(vl["x"])
        if vl.get("ymin") is not None and vl.get("ymax") is not None:
            ax.vlines(
                x,
                float(vl["ymin"]),
                float(vl["ymax"]),
                color=vl.get("color") or "#666",
                linestyle=vl.get("linestyle") or "--",
                linewidth=float(vl.get("linewidth") or 1.2),
                alpha=float(vl.get("alpha") or 0.85),
            )
        else:
            ax.axvline(x, color=vl.get("color") or "#666", linestyle=vl.get("linestyle") or "--", alpha=0.8)
    for hl in spec.get("hlines") or []:
        y = float(hl["y"])
        if hl.get("xmin") is not None and hl.get("xmax") is not None:
            ax.hlines(
                y,
                float(hl["xmin"]),
                float(hl["xmax"]),
                color=hl.get("color") or "#666",
                linestyle=hl.get("linestyle") or "-",
                linewidth=float(hl.get("linewidth") or 1.8),
                alpha=float(hl.get("alpha") or 0.9),
            )
        else:
            ax.axhline(y, color=hl.get("color") or "#666", linestyle=hl.get("linestyle") or "--", alpha=0.8)

    if curves and any(c.get("label") for c in curves):
        ax.legend(loc="best", fontsize=9)
    fig.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(out_path), dpi=args.dpi, bbox_inches="tight")
    plt.close(fig)
    print(f"saved: {out_path}")


if __name__ == "__main__":
    main()
