"""ZIP 크롭 묶음 → MCP용 base64 페이로드 JSON (일회성 보조)."""
from __future__ import annotations

import argparse
import base64
import io
import json
import zipfile
from pathlib import Path

from PIL import Image


def vstack_png(images: list[Image.Image], gap: int = 16, bg: str = "white") -> bytes:
    w = max(im.width for im in images)
    h = sum(im.height for im in images) + gap * (len(images) - 1)
    canvas = Image.new("RGB", (w, h), bg)
    y = 0
    for i, im in enumerate(images):
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        elif im.mode == "RGBA":
            bgim = Image.new("RGB", im.size, bg)
            bgim.paste(im, mask=im.split()[3])
            im = bgim
        x = (w - im.width) // 2
        canvas.paste(im, (x, y))
        y += im.height + (gap if i < len(images) - 1 else 0)
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("zip_path", type=Path)
    p.add_argument("-o", "--out", type=Path, required=True)
    args = p.parse_args()

    with zipfile.ZipFile(args.zip_path) as z:
        raw = z.read("manifest.json")
        manifest = json.loads(raw.decode("utf-8"))
        out: list[dict] = []
        for it in manifest["items"]:
            qn = str(it["questionNo"])
            main_name = it["file"]
            main_bytes = z.read(main_name)
            figs = it.get("diagramFiles") or []
            if figs:
                ims = [Image.open(io.BytesIO(main_bytes))]
                for fn in figs:
                    ims.append(Image.open(io.BytesIO(z.read(fn))))
                png = vstack_png(ims)
                b64 = base64.b64encode(png).decode("ascii")
                mime = "image/png"
            else:
                b64 = base64.b64encode(main_bytes).decode("ascii")
                mime = "image/png"
            out.append(
                {
                    "questionNo": qn,
                    "pageLabel": it.get("pageLabel", ""),
                    "imageBase64": b64,
                    "imageMimeType": mime,
                    "sourceFiles": [main_name, *figs],
                }
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(out)} payloads -> {args.out}")


if __name__ == "__main__":
    main()
