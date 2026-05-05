#!/usr/bin/env python3
"""
교재 1페이지 다문항 분할(Mathpix line_data + 바운딩 박스 크롭).

전제(전문가 토의 정리):
- 페이지 단위 OCR만으로는 이미지 1장 ↔ 문항 여러 개 매핑이 깨진다.
- Mathpix v3/text에 include_line_data=true를 주면 line_data[].cnt(픽셀 다각형)와
  줄 단위 text를 얻을 수 있어, 문항 시작 패턴이 있는 줄을 기준으로 구간을 나누고
  구간별 bbox 합집합으로 원본 페이지를 크롭한다.

의존성: pip install pillow (scripts/requirements-textbook-ocr.txt 참고)

환경변수: MATHPIX_APP_ID, MATHPIX_APP_KEY (기존 배치 OCR과 동일)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from PIL import Image
except ImportError as e:
    raise SystemExit(
        "Pillow가 필요합니다. 예: pip install -r scripts/requirements-textbook-ocr.txt"
    ) from e

MATHPIX_ENDPOINT = os.environ.get("MATHPIX_API_URL", "https://api.mathpix.com/v3/text")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
MAX_WORKERS_CAP = 5

# 문항 시작 패턴: "1. ", "22) " 등 (교재·해설지 혼합)
_RE_Q_DOT = re.compile(r"^(\d{1,3})\s*\.\s+\S")
_RE_Q_PAREN = re.compile(r"^(\d{1,3})\s*\)\s*\S")
_RE_Q_DOT_LOOSE = re.compile(r"^(\d{1,3})\s*\.\s*")  # 끝이 수식만 있는 줄
_RE_Q_PAREN_LOOSE = re.compile(r"^(\d{1,3})\s*\)\s*")


def normalize_line_for_marker(raw: str) -> str:
    t = (raw or "").strip()
    t = re.sub(r"^\$+\s*", "", t)
    t = re.sub(r"^\\\(\s*", "", t)
    return t.strip()


def extract_printed_question_number(line_text: str) -> Optional[int]:
    t = normalize_line_for_marker(line_text)
    if not t:
        return None
    m = _RE_Q_DOT.match(t) or _RE_Q_PAREN.match(t)
    if m:
        return int(m.group(1))
    m = _RE_Q_DOT_LOOSE.match(t) or _RE_Q_PAREN_LOOSE.match(t)
    if m:
        return int(m.group(1))
    return None


def cnt_to_bbox(cnt: List[List[float]]) -> Optional[Tuple[int, int, int, int]]:
    if not cnt or len(cnt) < 2:
        return None
    xs = [float(p[0]) for p in cnt]
    ys = [float(p[1]) for p in cnt]
    x0, y0, x1, y1 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def union_bboxes(boxes: List[Tuple[int, int, int, int]]) -> Optional[Tuple[int, int, int, int]]:
    good = [b for b in boxes if b]
    if not good:
        return None
    x0 = min(b[0] for b in good)
    y0 = min(b[1] for b in good)
    x1 = max(b[2] for b in good)
    y1 = max(b[3] for b in good)
    return x0, y0, x1, y1


def line_sort_key(line: Dict[str, Any]) -> Tuple[float, float]:
    cnt = line.get("cnt")
    if not cnt:
        return (1e9, 1e9)
    ys = [float(p[1]) for p in cnt]
    xs = [float(p[0]) for p in cnt]
    return (min(ys), min(xs))


def skipped_line_for_structure(line: Dict[str, Any]) -> bool:
    t = line.get("type") or ""
    if t == "page_info":
        return True
    return False


def align_image_to_mathpix_canvas(pil_img: Image.Image, data: Dict[str, Any]) -> Image.Image:
    """Mathpix line_data 좌표계에 맞추기 위해 자동 회전을 동일하게 적용."""
    iw = data.get("image_width")
    ih = data.get("image_height")
    deg = data.get("auto_rotate_degrees") or 0
    if not isinstance(iw, int) or not isinstance(ih, int):
        return pil_img

    def close_dim(a: int, b: int, tol: int = 3) -> bool:
        return abs(a - b) <= tol

    if deg:
        cand_a = pil_img.rotate(float(deg), expand=True, fillcolor=(255, 255, 255))
        cand_b = pil_img.rotate(-float(deg), expand=True, fillcolor=(255, 255, 255))
        aw, ah = cand_a.size
        bw, bh = cand_b.size
        if close_dim(aw, iw) and close_dim(ah, ih):
            return cand_a
        if close_dim(bw, iw) and close_dim(bh, ih):
            return cand_b
        return cand_a

    w, h = pil_img.size
    if close_dim(w, iw) and close_dim(h, ih):
        return pil_img
    return pil_img


def build_mathpix_payload(image_path: Path) -> bytes:
    raw = image_path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    mime = "image/png"
    ext = image_path.suffix.lower()
    if ext in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    elif ext == ".webp":
        mime = "image/webp"
    elif ext == ".gif":
        mime = "image/gif"
    payload = {
        "src": f"data:{mime};base64,{b64}",
        "rm_spaces": True,
        "math_inline_delimiters": ["$", "$"],
        "math_display_delimiters": ["$$", "$$"],
        "include_line_data": True,
    }
    return json.dumps(payload).encode("utf-8")


def call_mathpix_full(image_path: Path, max_retry: int = 4) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    app_id = os.environ.get("MATHPIX_APP_ID", "").strip()
    app_key = os.environ.get("MATHPIX_APP_KEY", "").strip()
    if not app_id or not app_key:
        return False, "MATHPIX_APP_ID/MATHPIX_APP_KEY 미설정", None

    body = build_mathpix_payload(image_path)
    headers = {
        "Content-Type": "application/json",
        "app_id": app_id,
        "app_key": app_key,
    }
    backoff = 1.2
    for attempt in range(max_retry + 1):
        req = Request(MATHPIX_ENDPOINT, data=body, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=120) as res:
                raw = res.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            if data.get("error") and not (data.get("text") or "").strip():
                return False, str(data.get("error")), None
            return True, "", data
        except HTTPError as e:
            status = e.code
            msg = e.read().decode("utf-8", errors="replace")
            if status == 429 and attempt < max_retry:
                time.sleep(backoff)
                backoff *= 1.8
                continue
            return False, f"HTTP {status}: {msg[:240]}", None
        except URLError as e:
            if attempt < max_retry:
                time.sleep(backoff)
                backoff *= 1.8
                continue
            return False, f"네트워크 오류: {e}", None
        except Exception as e:  # noqa: BLE001
            return False, str(e), None
    return False, "재시도 초과", None


@dataclass
class ProblemSegment:
    printed_number: Optional[int]
    text_lines: List[str] = field(default_factory=list)
    boxes: List[Tuple[int, int, int, int]] = field(default_factory=list)


def build_segments_from_line_data(line_data: List[Dict[str, Any]]) -> List[ProblemSegment]:
    usable: List[Dict[str, Any]] = []
    for line in line_data:
        if skipped_line_for_structure(line):
            continue
        if not line.get("cnt"):
            continue
        usable.append(line)
    usable.sort(key=line_sort_key)

    segments: List[ProblemSegment] = []
    current: Optional[ProblemSegment] = None

    for line in usable:
        txt = (line.get("text") or "").strip()
        qn = extract_printed_question_number(txt) if txt else None
        bbox = cnt_to_bbox(line.get("cnt") or [])

        if qn is not None:
            if current is not None and (current.text_lines or current.boxes):
                segments.append(current)
            current = ProblemSegment(printed_number=qn)

        if current is None:
            current = ProblemSegment(printed_number=None)

        if txt:
            current.text_lines.append(txt)
        if bbox:
            current.boxes.append(bbox)

    if current is not None and (current.text_lines or current.boxes):
        segments.append(current)

    if len(segments) >= 2 and segments[0].printed_number is None:
        head, tail = segments[0], segments[1]
        tail.text_lines = head.text_lines + tail.text_lines
        tail.boxes = head.boxes + tail.boxes
        segments = segments[1:]

    return [s for s in segments if s.text_lines or s.boxes]


def crop_with_padding(
    img: Image.Image,
    bbox: Tuple[int, int, int, int],
    padding_ratio: float,
) -> Image.Image:
    w, h = img.size
    x0, y0, x1, y1 = bbox
    pad_x = int(w * padding_ratio) + 2
    pad_y = int(h * padding_ratio) + 2
    nx0 = max(0, x0 - pad_x)
    ny0 = max(0, y0 - pad_y)
    nx1 = min(w, x1 + pad_x)
    ny1 = min(h, y1 + pad_y)
    return img.crop((nx0, ny0, nx1, ny1))


def write_problem_md(
    path: Path,
    *,
    stem: str,
    problem_index: int,
    printed: Optional[int],
    source_page: str,
    body: str,
    confidence: Optional[float],
    unit: Optional[str],
    type_: Optional[str],
    difficulty: Optional[str],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conf_line = f"{confidence:.6f}" if confidence is not None else "n/a"
    pn = str(printed) if printed is not None else "n/a"
    meta = [
        "---",
        f"sourcePageImage: {source_page}",
        f"problemIndex: {problem_index}",
        f"printedNumber: {pn}",
        f"confidence: {conf_line}",
    ]
    if unit:
        meta.append(f"unit: {unit}")
    if type_:
        meta.append(f"type: {type_}")
    if difficulty:
        meta.append(f"difficulty: {difficulty}")
    meta.extend(["---", "", "## OCR_본문", "", body.rstrip(), ""])
    path.write_text("\n".join(meta), encoding="utf-8")


def process_one_page(
    image_path: Path,
    out_dir: Path,
    *,
    force: bool,
    padding_ratio: float,
    unit: Optional[str],
    type_: Optional[str],
    difficulty: Optional[str],
) -> Tuple[bool, str]:
    stem = image_path.stem
    ok, err, data = call_mathpix_full(image_path)
    if not ok or not data:
        return False, err or "Mathpix 실패"

    line_data = data.get("line_data")
    full_text = (data.get("latex_styled") or data.get("text") or "").strip()
    conf = data.get("confidence")
    conf_f = float(conf) if isinstance(conf, (int, float)) else None

    pil = Image.open(image_path)
    if pil.mode not in ("RGB", "RGBA"):
        pil = pil.convert("RGB")
    work = align_image_to_mathpix_canvas(pil, data)

    segments = build_segments_from_line_data(line_data) if isinstance(line_data, list) else []

    if len(segments) <= 1:
        bbox = union_bboxes([b for s in segments for b in s.boxes]) if segments else None
        if bbox is None and isinstance(line_data, list):
            boxes: List[Tuple[int, int, int, int]] = []
            for line in line_data:
                if skipped_line_for_structure(line):
                    continue
                b = cnt_to_bbox(line.get("cnt") or [])
                if b:
                    boxes.append(b)
            bbox = union_bboxes(boxes)
        body = "\n\n".join(s.text_lines for s in segments) if segments else full_text
        if not body.strip():
            body = full_text
        if not body.strip():
            return False, "OCR 본문이 비어 있습니다."

        idx = 1
        png_path = out_dir / f"{stem}_problem{idx:02d}.png"
        md_path = out_dir / f"{stem}_problem{idx:02d}.md"
        if md_path.exists() and png_path.exists() and not force:
            return True, f"[skip] {stem} (이미 존재)"
        if bbox:
            crop = crop_with_padding(work, bbox, padding_ratio)
        else:
            crop = work
        crop.save(png_path)
        write_problem_md(
            md_path,
            stem=stem,
            problem_index=idx,
            printed=segments[0].printed_number if segments else None,
            source_page=image_path.name,
            body=body,
            confidence=conf_f,
            unit=unit,
            type_=type_,
            difficulty=difficulty,
        )
        return True, f"[ok] {stem} -> 1문항(폴백)"

    for i, seg in enumerate(segments, start=1):
        png_path = out_dir / f"{stem}_problem{i:02d}.png"
        md_path = out_dir / f"{stem}_problem{i:02d}.md"
        if md_path.exists() and png_path.exists() and not force:
            continue
        ubox = union_bboxes(seg.boxes)
        if not ubox:
            return False, f"{stem} 문항 {i}: bbox 없음"
        crop = crop_with_padding(work, ubox, padding_ratio)
        crop.save(png_path)
        body = "\n\n".join(seg.text_lines).strip()
        write_problem_md(
            md_path,
            stem=stem,
            problem_index=i,
            printed=seg.printed_number,
            source_page=image_path.name,
            body=body,
            confidence=conf_f,
            unit=unit,
            type_=type_,
            difficulty=difficulty,
        )
    return True, f"[ok] {stem} -> {len(segments)}문항"


def collect_images(folder: Path) -> List[Path]:
    paths = []
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            paths.append(p)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mathpix line_data로 교재 페이지를 문항별 png+md로 분할"
    )
    parser.add_argument("--input", required=True, type=Path, help="페이지 이미지 폴더")
    parser.add_argument("--output", required=True, type=Path, help="출력 폴더")
    parser.add_argument("--force", action="store_true", help="기존 산출물 덮어쓰기")
    parser.add_argument("--padding", type=float, default=0.02, help="크롭 여백 비율(기본 0.02)")
    parser.add_argument("--max-workers", type=int, default=3, help="페이지 병렬 수(최대 5)")
    parser.add_argument("--unit", default=None, help="frontmatter unit (선택)")
    parser.add_argument("--type", dest="type_", default=None, help="frontmatter type (선택)")
    parser.add_argument("--difficulty", default=None, help="frontmatter difficulty (선택)")
    args = parser.parse_args()

    if not args.input.is_dir():
        print(f"입력 폴더 없음: {args.input}")
        return 1
    args.output.mkdir(parents=True, exist_ok=True)

    images = collect_images(args.input)
    if not images:
        print("이미지 파일이 없습니다.")
        return 1

    workers = max(1, min(int(args.max_workers), MAX_WORKERS_CAP))
    print(f"[시작] 페이지 {len(images)}장, workers={workers}, 출력={args.output}")

    results: List[Tuple[str, bool]] = []
    if workers <= 1:
        for img in images:
            ok, msg = process_one_page(
                img,
                args.output,
                force=args.force,
                padding_ratio=args.padding,
                unit=args.unit,
                type_=args.type_,
                difficulty=args.difficulty,
            )
            results.append((msg, ok))
            print(msg)
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            fmap = {
                ex.submit(
                    process_one_page,
                    img,
                    args.output,
                    force=args.force,
                    padding_ratio=args.padding,
                    unit=args.unit,
                    type_=args.type_,
                    difficulty=args.difficulty,
                ): img
                for img in images
            }
            for fut in as_completed(fmap):
                ok, msg = fut.result()
                results.append((msg, ok))
                print(msg)

    fails = sum(1 for _, ok in results if not ok)
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
