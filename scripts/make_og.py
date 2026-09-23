"""Draws the 1200x630 social preview images (og/<slug>.png and og/home.png).

Run from the repository root:  python scripts/make_og.py
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "scripts" / "seo-data.json").read_text(encoding="utf-8"))
OUT = ROOT / "og"
FONT_BOLD = ROOT / "fonts" / "NotoSans-Bold.ttf"
FONT_REG = ROOT / "fonts" / "NotoSans-Regular.ttf"
W, H = 1200, 630


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def wrap(draw, text, font, width):
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = f"{line} {w}".strip()
        if draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    return lines


def card(title, subtitle, accent, path):
    img = Image.new("RGB", (W, H), (248, 250, 252))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 14], fill=accent)
    # logo: page with folded corner
    x, y = 80, 90
    d.rounded_rectangle([x, y, x + 64, y + 64], radius=14, fill=(37, 99, 235))
    d.polygon([(x + 20, y + 12), (x + 38, y + 12), (x + 46, y + 20), (x + 46, y + 52), (x + 20, y + 52)], fill=(255, 255, 255))
    d.text((x + 84, y + 8), DATA["site"]["name"], font=ImageFont.truetype(str(FONT_BOLD), 40), fill=(15, 23, 42))
    big = ImageFont.truetype(str(FONT_BOLD), 76)
    small = ImageFont.truetype(str(FONT_REG), 34)
    ty = 220
    for line in wrap(d, title, big, W - 160)[:2]:
        d.text((80, ty), line, font=big, fill=(15, 23, 42))
        ty += 92
    ty += 10
    for line in wrap(d, subtitle, small, W - 160)[:3]:
        d.text((80, ty), line, font=small, fill=(71, 85, 105))
        ty += 48
    d.text((80, H - 70), "Free · No sign-up · Files never leave your device", font=ImageFont.truetype(str(FONT_BOLD), 26), fill=accent)
    img.save(path, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    card("Every PDF tool you need", "Merge, split, compress, convert, edit, sign and protect PDFs right in your browser.", (37, 99, 235), OUT / "home.png")
    for t in DATA["tools"]:
        card(t["name"], t["description"], hex_rgb(t["color"]), OUT / f"{t['slug']}.png")
    print(f"Wrote {len(DATA['tools']) + 1} images to og/")


if __name__ == "__main__":
    main()
