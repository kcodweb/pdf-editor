"""Draws the PDF Worker launcher icons and splash screens for the Android app.

Run from the repository root:  python scripts/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

RES = Path(__file__).resolve().parent.parent / "android" / "app" / "src" / "main" / "res"
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
LIGHT = (248, 250, 252, 255)
SS = 4  # supersampling for smooth edges


def draw_glyph(draw, cx, cy, unit, page_color, line_color):
    """A page with a folded corner and text lines, centered at (cx, cy); `unit` = page width / 36."""
    w, h, fold = 36 * unit, 46 * unit, 11 * unit
    left, top = cx - w / 2, cy - h / 2
    right, bottom = left + w, top + h
    draw.polygon([(left, top), (right - fold, top), (right, top + fold), (right, bottom), (left, bottom)], fill=page_color)
    # folded corner
    draw.polygon([(right - fold, top), (right - fold, top + fold), (right, top + fold)], fill=(191, 219, 254, 255))
    lw = max(1, round(3.2 * unit))
    for i, length in enumerate([22, 22, 15]):
        y = top + (22 + i * 7.5) * unit
        draw.rounded_rectangle([left + 7 * unit, y, left + (7 + length) * unit, y + lw], radius=lw / 2, fill=line_color)


def square_icon(size, round_icon=False):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_icon:
        d.ellipse([0, 0, big - 1, big - 1], fill=BLUE)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=BLUE)
    draw_glyph(d, big / 2, big / 2, big / 72, WHITE, BLUE)
    return img.resize((size, size), Image.LANCZOS)


def foreground(size):
    # Adaptive icons: 108dp canvas, only the central ~66dp is guaranteed visible.
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(img), big / 2, big / 2, big / 108, WHITE, BLUE)
    return img.resize((size, size), Image.LANCZOS)


def splash(width, height):
    img = Image.new("RGBA", (width, height), LIGHT)
    s = min(width, height) * 0.28
    icon = square_icon(int(s))
    img.alpha_composite(icon, (int((width - s) / 2), int((height - s) / 2)))
    return img.convert("RGB")


def main():
    for folder in sorted(RES.glob("mipmap-*")):
        for name, make in [("ic_launcher.png", square_icon), ("ic_launcher_round.png", lambda n: square_icon(n, True)), ("ic_launcher_foreground.png", foreground)]:
            path = folder / name
            if path.exists():
                size = Image.open(path).size[0]
                make(size).save(path)
    for path in sorted(RES.glob("drawable*/splash.png")):
        w, h = Image.open(path).size
        splash(w, h).save(path)
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2563EB</color>\n</resources>\n',
        encoding="utf-8",
    )
    print("Icons and splash screens updated")


if __name__ == "__main__":
    main()
