import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MemberId } from '@kitty/shared';
import { createAiService } from './ai-service.js';
import type { AiEngine } from './engine.js';
import { createQvacEngine, type SpeechModel } from './qvac-engine.js';

// pnpm ai:eval:speech: the real Whisper on dictated split sentences (infra/fixtures/audio).
// Every case is spoken by every synthetic voice (macOS say, generated here when missing) and by
// whoever recorded it in recorded/. A track passes when every keyword the split depends on is
// heard; WER is printed as a measure. Only the speech model is loaded. `-- --download` fetches
// it into the QVAC cache once; afterwards it runs with the network off. KITTY_STT_MODEL picks
// the Whisper size, as in the agent.

const dir = fileURLToPath(new URL('../../../../infra/fixtures/audio/', import.meta.url));
const spec = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8')) as {
  members: MemberId[];
  voices: string[];
  spoken: Record<string, string>;
  receipts: Record<string, string[]>;
  cases: { id: string; receipt: string; sentence: string; keywords: string[] }[];
};
// At least 9 tracks in 10 with every keyword heard.
const PASS_SHARE = 0.9;
const model: SpeechModel =
  process.env.KITTY_STT_MODEL === 'WHISPER_SMALL_Q8_0' ? 'WHISPER_SMALL_Q8_0' : 'WHISPER_BASE_Q8_0';

if (process.argv.includes('--download')) {
  const sdk = await import('@qvac/sdk');
  for (const m of [sdk[model], sdk.VAD_SILERO_5_1_2]) {
    console.log(`▸ downloading ${m.name}`);
    await sdk.downloadAsset({ assetSrc: m });
  }
}

type Track = { file: string; voice: string; synthetic: boolean; c: (typeof spec.cases)[number] };
const tracks: Track[] = [];
for (const c of spec.cases) {
  for (const voice of spec.voices) {
    const file = `${dir}synthetic/${c.id}-${voice}.wav`;
    if (!existsSync(file)) {
      const text = Object.entries(spec.spoken).reduce(
        (t, [word, said]) => t.replace(new RegExp(`\\b${word}\\b`, 'gi'), said),
        c.sentence,
      );
      execFileSync('say', [
        ...['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000'],
        ...['--channels=1', text],
      ]);
    }
    tracks.push({ file, voice, synthetic: true, c });
  }
}
const recorded = existsSync(`${dir}recorded`) ? readdirSync(`${dir}recorded`) : [];
for (const f of recorded.filter((f) => f.endsWith('.wav'))) {
  const c = spec.cases.find((c) => f.startsWith(`${c.id}-`));
  if (c)
    tracks.push({
      file: `${dir}recorded/${f}`,
      voice: f.slice(c.id.length + 1, -4),
      synthetic: false,
      c,
    });
}

const qvac = createQvacEngine({ speechLanguage: 'en', speechModel: model });
console.log(`▸ ${model}, ${tracks.length} tracks`);
const engine: AiEngine = {
  load: () => Promise.resolve(), // OCR and LLM have their own eval: pnpm ai:eval
  ocr: () => Promise.reject(new Error('not loaded in this eval')),
  complete: () => Promise.reject(new Error('not loaded in this eval')),
  loadSpeech: () => qvac.loadSpeech(),
  transcribe: (pcm, prompt) => qvac.transcribe(pcm, prompt),
};
const ai = createAiService({
  engine,
  log: { info: (m) => console.log(`▸ ${m}`), error: (m) => console.error(`✖ ${m}`) },
});
await ai.speechLoaded;
if (ai.speechStatus() !== 'ready') process.exit(1);

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++)
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return (prev[hyp.length] ?? 0) / Math.max(ref.length, 1);
}

let passed = 0;
const wers: number[] = [];
const latencies: number[] = [];
const byVoice = new Map<string, { passed: number; total: number }>();
const byKeyword = new Map<string, { heard: number; total: number }>();
for (const t of tracks) {
  const r = await ai.transcribe(new Uint8Array(readFileSync(t.file)), {
    members: spec.members,
    items: spec.receipts[t.c.receipt] ?? [],
  });
  const v = byVoice.get(t.voice) ?? { passed: 0, total: 0 };
  v.total++;
  byVoice.set(t.voice, v);
  const name = `${t.c.id} / ${t.voice}`;
  if (!r.ok) {
    console.log(`✖ ${name}: ${r.error}`);
    continue;
  }
  latencies.push(r.latencyMs);
  const heard = words(r.data.text);
  const missed = t.c.keywords.filter((k) => !heard.some((w) => w.startsWith(k)));
  for (const k of t.c.keywords) {
    const s = byKeyword.get(k) ?? { heard: 0, total: 0 };
    s.total++;
    if (!missed.includes(k)) s.heard++;
    byKeyword.set(k, s);
  }
  // A synthetic voice cannot say the words of `spoken`: measured below, not held against Whisper.
  const missing = t.synthetic ? missed.filter((k) => !(k in spec.spoken)) : missed;
  const e = wer(words(t.c.sentence), heard);
  wers.push(e);
  if (missing.length === 0) {
    passed++;
    v.passed++;
  }
  console.log(
    `${missing.length === 0 ? '✓' : '✖'} ${name}: ${r.latencyMs} ms, WER ${(e * 100).toFixed(0)}%, "${r.data.text}"` +
      (missed.length ? ` | missing: ${missed.join(', ')}` : ''),
  );
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
console.log(
  `\nby voice: ${[...byVoice].map(([voice, v]) => `${voice} ${v.passed}/${v.total}`).join(', ')}`,
);
console.log(
  `by keyword: ${[...byKeyword].map(([k, s]) => `${k} ${s.heard}/${s.total}`).join(', ')}`,
);
console.log(
  `tracks: ${passed}/${tracks.length} with every keyword heard (synthetic: but ${Object.keys(spec.spoken).join(', ')}), mean WER ${(mean(wers) * 100).toFixed(1)}%, mean latency ${Math.round(mean(latencies))} ms, max ${Math.max(0, ...latencies)} ms`,
);
const ok = passed >= Math.ceil(tracks.length * PASS_SHARE);
console.log(ok ? 'ai:eval:speech passed' : 'ai:eval:speech failed');
process.exit(ok ? 0 : 1);
