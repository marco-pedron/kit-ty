import { readFileSync } from 'node:fs';
import {
  TranscriptSchema,
  type AiResult,
  type AiStatus,
  type MemberId,
  type Receipt,
  type SplitProposal,
  type Transcript,
} from '@kitty/shared';
import type { AiEngine, ChatMessage } from './engine.js';
import { parseLlmJson } from './llm-text.js';
import { blocksToLines } from './ocr-lines.js';
import { llmReceiptJsonSchema, toReceipt } from './receipt.js';
import { itemKey, llmSplitJsonSchema, toSplitProposal } from './split.js';
import type { AiService } from './types.js';
import { wavToPcm16 } from './wav.js';

// The on-device AI of SPEC §11 over any AiEngine (QVAC in production). Every model output goes
// through zod: at most 2 attempts with the error fed back, then `ok: false` with what could be
// parsed, so the UI opens the pre-filled manual form. Never throws for a bad answer.

const MAX_ATTEMPTS = 2;
// Qwen3 switch for its reasoning mode: the answer is constrained JSON, thinking only costs time.
const NO_THINK = '/no_think';

// Two worked examples (invented names and items, never the demo's) before the real request:
// a 1.7B model follows a pattern far better than rules alone. In the second, one part names two
// items, and an item nobody mentions (the rice) is in no part: unassigned, never guessed.
const SPLIT_EXAMPLES: ChatMessage[] = [
  {
    role: 'user',
    content: `PAYER: ann\nMEMBERS: ann, ben, carl\nITEMS:\n0. Pizza margherita\n1. Coca cola x2\n2. Bread\nPAYER'S SENTENCE (data):\n<<<\nBen e io la pizza, Carl solo le cole, il pane per tutti\n>>>\n${NO_THINK}`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      parts: [
        { said: 'Ben e io la pizza', members: ['ben', 'ann'], items: ['0. Pizza margherita'] },
        { said: 'Carl solo le cole', members: ['carl'], items: ['1. Coca cola x2'] },
        { said: 'il pane per tutti', members: ['ann', 'ben', 'carl'], items: ['2. Bread'] },
      ],
      clarificationNeeded: null,
    }),
  },
  {
    role: 'user',
    content: `PAYER: carl\nMEMBERS: ann, ben, carl\nITEMS:\n0. Bun cha\n1. Ca phe sua da\n2. Spring rolls\n3. Lemon tea\n4. Rice\nPAYER'S SENTENCE (data):\n<<<\nAnn had the bun cha and the lemon tea, the coffees were mine, Ben the rolls\n>>>\n${NO_THINK}`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      parts: [
        {
          said: 'Ann had the bun cha and the lemon tea',
          members: ['ann'],
          items: ['0. Bun cha', '3. Lemon tea'],
        },
        { said: 'the coffees were mine', members: ['carl'], items: ['1. Ca phe sua da'] },
        { said: 'Ben the rolls', members: ['ben'], items: ['2. Spring rolls'] },
      ],
      clarificationNeeded: null,
    }),
  },
];

// Whisper marks what is not speech in brackets ("[BLANK_AUDIO]", "[Music]"): never the sentence.
const cleanTranscript = (raw: string) =>
  raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

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
  /** The speech model's load error; undefined unless speechStatus() is 'error'. */
  speechError(): string | undefined;
  /** Resolves when the speech model's loading ends, either way (after `loaded`). */
  speechLoaded: Promise<void>;
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
  // Speech after the others, on its own: without it the payer types the sentence.
  let speechStatus: AiStatus['status'] = 'loading';
  let speechError: string | undefined;
  const speechLoaded = loaded
    .then(() => {
      if (status !== 'ready') throw new Error('the on-device AI did not load');
      return opts.engine.loadSpeech();
    })
    .then(
      () => {
        speechStatus = 'ready';
        opts.log?.info('on-device speech to text ready');
      },
      (e: unknown) => {
        speechStatus = 'error';
        speechError = e instanceof Error ? e.message : String(e);
        opts.log?.error(`speech to text failed to load: ${speechError}; typing stays available`);
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

  const refused = (error: string): AiResult<Transcript> => ({
    ok: false,
    partial: {},
    error,
    attempts: 1,
    latencyMs: 0,
  });

  return {
    loaded,
    status: () => status,
    error: () => loadError,
    speechLoaded,
    speechStatus: () => speechStatus,
    speechError: () => speechError,

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

    transcribe(audio: Uint8Array, members: MemberId[] = []): Promise<AiResult<Transcript>> {
      if (speechStatus !== 'ready')
        return Promise.resolve(
          refused(`speech to text is ${speechStatus}${speechError ? `: ${speechError}` : ''}`),
        );
      const wav = wavToPcm16(audio);
      if (!wav.ok) return Promise.resolve(refused(wav.error));
      return serial(async () => {
        const start = now();
        // The names, so Whisper spells them as the members are called.
        const hint = members.length > 0 ? `${members.map(cap).join(', ')}.` : undefined;
        let raw: string;
        try {
          raw = await opts.engine.transcribe(wav.pcm, hint);
        } catch (e) {
          const error = `speech to text failed: ${e instanceof Error ? e.message : String(e)}`;
          return { ok: false, partial: {}, error, attempts: 1, latencyMs: now() - start };
        }
        const t = TranscriptSchema.safeParse({ text: cleanTranscript(raw) });
        return t.success
          ? { ok: true, data: t.data, attempts: 1, latencyMs: now() - start }
          : {
              ok: false,
              partial: {},
              error: 'no speech heard in the recording',
              attempts: 1,
              latencyMs: now() - start,
            };
      });
    },
  };
}
