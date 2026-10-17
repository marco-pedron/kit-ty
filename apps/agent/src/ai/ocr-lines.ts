// QVAC OCR returns one block per word group, each with a bbox [x1, y1, x2, y2]. The LLM reads a
// receipt far better as printed rows, so the blocks are grouped back into lines: blocks whose
// vertical centers are within half a line height of each other, left to right.

export interface OcrBlock {
  text: string;
  bbox?: [number, number, number, number] | undefined;
}

export function blocksToLines(blocks: readonly OcrBlock[]): string[] {
  const boxed = blocks.filter((b) => b.bbox !== undefined && b.text.trim() !== '');
  // without boxes, keep the order the OCR gave
  if (boxed.length < blocks.filter((b) => b.text.trim() !== '').length)
    return blocks.map((b) => b.text.trim()).filter((t) => t !== '');

  const items = boxed.map((b) => {
    const [x1, y1, x2, y2] = b.bbox as [number, number, number, number];
    return { text: b.text.trim(), x: Math.min(x1, x2), cy: (y1 + y2) / 2, h: Math.abs(y2 - y1) };
  });
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
