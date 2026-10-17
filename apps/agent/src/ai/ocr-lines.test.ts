import { describe, expect, it } from 'vitest';
import { blocksToLines } from './ocr-lines.js';

describe('blocksToLines', () => {
  it('groups blocks into printed rows, left to right', () => {
    expect(
      blocksToLines([
        { text: '130.000', bbox: [500, 163, 620, 192] },
        { text: 'Pho', bbox: [28, 163, 83, 192] },
        { text: 'HANOI', bbox: [280, 31, 370, 60] },
        { text: 'bo', bbox: [95, 164, 132, 193] },
        { text: 'PHO', bbox: [27, 31, 84, 60] },
      ]),
    ).toEqual(['PHO  HANOI', 'Pho  bo  130.000']);
  });

  it('keeps the OCR order when boxes are missing', () => {
    expect(blocksToLines([{ text: 'b' }, { text: ' ' }, { text: 'a' }])).toEqual(['b', 'a']);
  });
});
