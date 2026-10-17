"""Renders the HARD receipt fixtures of `pnpm ai:eval:hard` as PNG.

Each receipt exists twice:
  <name>.png        clean, as printed (thermal layout, real-world clutter)
  <name>-photo.png  the same receipt "photographed": tilted, perspective, uneven light, noise, blur

The clutter is deliberate, to confuse OCR and the LLM: order and table numbers, VAT ids,
cash given and change, "VAT included" breakdowns, card numbers and auth codes, EAN codes,
weights and pack sizes inside labels, loyalty points, QR codes (toilet code, survey, e-invoice),
document hashes, a USD conversion line on a VND bill.

Every shop, address, VAT id, phone number, hash and code is invented (CLAUDE.md rule 8).
Expected values: expected.json in this folder (amounts in minor units, like ../expected.json).

Usage: python3 infra/fixtures/receipts/hard/make-images-hard.py  (needs Pillow, numpy, qrcode)
"""
from pathlib import Path
import random

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).parent
WIDTH = 600
MARGIN = 28


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = (
        ["/System/Library/Fonts/Menlo.ttc"]
        + (["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"] if bold else [])
        + ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size, index=1 if bold and path.endswith(".ttc") else 0)
        except OSError:
            continue
    raise SystemExit("no monospace font found (Menlo or DejaVu Sans Mono)")


BODY = font(21)
SMALL = font(17)
BIG = font(30, bold=True)
HUGE = font(46, bold=True)

# Layout primitives: ("c", text, font) centered, ("l", text, font) left,
# ("r", left, right, font) left + right-aligned amount, ("sep",), ("gap", px),
# ("qr", data, caption), ("bar", digits).
RECEIPTS = {
    # Fast food, Italy. Trap: "di cui IVA" is NOT tax to add (VAT included), cash/change,
    # order number in huge digits, "9PZ" in a label, two QR codes, document hash.
    "eur-fastfood": [
        ("c", "BURGER STATION", BIG),
        ("c", "Burger Station Torino S.r.l.", SMALL),
        ("c", "Via Garibaldi 41 - 10122 Torino (TO)", SMALL),
        ("c", "P.IVA 10987654321  Tel. 011 000 4471", SMALL),
        ("sep",),
        ("c", "DOCUMENTO COMMERCIALE", BODY),
        ("c", "di vendita o prestazione", SMALL),
        ("sep",),
        ("c", "ORDINE N.", BODY),
        ("c", "247", HUGE),
        ("r", "Cassa 03  Op. 17", "Tavolo 12", SMALL),
        ("gap", 8),
        ("r", "2 x MENU CLASSIC L   8,90", "17,80", BODY),
        ("l", "    + Patatine grandi", SMALL),
        ("l", "    + Bibita 0,5L", SMALL),
        ("r", "1 x NUGGETS 9PZ", "5,20", BODY),
        ("r", "2 x GELATO CARAMELLO 1,90", "3,80", BODY),
        ("l", "    Ketchup x2  OMAGGIO", SMALL),
        ("sep",),
        ("r", "TOTALE COMPLESSIVO", "26,80", BIG),
        ("r", "di cui IVA 10%", "2,44", BODY),
        ("gap", 6),
        ("r", "Pagamento contante", "30,00", BODY),
        ("r", "Resto", "3,20", BODY),
        ("r", "Importo pagato", "26,80", BODY),
        ("sep",),
        ("r", "17-10-2026 13:27", "DOC.N. 0042-0187", SMALL),
        ("l", "RT 99MEX012345  Z-REP 0311", SMALL),
        ("l", "Hash: 8f3a91c0d27e4b56a1f09e3c77d2b418", SMALL),
        ("gap", 6),
        ("c", "Punti Station Club accumulati: 26", SMALL),
        ("gap", 10),
        ("qr", "https://toilet.example.invalid/burger-station/to41?code=4821",
         "BAGNO: inquadra il QR o digita 4821"),
        ("qr", "https://survey.example.invalid/bs?store=041&ord=247&d=20261017",
         "Sondaggio: vinci un MENU da 8,90!"),
        ("c", "Grazie e arrivederci", BODY),
    ],
    # Restaurant, Vietnam. Traps: tax id (MST), table and guest count, VAT 8% ADDED on top,
    # cash/change, a USD conversion line, wifi password made of digits, e-invoice lookup code,
    # VietQR-like payment QR.
    "vnd-restaurant": [
        ("c", "NHA HANG PHO 36", BIG),
        ("c", "36 Pho Hang Bac, Hoan Kiem, Ha Noi", SMALL),
        ("c", "MST: 0109876543  DT: 024 0000 3636", SMALL),
        ("sep",),
        ("c", "HOA DON THANH TOAN", BODY),
        ("r", "So HD: 000184", "Ban: 07  Khach: 3", SMALL),
        ("r", "Vao: 19:12", "Ra: 20:41", SMALL),
        ("l", "Ngay: 17/10/2026", SMALL),
        ("sep",),
        ("r", "Pho bo tai     2 x 65.000", "130.000", BODY),
        ("r", "Bia Sai Gon    3 x 25.000", "75.000", BODY),
        ("r", "Tra da         3 x 5.000", "15.000", BODY),
        ("r", "Nem ran        1 x 45.000", "45.000", BODY),
        ("sep",),
        ("r", "Tam tinh", "265.000", BODY),
        ("r", "Thue VAT 8%", "21.200", BODY),
        ("r", "TONG CONG (VND)", "286.200", BIG),
        ("gap", 6),
        ("r", "Tien khach dua", "300.000", BODY),
        ("r", "Tien thua", "13.800", BODY),
        ("l", "Quy doi ~ 10,86 USD (ty gia 26.350)", SMALL),
        ("sep",),
        ("l", "Wifi: PHO36_guest  Pass: 88889999", SMALL),
        ("l", "Ma tra cuu HDDT: 7KQ2-X9PL-0184", SMALL),
        ("l", "Hash: c41e09b7a2f35d68e0b19c4a7f2d3e51", SMALL),
        ("gap", 10),
        ("qr", "000201010211example-vietqr-0000000000|PHO36|286200|HD000184",
         "Quet ma de chuyen khoan"),
        ("c", "Cam on quy khach! Hen gap lai", BODY),
    ],
    # Supermarket, Italy. Traps: EAN codes, weights and pack sizes in labels (500G, 6X1,5L,
    # 250ML), price per kg, VAT summary table (included, NOT tax to add), card mask and auth
    # code, item count, loyalty card barcode.
    "eur-supermarket": [
        ("c", "SUPERMERCATO SOLE", BIG),
        ("c", "Corso Vittorio 200 - 10125 Torino", SMALL),
        ("c", "P.IVA 01234560019  Punto vendita 0815", SMALL),
        ("sep",),
        ("c", "DOCUMENTO COMMERCIALE", BODY),
        ("sep",),
        ("l", "8001234000014", SMALL),
        ("r", "BANANE", "1,83 B", BODY),
        ("l", "   0,734 kg x 2,49 EUR/kg", SMALL),
        ("l", "8001234000021", SMALL),
        ("r", "LATTE INTERO 1L  2 x 1,29", "2,58 A", BODY),
        ("l", "8001234000038", SMALL),
        ("r", "PASTA SPAGHETTI 500G", "0,99 A", BODY),
        ("l", "8001234000045", SMALL),
        ("r", "ACQUA NAT. 6X1,5L", "2,34 C", BODY),
        ("l", "8001234000052", SMALL),
        ("r", "YOGURT GRECO  3 x 0,89", "2,67 A", BODY),
        ("l", "8001234000069", SMALL),
        ("r", "PANE COMUNE", "1,32 B", BODY),
        ("l", "   0,412 kg x 3,20 EUR/kg", SMALL),
        ("l", "8001234000076", SMALL),
        ("r", "SHAMPOO 250ML", "3,49 C", BODY),
        ("l", "8001234000083", SMALL),
        ("r", "CAFFE MACINATO 250G", "3,25 C", BODY),
        ("sep",),
        ("r", "TOTALE EUR", "18,47", BIG),
        ("r", "Num. pezzi", "11", BODY),
        ("r", "Pagamento elettronico", "18,47", BODY),
        ("l", "Carta **** **** **** 4417  Aut. 093751", SMALL),
        ("sep",),
        ("l", "Aliq.   Imponibile   Imposta", SMALL),
        ("l", "A  4%        6,00      0,24", SMALL),
        ("l", "B 10%        2,86      0,29", SMALL),
        ("l", "C 22%        7,44      1,64", SMALL),
        ("sep",),
        ("r", "16-10-2026 18:52", "DOC.N. 1127-0094", SMALL),
        ("l", "Hash: 5be0f2a9c3d1e47f8a6b0c92d1e3f4a7", SMALL),
        ("c", "Punti carta Sole: 18  Saldo: 1.240", SMALL),
        ("bar", "2900012345678"),
        ("c", "Conservare per eventuali resi", SMALL),
    ],
}


def text_w(draw: ImageDraw.ImageDraw, s: str, f: ImageFont.FreeTypeFont) -> int:
    return int(draw.textlength(s, font=f))


def line_h(f: ImageFont.FreeTypeFont) -> int:
    a, d = f.getmetrics()
    return a + d + 6


def render(spec: list) -> Image.Image:
    canvas = Image.new("RGB", (WIDTH, 4000), "white")
    d = ImageDraw.Draw(canvas)
    y = MARGIN
    for el in spec:
        kind = el[0]
        if kind == "c":
            _, s, f = el
            d.text(((WIDTH - text_w(d, s, f)) // 2, y), s, fill="black", font=f)
            y += line_h(f)
        elif kind == "l":
            _, s, f = el
            d.text((MARGIN, y), s, fill="black", font=f)
            y += line_h(f)
        elif kind == "r":
            _, left, right, f = el
            d.text((MARGIN, y), left, fill="black", font=f)
            d.text((WIDTH - MARGIN - text_w(d, right, f), y), right, fill="black", font=f)
            y += line_h(f)
        elif kind == "sep":
            d.text((MARGIN, y), "-" * 46, fill="black", font=SMALL)
            y += line_h(SMALL)
        elif kind == "gap":
            y += el[1]
        elif kind == "qr":
            _, data, caption = el
            q = qrcode.make(data, box_size=4, border=1).convert("RGB")
            canvas.paste(q, ((WIDTH - q.width) // 2, y))
            y += q.height + 4
            d.text(((WIDTH - text_w(d, caption, SMALL)) // 2, y), caption, fill="black", font=SMALL)
            y += line_h(SMALL) + 8
        elif kind == "bar":
            digits = el[1]
            rng = random.Random(digits)
            x, top, h = (WIDTH - 300) // 2, y, 70
            while x < (WIDTH + 300) // 2:
                w = rng.choice([2, 2, 3, 4])
                if rng.random() < 0.55:
                    d.rectangle([x, top, x + w - 1, top + h], fill="black")
                x += w
            y += h + 4
            d.text(((WIDTH - text_w(d, digits, SMALL)) // 2, y), digits, fill="black", font=SMALL)
            y += line_h(SMALL)
    return canvas.crop((0, 0, WIDTH, y + MARGIN))


def photograph(img: Image.Image, seed: int) -> Image.Image:
    """Fake phone photo: paper on a table, tilted, perspective, uneven light, noise, blur."""
    rng = np.random.default_rng(seed)
    w, h = img.size
    # thermal paper: slightly grey, faded ink
    arr = np.asarray(img, dtype=np.float32)
    arr = 245 - (255 - arr) * 0.82
    paper = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    # table background, bigger than the receipt
    bw, bh = int(w * 1.35), int(h * 1.12)
    bg = Image.new("RGB", (bw, bh), (92, 84, 74))
    bg.paste(paper, ((bw - w) // 2, (bh - h) // 2))
    # tilt
    bg = bg.rotate(float(rng.uniform(-4, 4)), resample=Image.BICUBIC, fillcolor=(92, 84, 74))
    # perspective: top edge narrower, as if shot from below the receipt
    dx = bw * 0.05
    quad = (dx, 0, 0, bh, bw, bh, bw - dx, 0)
    bg = bg.transform((bw, bh), Image.QUAD, quad, resample=Image.BICUBIC)
    # uneven light (shadow of the phone on one corner) + sensor noise
    a = np.asarray(bg, dtype=np.float32)
    yy, xx = np.mgrid[0:bh, 0:bw]
    light = 0.72 + 0.32 * (xx / bw) * (1 - 0.35 * yy / bh)
    a = a * light[..., None] + rng.normal(0, 7, a.shape)
    out = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    return out.filter(ImageFilter.GaussianBlur(0.9)).resize((bw * 3 // 4, bh * 3 // 4), Image.LANCZOS)


for i, (name, spec) in enumerate(RECEIPTS.items()):
    clean = render(spec)
    clean.save(HERE / f"{name}.png")
    photograph(clean, seed=17 + i).save(HERE / f"{name}-photo.png")
    print(f"wrote {name}.png and {name}-photo.png")
