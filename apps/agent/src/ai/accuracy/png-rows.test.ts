import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng, encodeBand, rowBands } from './png-rows.js';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../infra/fixtures/receipts/${name}`, import.meta.url)),
  );

describe('png-rows', () => {
  it('re-encodes the whole image to the same pixels', () => {
    const img = decodePng(fixture('vnd-dinner.png'));
    const again = decodePng(encodeBand(img, 0, img.height));
    expect(again.width).toBe(img.width);
    expect(again.height).toBe(img.height);
    expect(Buffer.concat(again.rows).equals(Buffer.concat(img.rows))).toBe(true);
  });

  it('finds one band per printed row', () => {
    // shop, date, 3 items, subtotal, tip, total, thank-you: blank rows are not bands
    expect(rowBands(decodePng(fixture('vnd-dinner.png')))).toHaveLength(9);
  });

  it('crops a band to its rows', () => {
    const img = decodePng(fixture('vnd-dinner.png'));
    const [y0, y1] = rowBands(img)[0] ?? [0, 0];
    const band = decodePng(encodeBand(img, y0, y1));
    expect(band.height).toBe(y1 - y0);
    expect(band.rows[0]?.equals(img.rows[y0] ?? Buffer.alloc(0))).toBe(true);
  });

  it('refuses what is not a PNG', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG');
  });
});
