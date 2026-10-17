import type { OcrBlock } from './ocr-lines.js';

// What the AI service needs from the on-device runtime: QVAC in production (qvac-engine.ts),
// a scripted engine in tests. Kept this small so the retry and validation logic is testable
// without models.

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface AiEngine {
  /** Loads the models once (SPEC §11). Rejects if they cannot be loaded. */
  load(): Promise<void>;
  ocr(image: Uint8Array): Promise<OcrBlock[]>;
  /** Raw model output, constrained by `jsonSchema` when the runtime supports it. */
  complete(messages: ChatMessage[], jsonSchema: Record<string, unknown>): Promise<string>;
}
