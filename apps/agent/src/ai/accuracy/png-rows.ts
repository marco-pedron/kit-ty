import { deflateSync, inflateSync } from 'node:zlib';

// Just enough PNG for the reference tool (vlm-reference.ts): decode an 8-bit, non-interlaced
// grey/RGB/RGBA image, find its printed rows (bands of ink between white gaps) and encode one
// band as a new PNG. No dependency, no native binary.

export interface Raster {
  width: number;
  height: number;
  /** bytes per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA */
  bpp: number;
  /** unfiltered rows, width * bpp bytes each */
  rows: Buffer[];
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(png: Buffer): Raster {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      const ch = CHANNELS[color ?? -1];
      if (depth !== 8 || ch === undefined || interlace !== 0)
        throw new Error(`unsupported PNG: depth ${depth}, color ${color}, interlace ${interlace}`);
      bpp = ch;
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (line[x - bpp] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const add =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      line[x] = ((line[x] ?? 0) + add) & 0xff;
    }
    rows.push(line);
    prev = line;
  }
  return { width, height, bpp, rows };
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Rows y0..y1 (exclusive) of the image, as a PNG. */
export function encodeBand(img: Raster, y0: number, y1: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(y1 - y0, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[img.bpp] ?? 2;
  const body = Buffer.concat(img.rows.slice(y0, y1).flatMap((r) => [Buffer.from([0]), r]));
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(body)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The printed rows: bands of pixel rows with ink (darker than `ink`), split where a few white
 * pixel rows separate them, each padded by `pad` pixels. Built for clean, straight prints.
 */
export function rowBands(img: Raster, ink = 128, minGap = 3, pad = 4): [number, number][] {
  const inked = img.rows.map((r) => {
    for (let x = 0; x < img.width; x++) {
      const p = x * img.bpp;
      const luma =
        img.bpp >= 3 ? ((r[p] ?? 0) + (r[p + 1] ?? 0) + (r[p + 2] ?? 0)) / 3 : (r[p] ?? 0);
      if (luma < ink) return true;
    }
    return false;
  });
  const bands: [number, number][] = [];
  let start = -1;
  let blank = 0;
  inked.forEach((has, y) => {
    if (has) {
      if (start < 0) start = y;
      blank = 0;
    } else if (start >= 0 && ++blank >= minGap) {
      bands.push([start, y - blank + 1]);
      start = -1;
    }
  });
  if (start >= 0) bands.push([start, img.height]);
  return bands.map(([a, b]) => [Math.max(0, a - pad), Math.min(img.height, b + pad)]);
}
