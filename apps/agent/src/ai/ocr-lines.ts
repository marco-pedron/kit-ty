// QVAC OCR returns one block per word group, each with a bbox [x1, y1, x2, y2]. The LLM reads a
// receipt far better as printed rows, so the blocks are grouped back into lines: blocks whose
// vertical centers are within half a line height of each other, left to right.
//
// A phone photo is rarely straight: tilted by 3-4°, the amount at the right edge of a row sits
// 20-40 px above or below its label, more than half a row, and paired with the label of the
// next row ("Subtotal" with the tip). The tilt is measured on blocks that are side by side on
// one row (words a few pixels apart, which still overlap vertically) and the centers are
// straightened before grouping.

export interface OcrBlock {
  text: string;
  bbox?: [number, number, number, number] | undefined;
}

interface Placed {
  text: string;
  x1: number;
  x2: number;
  cx: number;
  cy: number;
  h: number;
}

/** Beyond this the measure is noise: a receipt photographed at more than ~8° is not read. */
const MAX_SLOPE = 0.15;

/**
 * The tilt of the rows (dy per dx): the median slope between each block and its nearest
 * neighbour to the right on the same row (small gap, vertical overlap). 0 without such pairs.
 */
function rowSlope(blocks: readonly Placed[]): number {
  const slopes: number[] = [];
  for (const a of blocks) {
    let best: { b: Placed; gap: number } | null = null;
    for (const b of blocks) {
      if (b === a) continue;
      const gap = b.x1 - a.x2;
      const h = Math.max(a.h, b.h);
      // touching or slightly overlapping boxes count; far apart ones may be other rows
      if (gap < -h / 2 || gap > 2 * h) continue;
      const overlap =
        Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
      if (overlap < Math.min(a.h, b.h) / 2) continue;
      if (best === null || gap < best.gap) best = { b, gap };
    }
    if (best !== null && best.b.cx > a.cx) slopes.push((best.b.cy - a.cy) / (best.b.cx - a.cx));
  }
  if (slopes.length === 0) return 0;
  slopes.sort((p, q) => p - q);
  const mid = slopes.length >> 1;
  const median =
    slopes.length % 2 === 1
      ? (slopes[mid] ?? 0)
      : ((slopes[mid - 1] ?? 0) + (slopes[mid] ?? 0)) / 2;
  return Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, median));
}

export function blocksToLines(blocks: readonly OcrBlock[]): string[] {
  const boxed = blocks.filter((b) => b.bbox !== undefined && b.text.trim() !== '');
  // without boxes, keep the order the OCR gave
  if (boxed.length < blocks.filter((b) => b.text.trim() !== '').length)
    return blocks.map((b) => b.text.trim()).filter((t) => t !== '');

  const placed: Placed[] = boxed.map((b) => {
    const [x1, y1, x2, y2] = b.bbox as [number, number, number, number];
    const [l, r] = x1 <= x2 ? [x1, x2] : [x2, x1];
    return {
      text: b.text.trim(),
      x1: l,
      x2: r,
      cx: (l + r) / 2,
      cy: (y1 + y2) / 2,
      h: Math.abs(y2 - y1),
    };
  });
  const slope = rowSlope(placed);
  // the vertical center as if the photo were straight
  const items = placed.map((p) => ({ text: p.text, x: p.x1, cy: p.cy - slope * p.cx, h: p.h }));
  items.sort((a, b) => a.cy - b.cy);

  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows.at(-1);
    const rowCy = row ? row.reduce((s, r) => s + r.cy, 0) / row.length : 0;
    const rowH = row ? Math.max(...row.map((r) => r.h)) : 0;
    if (row && Math.abs(it.cy - rowCy) <= Math.max(rowH, it.h) / 2) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) =>
    r
      .sort((a, b) => a.x - b.x)
      .map((x) => x.text)
      .join('  '),
  );
}
