import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAiService } from './ai-service.js';
import type { AiEngine } from './engine.js';
import { createQvacEngine } from './qvac-engine.js';

// pnpm ai:eval:speech: the real Whisper on the dictated demo sentence (infra/fixtures/audio,
// synthetic voices). It passes when the words the split needs are heard: the names and the
// items. Only the speech model is loaded. `-- --download` fetches it into the QVAC cache once;
// afterwards it runs with the network off.

const dir = fileURLToPath(new URL('../../../../infra/fixtures/audio/', import.meta.url));
const language = process.env.KITTY_STT_LANGUAGE === 'it' ? 'it' : 'en';
const CASES: Record<'en' | 'it', { file: string; words: string[] }> = {
  en: { file: 'split-en.wav', words: ['bob', 'pho', 'charlie', 'beer', 'water', 'three'] },
  it: { file: 'split-it.wav', words: ['bob', 'pho', 'charlie', 'birre', 'acqua', 'tre'] },
};

if (process.argv.includes('--download')) {
  const sdk = await import('@qvac/sdk');
  for (const m of [sdk.WHISPER_BASE_Q8_0, sdk.VAD_SILERO_5_1_2]) {
    console.log(`▸ downloading ${m.name}`);
    await sdk.downloadAsset({ assetSrc: m });
  }
}

const qvac = createQvacEngine({ speechLanguage: language });
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

const c = CASES[language];
// The hints the UI will pass: active travelers and the demo dinner's item labels.
const r = await ai.transcribe(new Uint8Array(readFileSync(`${dir}${c.file}`)), {
  members: ['alice', 'bob', 'charlie'],
  items: ['Pho bo', 'Bia Saigon', 'Water'],
});
if (!r.ok) {
  console.log(`✖ ${c.file}: ${r.error}`);
  process.exit(1);
}
const heard = r.data.text.toLowerCase();
const missing = c.words.filter((w) => !heard.includes(w));
console.log(
  `${missing.length === 0 ? '✓' : '✖'} ${c.file} (${language}): ${r.latencyMs} ms, "${r.data.text}"` +
    (missing.length ? ` | missing: ${missing.join(', ')}` : ''),
);
process.exit(missing.length === 0 ? 0 : 1);
