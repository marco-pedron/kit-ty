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

  // Blocks of the demo dinner photographed tilted (QVAC OCR_LATIN on the fake phone photo of
  // make-images-hard.py, seed 31): on the right the rows sit ~25 px higher than on the left,
  // more than half a row. Grouped by the raw centers, "Subtotal" got the tip and "Tip" the total.
  it('straightens a tilted photo: each label keeps the amount of its own row', () => {
    const b = (text: string, x1: number, y1: number, x2: number, y2: number) => ({
      text,
      bbox: [x1, y1, x2, y2] as [number, number, number, number],
    });
    expect(
      blocksToLines([
        b('PHO RESTAURANT HANOI', 86, 49, 370, 90),
        b('17/10/2026', 93, 90, 236, 122),
        b('20:41', 256, 87, 330, 112),
        b('2 X', 291, 155, 338, 175),
        b('65.000', 342, 145, 432, 174),
        b('130.000', 466, 138, 566, 166),
        b('Pho', 102, 163, 147, 187),
        b('bo', 155, 160, 187, 184),
        b('3 X', 293, 188, 339, 207),
        b('25.000', 344, 178, 433, 208),
        b('75 .', 481, 177, 523, 197),
        b('000', 518.75, 171.19, 567.68, 198.43),
        b('Bia Saigon', 106, 190, 245, 220),
        b('Water', 107, 226, 182, 253),
        b('3 X 10.000', 295, 210, 436, 242),
        b('30.000', 481, 206, 567, 231),
        b('235.000', 470, 271, 570, 299),
        b('Subtotal', 115, 289, 229, 320),
        b('20.000', 485, 304, 570, 330),
        b('Tip', 120, 327, 167, 354),
        b('255.000', 474, 336, 572, 366),
        b('TOTAL', 124, 356, 195, 385),
        b('VND', 202, 355, 247, 379),
        b('Cam', 132, 426, 178, 450),
        b('on', 184, 427, 213, 445),
        b('quy khach!', 221, 412, 354, 449),
      ]),
    ).toEqual([
      'PHO RESTAURANT HANOI',
      '17/10/2026  20:41',
      'Pho  bo  2 X  65.000  130.000',
      'Bia Saigon  3 X  25.000  75 .  000',
      'Water  3 X 10.000  30.000',
      'Subtotal  235.000',
      'Tip  20.000',
      'TOTAL  VND  255.000',
      'Cam  on  quy khach!',
    ]);
  });
});
