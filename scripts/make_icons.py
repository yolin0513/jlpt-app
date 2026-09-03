#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""產生 PWA 圖示（放在 icons/）。需要 Pillow： pip install Pillow
用法： python scripts/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
ICONS.mkdir(exist_ok=True)

BG = (31, 111, 235)      # --primary
BG2 = (12, 17, 23)
FG = (255, 255, 255)


def find_font(size):
    candidates = [
        "C:/Windows/Fonts/YuGothB.ttc",
        "C:/Windows/Fonts/meiryob.ttc",
        "C:/Windows/Fonts/msjh.ttc",
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/arialbd.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_icon(size, maskable=False):
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    pad = int(size * 0.14)
    if not maskable:
        d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=int(size * 0.18), fill=BG2)
        box = [pad, pad, size - pad, size - pad]
    else:
        box = [0, 0, size, size]

    text = "JL"
    sub = "PT"
    f1 = find_font(int(size * 0.34))
    f2 = find_font(int(size * 0.24))

    def center(txt, font, cy):
        bb = d.textbbox((0, 0), txt, font=font)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        d.text(((size - w) / 2 - bb[0], cy - h / 2 - bb[1]), txt, font=font, fill=FG)

    center(text, f1, size * 0.42)
    center(sub, f2, size * 0.66)
    return img


for s in (192, 512):
    draw_icon(s).save(ICONS / f"icon-{s}.png")
draw_icon(512, maskable=True).save(ICONS / "icon-maskable-512.png")
# Apple touch icon（不透明）
draw_icon(180).save(ICONS / "apple-touch-icon.png")
print("圖示已產生於", ICONS)
