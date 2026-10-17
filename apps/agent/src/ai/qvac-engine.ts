import type { AiEngine, ChatMessage } from './engine.js';
import type { OcrBlock } from './ocr-lines.js';

// QVAC in-process (SPEC §11, docs/vendor/QVAC.md: OCR and Text generation): OCR_LATIN for the
// receipt text, QWEN3_1_7B_INST_Q4 for the JSON, both loaded once and from the local cache,
// so it works with the Wi-Fi off. The SDK is imported inside load(): if it cannot be loaded
// on this machine the agent still starts, with the AI in error (manual form).

type Sdk = typeof import('@qvac/sdk');

export interface QvacEngineOptions {
  /** Max tokens of one answer; a receipt of 40 lines fits. */
  maxTokens?: number;
}

export function createQvacEngine(opts: QvacEngineOptions = {}): AiEngine {
  let sdk: Sdk | null = null;
  let ocrId: string | null = null;
  let llmId: string | null = null;

  return {
    async load() {
      sdk = await import('@qvac/sdk');
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
  };
}
