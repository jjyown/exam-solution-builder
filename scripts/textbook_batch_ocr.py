#!/usr/bin/env python3
"""
번호 기반 1:1 매핑 + 안전한 병렬 OCR(Mathpix) 스크립트.

핵심 보장:
1) 파일 짝맞추기(Mapping): 이미지(예: 001.png) ↔ md(예: 001.md)를 "파일명 번호" 기준으로 매핑.
2) 안전한 병렬 처리(Concurrency): ThreadPoolExecutor 사용, max_workers 최대 5 고정.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MATHPIX_ENDPOINT = os.environ.get("MATHPIX_API_URL", "https://api.mathpix.com/v3/text")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
MAX_WORKERS_CAP = 5


@dataclass(frozen=True)
class PairInfo:
    number_key: str
    image_path: Optional[Path]
    md_path: Optional[Path]


def extract_number_key(file_name: str) -> Optional[str]:
    """
    파일명에서 첫 숫자 그룹을 추출해 정수 키로 정규화.
    예) "001.png" -> "1", "q-001-fig.png" -> "1"
    """
    m = re.search(r"(\d+)", file_name)
    if not m:
        return None
    return str(int(m.group(1)))


def collect_by_number(files: Iterable[Path], allowed_exts: set[str]) -> Dict[str, Path]:
    out: Dict[str, Path] = {}
    for p in files:
        if p.suffix.lower() not in allowed_exts:
            continue
        key = extract_number_key(p.name)
        if key is None:
            continue
        # 같은 번호가 여러 개면 이름순 우선 1개만 채택
        if key not in out or p.name < out[key].name:
            out[key] = p
    return out


def build_pairs(image_dir: Path, md_dir: Path) -> List[PairInfo]:
    image_map = collect_by_number(image_dir.iterdir(), IMAGE_EXTS)
    md_map = collect_by_number(md_dir.iterdir(), {".md"})
    keys = sorted(set(image_map.keys()) | set(md_map.keys()), key=lambda x: int(x))
    return [PairInfo(k, image_map.get(k), md_map.get(k)) for k in keys]


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
    }
    return json.dumps(payload).encode("utf-8")


def call_mathpix(image_path: Path, max_retry: int = 4) -> Tuple[bool, str, Optional[float]]:
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
            with urlopen(req, timeout=90) as res:
                raw = res.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            text = (data.get("latex_styled") or data.get("text") or "").strip()
            conf = data.get("confidence")
            if not text:
                return False, "OCR 텍스트 비어 있음", conf if isinstance(conf, (int, float)) else None
            return True, text, conf if isinstance(conf, (int, float)) else None
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


def write_md(md_path: Path, number_key: str, image_path: Path, text: str, confidence: Optional[float]) -> None:
    md_path.parent.mkdir(parents=True, exist_ok=True)
    conf_line = f"{confidence:.6f}" if confidence is not None else "n/a"
    md = "\n".join(
        [
            "---",
            f"number: {number_key}",
            f"sourceImage: {image_path.name}",
            f"confidence: {conf_line}",
            "---",
            "",
            "## OCR_본문",
            "",
            text.strip(),
            "",
        ]
    )
    md_path.write_text(md, encoding="utf-8")


def run_batch(image_dir: Path, md_dir: Path, force: bool, max_workers: int) -> int:
    pairs = build_pairs(image_dir, md_dir)
    if not pairs:
        print("대상 파일이 없습니다.")
        return 1

    # 진단 출력
    total = len(pairs)
    ready = sum(1 for p in pairs if p.image_path and p.md_path)
    missing_md = sum(1 for p in pairs if p.image_path and not p.md_path)
    missing_img = sum(1 for p in pairs if not p.image_path and p.md_path)
    print(f"[진단] 전체 키 {total} | 이미 짝지어진 세트 {ready} | md 누락 {missing_md} | 이미지 누락 {missing_img}")

    tasks: List[Tuple[str, Path, Path]] = []
    for p in pairs:
        if not p.image_path:
            continue
        out_md = md_dir / f"{Path(p.image_path.name).stem}.md"
        if out_md.exists() and not force:
            continue
        tasks.append((p.number_key, p.image_path, out_md))

    if not tasks:
        print("[완료] 새로 OCR할 파일이 없습니다. (모두 스킵)")
        return 0

    workers = max(1, min(max_workers, MAX_WORKERS_CAP))
    print(f"[실행] 병렬 OCR 시작: 대상 {len(tasks)}건, max_workers={workers}")

    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        future_map = {
            ex.submit(call_mathpix, img_path): (num_key, img_path, md_path)
            for num_key, img_path, md_path in tasks
        }
        for fut in as_completed(future_map):
            num_key, img_path, md_path = future_map[fut]
            success, text_or_err, conf = fut.result()
            if success:
                write_md(md_path, num_key, img_path, text_or_err, conf)
                ok += 1
                print(f"[OK] {img_path.name} -> {md_path.name}")
            else:
                fail += 1
                print(f"[FAIL] {img_path.name}: {text_or_err}")

    print(f"[결과] 성공 {ok}, 실패 {fail}, 스킵 {len(tasks) - ok - fail}")
    return 0 if fail == 0 else 2


def main() -> int:
    parser = argparse.ArgumentParser(description="번호 매핑 + 병렬 Mathpix OCR (max 5)")
    parser.add_argument("--images", required=True, type=Path, help="원본 문제 이미지 폴더")
    parser.add_argument("--md", required=True, type=Path, help="OCR md 저장/기존 md 폴더")
    parser.add_argument("--force", action="store_true", help="기존 md가 있어도 강제 재OCR")
    parser.add_argument("--max-workers", type=int, default=5, help="병렬 워커 수(최대 5)")
    args = parser.parse_args()

    if not args.images.exists() or not args.images.is_dir():
        print(f"이미지 폴더를 찾을 수 없습니다: {args.images}")
        return 1
    args.md.mkdir(parents=True, exist_ok=True)
    return run_batch(args.images, args.md, args.force, args.max_workers)


if __name__ == "__main__":
    raise SystemExit(main())

