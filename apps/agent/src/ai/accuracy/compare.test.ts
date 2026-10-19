import { describe, expect, it } from 'vitest';
import { loadCases, normalizeText, sameText } from './compare.js';

const judge = (answer: string | Error) => {
  const calls: string[] = [];
  return {
    calls,
    complete: (messages: { content: string }[]) => {
      calls.push(messages.at(-1)?.content ?? '');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
};

describe('normalizeText', () => {
  it.each([
    ['Caffè  Espresso.', 'caffe espresso'],
    ['  PHO RESTAURANT HANOI ', 'pho restaurant hanoi'],
    ['Bananas (0.73 kg)', 'bananas 073kg'],
    ['Bananas 0.73 kg', 'bananas 073kg'],
    ['ACQUA NAT. 6X1,5L', 'acqua nat 6x15l'],
    ['Bibita 0,5 L', 'bibita 05l'],
  ])('%s → %s', (input, out) => expect(normalizeText(input)).toBe(out));

  it('keeps words apart', () => {
    expect(normalizeText('Pho bo')).not.toBe(normalizeText('Phobo tai'));
  });
});

describe('sameText', () => {
  it('equal after normalization: passes without calling the judge', async () => {
    const e = judge('{"verdict":"no"}');
    await expect(sameText(e, 'label', 'Caffe espresso', 'CAFFÈ ESPRESSO')).resolves.toEqual({
      equivalent: true,
      via: 'normalized',
    });
    expect(e.calls).toHaveLength(0);
  });

  it('otherwise asks the judge once, with both texts', async () => {
    const e = judge('<think></think>{"verdict":"yes"}');
    const v = await sameText(e, 'label', 'ACQUA NATURALE', 'ACQUA NAT.');
    expect(v).toMatchObject({ equivalent: true, via: 'judge' });
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0]).toContain('ACQUA NATURALE');
    expect(e.calls[0]).toContain('ACQUA NAT.');
  });

  it('"no" is different', async () => {
    const v = await sameText(judge('{"verdict":"no"}'), 'merchant', 'BAR CENTRALE', 'BAR SPORT');
    expect(v).toMatchObject({ equivalent: false, via: 'judge', raw: '{"verdict":"no"}' });
  });

  it('an unreadable or failed answer is different, never a pass', async () => {
    await expect(sameText(judge('maybe'), 'label', 'Pane', 'Pasta')).resolves.toMatchObject({
      equivalent: false,
    });
    await expect(
      sameText(judge(new Error('busy')), 'label', 'Pane', 'Pasta'),
    ).resolves.toMatchObject({ equivalent: false, raw: 'no answer: busy' });
  });
});

describe('loadCases', () => {
  it('reads every expected file of the three sets, each with its image', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(39);
    expect(cases.map((c) => c.id)).toContain('hard/eur-fastfood-photo.png');
    for (const c of cases) expect(c.image.endsWith(c.expected.receipt)).toBe(true);
  });
});
