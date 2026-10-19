import type { AiEngine, ChatMessage } from './engine.js';
import { qvacCacheDir, verifyModels } from './model-check.js';
import type { OcrBlock } from './ocr-lines.js';

// QVAC in-process (SPEC §11, docs/vendor/QVAC.md: OCR and Text generation): OCR_LATIN for the
// receipt text, QWEN3_1_7B_INST_Q4 for the JSON, both loaded once and from the local cache,
// so it works with the Wi-Fi off. The SDK is imported inside load(): if it cannot be loaded
// on this machine the agent still starts, with the AI in error (manual form).
// Speech (docs/vendor/QVAC.md: Transcription): WHISPER_BASE_Q8_0 or _SMALL_, multilingual, with the Silero
// VAD, loaded by loadSpeech() after the others; Whisper takes one language at load time.

type Sdk = typeof import('@qvac/sdk');

export interface QvacEngineOptions {
  /** Max tokens of one answer; a receipt of 40 lines fits. */
  maxTokens?: number;
  /** Language of the dictated sentence (KITTY_STT_LANGUAGE). */
  speechLanguage?: 'en' | 'it';
  /** Whisper size (KITTY_STT_MODEL): base is lighter, small hears better. */
  speechModel?: SpeechModel;
}

export type SpeechModel = 'WHISPER_BASE_Q8_0' | 'WHISPER_SMALL_Q8_0';

export function createQvacEngine(opts: QvacEngineOptions = {}): AiEngine {
  let sdk: Sdk | null = null;
  let ocrId: string | null = null;
  let llmId: string | null = null;
  let speechId: string | null = null;

  return {
    async load() {
      sdk = await import('@qvac/sdk');
      // A6: never load a model file that is not the one the SDK pins (SPEC §13 #19)
      await verifyModels([sdk.OCR_LATIN, sdk.OCR_CRAFT, sdk.QWEN3_1_7B_INST_Q4], qvacCacheDir());
      ocrId = await sdk.loadModel({
        modelSrc: sdk.OCR_LATIN,
        modelConfig: { langList: ['en'] },
      });
      llmId = await sdk.loadModel({
        modelSrc: sdk.QWEN3_1_7B_INST_Q4,
        modelConfig: { ctx_size: 4096 },
      });
    },

    async ocr(image: Uint8Array): Promise<OcrBlock[]> {
      if (sdk === null || ocrId === null) throw new Error('OCR model not loaded');
      const { blocks } = sdk.ocr({
        modelId: ocrId,
        // the SDK types `image` with bare-buffer's Buffer; a Node Buffer works the same
        image: Buffer.from(image) as unknown as Parameters<Sdk['ocr']>[0]['image'],
        options: { paragraph: false },
      });
      return (await blocks).map((b) => ({ text: b.text, bbox: b.bbox }));
    },

    async complete(messages: ChatMessage[], jsonSchema: Record<string, unknown>) {
      if (sdk === null || llmId === null) throw new Error('LLM not loaded');
      const run = sdk.completion({
        modelId: llmId,
        history: messages,
        stream: true,
        generationParams: { temp: 0, seed: 42, predict: opts.maxTokens ?? 1500 },
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: jsonSchema },
        },
      });
      const final = await run.final;
      return final.contentText || final.raw.fullText;
    },

    async loadSpeech() {
      sdk ??= await import('@qvac/sdk');
      const whisper = sdk[opts.speechModel ?? 'WHISPER_BASE_Q8_0'];
      await verifyModels([whisper, sdk.VAD_SILERO_5_1_2], qvacCacheDir());
      speechId = await sdk.loadModel({
        modelSrc: whisper,
        // explicit: the SDK infers it from a single constant, not from a union of two
        modelType: 'whisper',
        modelConfig: {
          vadModelSrc: sdk.VAD_SILERO_5_1_2,
          // wav.ts hands over the samples of the WAV, header stripped
          audio_format: 's16le',
          language: opts.speechLanguage ?? 'en',
          translate: false,
          no_timestamps: true,
          suppress_blank: true,
          suppress_nst: true,
          temperature: 0.0,
        },
      });
    },

    async transcribe(pcm: Uint8Array, prompt?: string) {
      if (sdk === null || speechId === null) throw new Error('speech model not loaded');
      return sdk.transcribe({
        modelId: speechId,
        // bare-buffer's Buffer in the SDK types, as for the OCR image
        audioChunk: Buffer.from(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength,
        ) as unknown as Parameters<Sdk['transcribe']>[0]['audioChunk'],
        ...(prompt !== undefined && { prompt }),
      });
    },
  };
}
