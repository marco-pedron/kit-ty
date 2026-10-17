"""Renders the receipt fixtures of `pnpm ai:eval` (task A4) as PNG.

Invented shops and amounts; the dinner is the demo dinner of SPEC §15.
Usage: python3 infra/fixtures/receipts/make-images.py  (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 28)

RECEIPTS = {
    "vnd-dinner": [
        "PHO RESTAURANT HANOI",
        "17/10/2026  20:41",
        "",
        "Pho bo        2 x 65.000   130.000",
        "Bia Saigon    3 x 25.000    75.000",
        "Water         3 x 10.000    30.000",
        "",
        "Subtotal                   235.000",
        "Tip                         20.000",
        "TOTAL VND                  255.000",
        "",
        "Cam on quy khach!",
    ],
    "eur-taxi": [
        "TAXI CITY CAB",
        "Date: 15/10/2026  08:12",
        "",
        "Airport transfer          38,50",
        "Luggage supplement         2,00",
        "",
        "Tip                        4,50",
        "TOTAL EUR                 45,00",
        "",
        "VAT included",
    ],
    "usd-supermarket": [
        "FRESH MARKET",
        "10/16/2026 18:05",
        "",
        "Bananas 0.73 kg @ 1.10/kg    0.80",
        "Water 1.5L   2 x 1.25        2.50",
        "Rice crackers                3.40",
        "Instant noodles  3 x 0.90    2.70",
        "",
        "Subtotal                     9.40",
        "Sales tax                    0.75",
        "TOTAL USD                   10.15",
    ],
}

for name, lines in RECEIPTS.items():
    img = Image.new("RGB", (800, 60 + 44 * len(lines)), "white")
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((30, 30 + 44 * i), line, fill="black", font=FONT)
    img.save(HERE / f"{name}.png")
    print(f"wrote {name}.png")
