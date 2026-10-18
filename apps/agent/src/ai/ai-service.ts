import { readFileSync } from 'node:fs';
import type { AiResult, AiStatus, MemberId, Receipt, SplitProposal } from '@kitty/shared';
import type { AiEngine, ChatMessage } from './engine.js';
import { parseLlmJson } from './llm-text.js';
import { blocksToLines } from './ocr-lines.js';
import { llmReceiptJsonSchema, toReceipt } from './receipt.js';
import { itemKey, llmSplitJsonSchema, toSplitProposal } from './split.js';
import type { AiService } from './types.js';

// The on-device AI of SPEC §11 over any AiEngine (QVAC in production). Every model output goes
// through zod: at most 2 attempts with the error fed back, then `ok: false` with what could be
// parsed, so the UI opens the pre-filled manual form. Never throws for a bad answer.

const MAX_ATTEMPTS = 2;
// Qwen3 switch for its reasoning mode: the answer is constrained JSON, thinking only costs time.
const NO_THINK = '/no_think';

// Two worked examples (invented names and items, never the demo's) before the real request:
// a 1.7B model follows a pattern far better than rules alone.
const SPLIT_EXAMPLES: ChatMessage[] = [
  {
    role: 'user',
    content: `PAYER: ann\nMEMBERS: ann, ben, carl\nITEMS:\n0. Pizza margherita\n1. Coca cola x2\n2. Bread\nPAYER'S SENTENCE (data):\n<<<\nBen e io la pizza, Carl solo le cole, il pane per tutti\n>>>\n${NO_THINK}`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      items: {
        '0. Pizza margherita': ['ben', 'ann'],
        '1. Coca cola x2': ['carl'],
        '2. Bread': ['ann', 'ben', 'carl'],
      },
      clarificationNeeded: null,
    }),
  },
  {
    role: 'user',
    content: `PAYER: carl\nMEMBERS: ann, ben, carl\nITEMS:\n0. Bun cha\n1. Ca phe sua da\n2. Spring rolls\nPAYER'S SENTENCE (data):\n<<<\nAnn had the bun cha, the coffees were mine, spring rolls for Ben and Ann\n>>>\n${NO_THINK}`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      items: {
        '0. Bun cha': ['ann'],
        '1. Ca phe sua da': ['carl'],
        '2. Spring rolls': ['ben', 'ann'],
      },
      clarificationNeeded: null,
    }),
  },
];

// One worked receipt (invented shop and items, never the demo's or the fixtures'): a menu with
// its components, a freebie, VAT included, cash given and change.
const EXTRACT_EXAMPLE_ROWS = [
  'PANINOTECA ZEFIRO',
  'Via del Molo 8 - Genova',
  '03-09-2026 12:48',
  '1 x MENU PANINO   9,50',
  '+ Patatine piccole',
  '+ Acqua 0,5L',
  '2 x CAFFE 1,20   2,40',
  'Bustina zucchero x2 OMAGGIO',
  'TOTALE   11,90',
  'di cui IVA 10%   1,08',
  'Pagamento contante   20,00',
  'Resto   8,10',
];
const EXTRACT_EXAMPLE: ChatMessage[] = [
  {
    role: 'user',
    content: `RECEIPT ROWS (OCR):\n<<<\n${EXTRACT_EXAMPLE_ROWS.map((l, i) => `${i}| ${l}`).join('\n')}\n>>>\n${NO_THINK}`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      merchant: 'Paninoteca Zefiro',
      date: '2026-09-03',
      currency: 'EUR',
      items: [
        { row: 3, label: 'Menu panino', quantity: 1 },
        { row: 6, label: 'Caffe', quantity: 2 },
      ],
      subtotalRow: null,
      taxRow: null,
      tipRow: null,
      totalRow: 8,
    }),
  },
];

const prompt = (name: string) =>
  readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8').trim();

export interface AiServiceOptions {
  engine: AiEngine;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
  now?: () => number;
}

export interface AiServiceHandle extends AiService {
  /** The load error, for the log and /state; undefined unless status() is 'error'. */
  error(): string | undefined;
  /** Resolves when loading ends, either way. */
  loaded: Promise<void>;
}

type Converted<T, P> = { ok: true; data: T } | { ok: false; error: string; partial: P };

export function createAiService(opts: AiServiceOptions): AiServiceHandle {
  const now = opts.now ?? (() => Date.now());
  let status: AiStatus['status'] = 'loading';
  let loadError: string | undefined;
  const t0 = now();
  const loaded = opts.engine.load().then(
    () => {
      status = 'ready';
      opts.log?.info(`on-device AI ready in ${Math.round((now() - t0) / 1000)} s`);
    },
    (e: unknown) => {
      status = 'error';
      loadError = e instanceof Error ? e.message : String(e);
      opts.log?.error(`on-device AI failed to load: ${loadError}; the manual form stays available`);
    },
  );

  // One model run at a time: the models are loaded once and shared by the travelers' agents.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };

  async function ask<T, P>(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    convert: (value: unknown) => Converted<T, P>,
    emptyPartial: P,
    start: number,
  ): Promise<AiResult<T, P>> {
    let partial = emptyPartial;
    let error = '';
    const history = [...messages];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        raw = await opts.engine.complete(history, schema);
      } catch (e) {
        error = `the model did not answer: ${e instanceof Error ? e.message : String(e)}`;
        return { ok: false, partial, error, attempts: attempt, latencyMs: now() - start };
      }
      const json = parseLlmJson(raw);
      const c = json.ok ? convert(json.value) : { ok: false as const, error: json.error, partial };
      if (c.ok) return { ok: true, data: c.data, attempts: attempt, latencyMs: now() - start };
      ({ error, partial } = c);
      history.push(
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `That answer is not valid:\n${error}\nReturn the corrected JSON object only. ${NO_THINK}`,
        },
      );
    }
    return { ok: false, partial, error, attempts: MAX_ATTEMPTS, latencyMs: now() - start };
  }

  const notReady = <T, P>(partial: P): AiResult<T, P> => ({
    ok: false,
    partial,
    error: `on-device AI is ${status}${loadError ? `: ${loadError}` : ''}`,
    attempts: 1,
    latencyMs: 0,
  });

  return {
    loaded,
    status: () => status,
    error: () => loadError,

    extractReceipt(image: Uint8Array): Promise<AiResult<Receipt>> {
      if (status !== 'ready') return Promise.resolve(notReady({}));
      return serial(async () => {
        const start = now();
        let lines: string[];
        try {
          lines = blocksToLines(await opts.engine.ocr(image));
        } catch (e) {
          const error = `OCR failed: ${e instanceof Error ? e.message : String(e)}`;
          return { ok: false, partial: {}, error, attempts: 1, latencyMs: now() - start };
        }
        if (lines.length === 0)
          return {
            ok: false,
            partial: {},
            error: 'no text found in the photo',
            attempts: 1,
            latencyMs: now() - start,
          };
        const messages: ChatMessage[] = [
          { role: 'system', content: prompt('extract-receipt') },
          ...EXTRACT_EXAMPLE,
          {
            role: 'user',
            content: `RECEIPT ROWS (OCR):\n<<<\n${lines.map((l, i) => `${i}| ${l}`).join('\n')}\n>>>\n${NO_THINK}`,
          },
        ];
        return ask(
          messages,
          llmReceiptJsonSchema(lines.length) as Record<string, unknown>,
          (v): Converted<Receipt, Partial<Receipt>> => {
            const r = toReceipt(v, lines);
            return r.ok ? { ok: true, data: r.receipt } : r;
          },
          {},
          start,
        );
      });
    },

    proposeSplit(
      receipt: Receipt,
      members: MemberId[],
      text: string,
      clarification?: { question: string; answer: string },
      payer?: MemberId,
    ): Promise<AiResult<SplitProposal>> {
      const all = receipt.items.map((_, i) => i);
      if (status !== 'ready') return Promise.resolve(notReady({ unassigned: all }));
      if (members.length === 0)
        return Promise.resolve({
          ok: false,
          partial: { unassigned: all },
          error: 'no active travelers to split with',
          attempts: 1,
          latencyMs: 0,
        });
      return serial(async () => {
        const start = now();
        const items = receipt.items.map((_, i) => itemKey(receipt, i)).join('\n');
        const answer = clarification
          ? `\nYOUR QUESTION: ${clarification.question}\nPAYER'S ANSWER (data):\n<<<\n${clarification.answer}\n>>>`
          : '';
        const messages: ChatMessage[] = [
          { role: 'system', content: prompt('propose-split') },
          ...SPLIT_EXAMPLES,
          {
            role: 'user',
            content: `PAYER: ${payer ?? 'unknown'}\nMEMBERS: ${members.join(', ')}\nITEMS:\n${items}\nPAYER'S SENTENCE (data):\n<<<\n${text}\n>>>${answer}\n${NO_THINK}`,
          },
        ];
        return ask(
          messages,
          llmSplitJsonSchema(receipt, members) as Record<string, unknown>,
          (v): Converted<SplitProposal, Partial<SplitProposal>> => {
            const r = toSplitProposal(v, receipt, members);
            return r.ok ? { ok: true, data: r.proposal } : r;
          },
          { unassigned: all },
          start,
        );
      });
    },
  };
}
