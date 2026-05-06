#!/usr/bin/env python3
"""
교재 1페이지 다문항 분할(Mathpix line_data + 바운딩 박스 크롭).

전제(전문가 토의 정리):
- 페이지 단위 OCR만으로는 이미지 1장 ↔ 문항 여러 개 매핑이 깨진다.
- Mathpix v3/text에 include_line_data=true를 주면 line_data[].cnt(픽셀 다각형)와
  줄 단위 text를 얻을 수 있어, 문항 시작 패턴이 있는 줄을 기준으로 구간을 나누고
  구간별 bbox 합집합으로 원본 페이지를 크롭한다.

2차: 해설 우선 필터 — quick_answer/unknown-only 페이지는 매핑 제외, 해설 세그먼트만 유지.

3차(번호 혼입 완화): 세그먼트 내부에 "소유 번호 ≠ N"인 `N) [정답]` / `N. [정답]` 줄이 있으면
  해당 줄에서 논리 분할하여 크롭 bbox가 섞이지 않도록 한다. (--no-foreign-answer-split 으로 끌 수 있음)

5차(OCR 중복 블록): 동일 소유 번호에 대해 본문이 사실상 동일한 세그먼트가 비인접으로 남는 경우
  union-find로 묶어 한 세그먼트로 병합한다(줄·bbox는 세로 순으로 재정렬).
  병합 시 동일 텍스트의 line piece가 연속으로 남으면 bbox 합집합으로 1개로 합쳐 본문 이중 기재를 막는다.

의존성: pip install pillow

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
        "Pillow가 필요합니다. 예: pip install pillow"
    ) from e

MATHPIX_ENDPOINT = os.environ.get("MATHPIX_API_URL", "https://api.mathpix.com/v3/text")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
MAX_WORKERS_CAP = 5

# 문항 시작 패턴: "1. ", "22) " 등 (교재·해설지 혼합)
_RE_Q_DOT = re.compile(r"^(\d{1,3})\s*\.\s+\S")
_RE_Q_PAREN = re.compile(r"^(\d{1,3})\s*\)\s*\S")
_RE_Q_DOT_LOOSE = re.compile(r"^(\d{1,3})\s*\.\s*")  # 끝이 수식만 있는 줄
_RE_Q_PAREN_LOOSE = re.compile(r"^(\d{1,3})\s*\)\s*")

# 3차: 정답 전용 헤더(타 문항 혼입 분리) — 보수적으로 [정답] 태그가 있는 줄만
_RE_ANS_HDR_PAREN = re.compile(r"^(\d{1,3})\s*\)\s*(?:\[정답\]|정답\])")
_RE_ANS_HDR_DOT = re.compile(r"^(\d{1,3})\s*\.\s+(?:\[정답\]|정답\])")
_RE_DATE = re.compile(r"\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b")


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


def answer_header_number(line_text: str) -> Optional[int]:
    """`7) [정답]` / `7. [정답]` 형태만 인정 (해설 본문 속 숫자 오탐 최소화)."""
    t = normalize_line_for_marker(line_text)
    if not t:
        return None
    m = _RE_ANS_HDR_PAREN.match(t) or _RE_ANS_HDR_DOT.match(t)
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


def bbox_iou(a: Tuple[int, int, int, int], b: Tuple[int, int, int, int]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(1, (ax1 - ax0) * (ay1 - ay0))
    area_b = max(1, (bx1 - bx0) * (by1 - by0))
    return inter / float(area_a + area_b - inter)


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
class LinePiece:
    """Mathpix line_data 한 줄에 대응. text/bbox 정렬 보존."""

    text: str = ""
    bbox: Optional[Tuple[int, int, int, int]] = None


@dataclass
class ProblemSegment:
    printed_number: Optional[int]
    pieces: List[LinePiece] = field(default_factory=list)


def segment_join_body(seg: ProblemSegment) -> str:
    return "\n\n".join((p.text for p in seg.pieces if (p.text or "").strip())).strip()


def segment_text_char_count(seg: ProblemSegment) -> int:
    return sum(len(p.text.strip()) for p in seg.pieces if p.text and p.text.strip())


def segment_effective_owner(seg: ProblemSegment) -> Optional[int]:
    if seg.printed_number is not None:
        return seg.printed_number
    for p in seg.pieces:
        if p.text.strip():
            ah = answer_header_number(p.text)
            if ah is not None:
                return ah
            q = extract_printed_question_number(p.text)
            if q is not None:
                return q
    return None


def split_segment_on_foreign_answer_headers(seg: ProblemSegment) -> List[ProblemSegment]:
    """
    세그먼트 소유 번호와 다른 `N) [정답]` / `N. [정답]`이 나오면 해당 줄에서 분할.
    """
    if len(seg.pieces) < 2:
        return [seg]
    owner = segment_effective_owner(seg)
    chunks: List[List[LinePiece]] = []
    current: List[LinePiece] = []
    current_owner = owner

    for p in seg.pieces:
        if current_owner is None and current:
            q = extract_printed_question_number(p.text)
            if q is not None:
                current_owner = q
        fa = answer_header_number(p.text)
        if current_owner is None and fa is not None and not current:
            current_owner = fa
        if (
            fa is not None
            and current_owner is not None
            and fa != current_owner
            and current
        ):
            chunks.append(current)
            current = []
            current_owner = fa
        current.append(p)

    if current:
        chunks.append(current)
    if len(chunks) <= 1:
        return [seg]

    out: List[ProblemSegment] = []
    for ch in chunks:
        pn: Optional[int] = None
        for p in ch:
            ah = answer_header_number(p.text)
            if ah is not None:
                pn = ah
                break
            q = extract_printed_question_number(p.text)
            if q is not None:
                pn = q
                break
        out.append(
            ProblemSegment(
                printed_number=pn if pn is not None else seg.printed_number,
                pieces=ch,
            )
        )
    return out


def split_all_segments_on_foreign_answer_headers(
    segments: List[ProblemSegment],
) -> List[ProblemSegment]:
    flat: List[ProblemSegment] = []
    for s in segments:
        flat.extend(split_segment_on_foreign_answer_headers(s))
    return flat


def merge_adjacent_same_owner_segments(segments: List[ProblemSegment]) -> List[ProblemSegment]:
    """인접 세그먼트의 실효 소유 번호가 같으면 병합해 중복 분할을 줄인다."""
    if len(segments) <= 1:
        return segments
    out: List[ProblemSegment] = []
    for seg in segments:
        if not out:
            out.append(seg)
            continue
        prev = out[-1]
        p_owner = segment_effective_owner(prev)
        c_owner = segment_effective_owner(seg)
        pbox = union_bboxes([p.bbox for p in prev.pieces if p.bbox])
        cbox = union_bboxes([p.bbox for p in seg.pieces if p.bbox])
        high_overlap = (
            pbox is not None
            and cbox is not None
            and bbox_iou(pbox, cbox) >= 0.75
        )
        if p_owner is not None and c_owner is not None and p_owner == c_owner and high_overlap:
            prev.pieces.extend(seg.pieces)
            prev.printed_number = p_owner
            continue
        out.append(seg)
    return out


def normalize_body_for_dedupe(seg: ProblemSegment) -> str:
    """제로폭 공백·유니코드 공백 제거 후 공백 축약."""
    t = segment_join_body(seg).strip()
    t = re.sub(r"[\u200b\uFEFF\u00a0]+", "", t)
    t = re.sub(r"\s+", " ", t)
    return t


def token_jaccard(a: str, b: str) -> float:
    toks_a = set(re.findall(r"[\w가-힣]+", a, flags=re.UNICODE))
    toks_b = set(re.findall(r"[\w가-힣]+", b, flags=re.UNICODE))
    if not toks_a and not toks_b:
        return 1.0 if a == b else 0.0
    if not toks_a or not toks_b:
        return 0.0
    inter = len(toks_a & toks_b)
    union = len(toks_a | toks_b)
    return inter / float(union) if union else 0.0


def bodies_near_duplicate(norm_a: str, norm_b: str) -> bool:
    if norm_a == norm_b:
        return True
    if not norm_a or not norm_b:
        return False
    shorter, longer = (norm_a, norm_b) if len(norm_a) <= len(norm_b) else (norm_b, norm_a)
    if shorter in longer and len(shorter) / max(len(longer), 1) >= 0.85:
        return True
    j = token_jaccard(norm_a, norm_b)
    mx = max(len(norm_a), len(norm_b))
    if mx < 200:
        return j >= 0.88
    return j >= 0.93


def segment_min_y(seg: ProblemSegment) -> float:
    ys = [float(p.bbox[1]) for p in seg.pieces if p.bbox]
    return min(ys) if ys else 1e9


def line_piece_sort_key(p: LinePiece) -> Tuple[float, float]:
    if p.bbox:
        return (float(p.bbox[1]), float(p.bbox[0]))
    return (1e9, 1e9)


def normalize_piece_text_for_dedupe(raw: str) -> str:
    """줄 단위 조각 비교용(전역 병합 후 동일 OCR 블록이 piece 두 벌로 남는 경우 제거)."""
    t = (raw or "").strip()
    t = re.sub(r"[\u200b\uFEFF\u00a0]+", "", t)
    t = re.sub(r"\s+", " ", t)
    return t


def dedupe_adjacent_identical_pieces(pieces: List[LinePiece]) -> List[LinePiece]:
    """정렬된 pieces에서 인접·동일 본문 조각은 bbox만 합친 하나로 남긴다(OCR 이중 블록)."""
    out: List[LinePiece] = []
    for p in pieces:
        nt = normalize_piece_text_for_dedupe(p.text)
        if not nt:
            continue
        if out and normalize_piece_text_for_dedupe(out[-1].text) == nt:
            prev = out[-1]
            if p.bbox and prev.bbox:
                a, b = prev.bbox, p.bbox
                out[-1] = LinePiece(
                    text=prev.text,
                    bbox=(min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])),
                )
            continue
        out.append(LinePiece(text=p.text, bbox=p.bbox))
    return out


def merge_segment_list_ordered(segs: List[ProblemSegment]) -> ProblemSegment:
    ordered = sorted(segs, key=segment_min_y)
    all_pieces: List[LinePiece] = []
    for s in ordered:
        all_pieces.extend(s.pieces)
    all_pieces.sort(key=line_piece_sort_key)
    all_pieces = dedupe_adjacent_identical_pieces(all_pieces)
    owner: Optional[int] = None
    for s in ordered:
        o = segment_effective_owner(s)
        if o is not None:
            owner = o
            break
    return ProblemSegment(printed_number=owner, pieces=all_pieces)


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: int, b: int) -> None:
        pa, pb = self.find(a), self.find(b)
        if pa != pb:
            self.p[pb] = pa


def merge_duplicate_owner_segments_global(segments: List[ProblemSegment]) -> List[ProblemSegment]:
    """
    동일 소유 번호 + 사실상 동일 본문인 세그먼트를 비인접 포함 병합(OCR 이중 블록 완화).
    """
    if len(segments) <= 1:
        return segments
    n = len(segments)
    bodies = [normalize_body_for_dedupe(s) for s in segments]
    owners = [segment_effective_owner(s) for s in segments]
    uf = _UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            if owners[i] is None or owners[j] is None:
                continue
            if owners[i] != owners[j]:
                continue
            if bodies_near_duplicate(bodies[i], bodies[j]):
                uf.union(i, j)
    clusters: Dict[int, List[int]] = {}
    for i in range(n):
        r = uf.find(i)
        clusters.setdefault(r, []).append(i)
    out: List[ProblemSegment] = []
    for r in sorted(clusters.keys(), key=lambda x: min(clusters[x])):
        idxs = clusters[r]
        if len(idxs) == 1:
            out.append(segments[idxs[0]])
        else:
            group = [segments[k] for k in sorted(idxs, key=lambda idx: segment_min_y(segments[idx]))]
            out.append(merge_segment_list_ordered(group))
    return out


def clear_stem_problem_outputs(out_dir: Path, stem: str) -> None:
    """`--force` 재생성 시 이전 분할 개수가 더 많으면 남는 problemNN orphan 파일을 제거한다."""
    for pattern in (
        f"{stem}_problem*.md",
        f"{stem}_problem*.png",
        f"{stem}_problem*.jpg",
        f"{stem}_problem*.jpeg",
    ):
        for p in list(out_dir.glob(pattern)):
            try:
                p.unlink()
            except OSError:
                pass


def dedupe_adjacent_segments(segments: List[ProblemSegment]) -> List[ProblemSegment]:
    """인접 중복 세그먼트(동일 owner + 동일 본문)는 1개만 유지."""
    if len(segments) <= 1:
        return segments
    out: List[ProblemSegment] = []
    last_sig: Optional[Tuple[Optional[int], str]] = None
    for seg in segments:
        body_norm = normalize_body_for_dedupe(seg)
        sig = (segment_effective_owner(seg), body_norm)
        if sig == last_sig:
            continue
        out.append(seg)
        last_sig = sig
    return out


def should_start_new_problem(
    *,
    qn: Optional[int],
    txt: str,
    bbox: Optional[Tuple[int, int, int, int]],
    line_type: str,
    prev_qn: Optional[int],
    prev_marker_y: Optional[int],
    page_width: Optional[int],
    page_height: Optional[int],
) -> bool:
    if qn is None or not txt or bbox is None:
        return False

    # 문항 시작으로 쓰기 부적합한 라인 타입은 제외
    if line_type in {"equation_number", "page_info", "x_axis_tick_label", "y_axis_tick_label"}:
        return False

    x0, y0, _, _ = bbox
    if page_width and x0 > int(page_width * 0.68):
        # 지나치게 오른쪽에서 시작하면 문항 번호가 아닌 경우가 많음
        return False

    if prev_marker_y is not None:
        min_gap = 16
        if page_height:
            min_gap = max(min_gap, int(page_height * 0.012))
        if (y0 - prev_marker_y) < min_gap:
            return False

    if prev_qn is not None:
        if qn == prev_qn:
            return False
        if qn < prev_qn and not (prev_qn >= 20 and qn <= 3):
            return False
        if qn - prev_qn > 8:
            return False

    return True


def merge_small_neighbor_segments(segments: List[ProblemSegment]) -> List[ProblemSegment]:
    if len(segments) <= 1:
        return segments

    merged: List[ProblemSegment] = []
    i = 0
    while i < len(segments):
        seg = segments[i]
        line_count = len([p for p in seg.pieces if (p.text or "").strip()])
        char_count = segment_text_char_count(seg)

        # 너무 짧은 조각(오탐 분할 가능성)은 이웃과 병합
        # 단, 번호 기반 세그먼트가 있는 페이지에서는 과한 병합을 피한다.
        numbered_count = sum(1 for s in segments if s.printed_number is not None)
        merge_enabled = numbered_count <= 2
        is_tiny = line_count <= 2 or char_count < 45
        if merge_enabled and is_tiny and i + 1 < len(segments):
            nxt = segments[i + 1]
            combined = ProblemSegment(
                printed_number=seg.printed_number if seg.printed_number is not None else nxt.printed_number,
                pieces=seg.pieces + nxt.pieces,
            )
            segments[i + 1] = combined
            i += 1
            continue

        merged.append(seg)
        i += 1

    return merged if merged else segments


def classify_segment_type(seg: ProblemSegment) -> str:
    body = segment_join_body(seg)
    has_expl = "[해설]" in body or "해설]" in body
    has_ans = "[정답]" in body or "정답]" in body
    if has_expl and has_ans:
        return "answer_and_explanation"
    if has_expl:
        return "explanation"
    if has_ans:
        return "quick_answer"
    return "unknown"


def is_intro_noise_segment(seg: ProblemSegment) -> bool:
    """
    표지/머리말 조각 판정(보수적):
    - 매우 짧고(<= 6줄, < 80자)
    - 정답 헤더가 없고
    - 본문성 수식/문항 단서가 거의 없으며
    - '해설', 과목명, 날짜 같은 머리말 토큰 위주인 경우
    """
    lines = [(p.text or "").strip() for p in seg.pieces if (p.text or "").strip()]
    if not lines:
        return False
    if len(lines) > 6:
        return False
    body = "\n".join(lines)
    if segment_text_char_count(seg) >= 80:
        return False
    if any(answer_header_number(ln) is not None for ln in lines):
        return False
    token_hits = 0
    joined = " ".join(lines)
    if "해설" in joined:
        token_hits += 1
    if "수학영역" in joined or "확률과 통계" in joined:
        token_hits += 1
    if _RE_DATE.search(joined):
        token_hits += 1
    has_math = "$" in body or "\\frac" in body or "\\sqrt" in body
    if has_math:
        return False
    return token_hits >= 2


def filter_segments_for_explanations(segments: List[ProblemSegment]) -> List[ProblemSegment]:
    if not segments:
        return segments
    types = [classify_segment_type(s) for s in segments]
    has_expl = any(t in {"explanation", "answer_and_explanation"} for t in types)
    if not has_expl:
        # 정답 전용 페이지는 이후 매핑에 불필요하므로 기본적으로 비운다.
        quick_only = all(t in {"quick_answer", "unknown"} for t in types)
        if quick_only:
            return []
        return segments
    out = [s for s, t in zip(segments, types) if t in {"explanation", "answer_and_explanation"}]
    # 4차(노이즈 억제): 해설 페이지 맨 앞의 표지형 조각은 제거
    if len(out) >= 2 and is_intro_noise_segment(out[0]):
        out = out[1:]
    return out if out else segments


def build_segments_from_line_data(
    line_data: List[Dict[str, Any]],
    *,
    page_width: Optional[int],
    page_height: Optional[int],
    foreign_answer_split: bool,
) -> List[ProblemSegment]:
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
    prev_qn: Optional[int] = None
    prev_marker_y: Optional[int] = None

    for line in usable:
        txt = (line.get("text") or "").strip()
        qn = extract_printed_question_number(txt) if txt else None
        bbox = cnt_to_bbox(line.get("cnt") or [])
        line_type = str(line.get("type") or "")

        if should_start_new_problem(
            qn=qn,
            txt=txt,
            bbox=bbox,
            line_type=line_type,
            prev_qn=prev_qn,
            prev_marker_y=prev_marker_y,
            page_width=page_width,
            page_height=page_height,
        ):
            if current is not None and current.pieces:
                segments.append(current)
            current = ProblemSegment(printed_number=qn)
            prev_qn = qn
            prev_marker_y = bbox[1] if bbox else prev_marker_y

        if current is None:
            current = ProblemSegment(printed_number=None)

        # 줄 단위 정렬: Mathpix 라인마다 정확히 하나의 LinePiece
        current.pieces.append(LinePiece(text=txt if txt else "", bbox=bbox))

    if current is not None and current.pieces:
        segments.append(current)

    if len(segments) >= 2 and segments[0].printed_number is None:
        head, tail = segments[0], segments[1]
        tail.pieces = head.pieces + tail.pieces
        segments = segments[1:]

    # 안전장치: 비정상 과분할 시 페이지 단일 세그먼트 폴백
    if len(segments) > 20:
        merged = ProblemSegment(printed_number=segments[0].printed_number, pieces=[])
        for s in segments:
            merged.pieces.extend(s.pieces)
        return [merged]

    segments = merge_small_neighbor_segments(segments)

    if foreign_answer_split:
        segments = split_all_segments_on_foreign_answer_headers(segments)
    segments = merge_adjacent_same_owner_segments(segments)
    segments = dedupe_adjacent_segments(segments)

    return [s for s in segments if s.pieces]


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
    section_type: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conf_line = f"{confidence:.6f}" if confidence is not None else "n/a"
    pn = str(printed) if printed is not None else "n/a"
    meta = [
        "---",
        f"sourcePageImage: {source_page}",
        f"problemIndex: {problem_index}",
        f"printedNumber: {pn}",
        f"matchKey: q{pn}" if pn != "n/a" else "matchKey: n/a",
        f"sectionType: {section_type}",
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


def infer_printed_number_for_output(seg: Optional[ProblemSegment], body: str) -> Optional[int]:
    """
    출력 frontmatter용 문항 번호 추정:
    1) 세그먼트 소유번호(printed_number)
    2) 세그먼트 내부 정답 헤더 번호 (N) [정답] / N. [정답])
    3) 세그먼트 내부 문항 시작 번호 (N. / N))
    4) 본문 라인 스캔(정답 헤더 우선, 그다음 문항 시작)
    """
    if seg is not None:
        owner = segment_effective_owner(seg)
        if owner is not None:
            return owner
    for raw in body.splitlines():
        ah = answer_header_number(raw)
        if ah is not None:
            return ah
    for raw in body.splitlines():
        qn = extract_printed_question_number(raw)
        if qn is not None:
            return qn
    return None


def process_one_page(
    image_path: Path,
    out_dir: Path,
    *,
    force: bool,
    padding_ratio: float,
    unit: Optional[str],
    type_: Optional[str],
    difficulty: Optional[str],
    explanation_priority: bool,
    foreign_answer_split: bool,
) -> Tuple[bool, str]:
    stem = image_path.stem
    # 이미 문항 분할 산출물이 존재하면 Mathpix 재호출을 피한다.
    # (여기서는 최소한 problem01 세트가 있으면 분할된 것으로 간주)
    md0 = out_dir / f"{stem}_problem01.md"
    png0 = out_dir / f"{stem}_problem01.png"
    if not force and md0.exists() and png0.exists():
        return True, f"[skip] {image_path.name} (problem01 세트 존재)"

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

    segments = (
        build_segments_from_line_data(
            line_data,
            page_width=data.get("image_width") if isinstance(data.get("image_width"), int) else None,
            page_height=data.get("image_height") if isinstance(data.get("image_height"), int) else None,
            foreign_answer_split=foreign_answer_split,
        )
        if isinstance(line_data, list)
        else []
    )
    if explanation_priority:
        segments = filter_segments_for_explanations(segments)
    # 5차: 해설 필터 후에도 동일 번호·유사 본문 중복이 남을 수 있어 전역 병합
    segments = merge_duplicate_owner_segments_global(segments)
    if force:
        clear_stem_problem_outputs(out_dir, stem)

    if len(segments) <= 1:
        bbox = union_bboxes([p.bbox for s in segments for p in s.pieces if p.bbox]) if segments else None
        if bbox is None and isinstance(line_data, list):
            boxes: List[Tuple[int, int, int, int]] = []
            for line in line_data:
                if skipped_line_for_structure(line):
                    continue
                b = cnt_to_bbox(line.get("cnt") or [])
                if b:
                    boxes.append(b)
            bbox = union_bboxes(boxes)
        if segments:
            merged_lines: List[str] = []
            for seg in segments:
                for p in seg.pieces:
                    if (p.text or "").strip():
                        merged_lines.append(p.text)
            body = "\n\n".join(merged_lines)
        else:
            body = full_text
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
            printed=infer_printed_number_for_output(segments[0] if segments else None, body),
            source_page=image_path.name,
            body=body,
            confidence=conf_f,
            unit=unit,
            type_=type_,
            difficulty=difficulty,
            section_type=classify_segment_type(segments[0]) if segments else "unknown",
        )
        return True, f"[ok] {stem} -> 1문항(폴백)"

    for i, seg in enumerate(segments, start=1):
        png_path = out_dir / f"{stem}_problem{i:02d}.png"
        md_path = out_dir / f"{stem}_problem{i:02d}.md"
        if md_path.exists() and png_path.exists() and not force:
            continue
        boxes_list = [p.bbox for p in seg.pieces if p.bbox]
        ubox = union_bboxes([b for b in boxes_list if b])
        if not ubox:
            return False, f"{stem} 문항 {i}: bbox 없음"
        crop = crop_with_padding(work, ubox, padding_ratio)
        crop.save(png_path)
        body = segment_join_body(seg)
        write_problem_md(
            md_path,
            stem=stem,
            problem_index=i,
            printed=infer_printed_number_for_output(seg, body),
            source_page=image_path.name,
            body=body,
            confidence=conf_f,
            unit=unit,
            type_=type_,
            difficulty=difficulty,
            section_type=classify_segment_type(seg),
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
    parser.add_argument(
        "--no-explanation-priority",
        action="store_true",
        help="해설 우선 필터를 끄고 모든 세그먼트를 저장",
    )
    parser.add_argument(
        "--no-foreign-answer-split",
        action="store_true",
        help="3차: 타 문항 [정답] 줄에서의 강제 분할을 끔 (기본: 켜짐)",
    )
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
    foreign_split = not args.no_foreign_answer_split
    print(
        f"[시작] 페이지 {len(images)}장, workers={workers}, 출력={args.output}, "
        f"foreign_answer_split={foreign_split}"
    )

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
                explanation_priority=not args.no_explanation_priority,
                foreign_answer_split=foreign_split,
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
                    explanation_priority=not args.no_explanation_priority,
                    foreign_answer_split=foreign_split,
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
