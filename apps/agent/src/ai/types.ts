// On-device AI (SPEC §11), QVAC in-process, loaded once at agent start: ai-service.ts over
// qvac-engine.ts (task A4); dev-fakes/fake-ai.ts with KITTY_FAKES=1.
import type {
  AiResult,
  AiStatus,
  MemberId,
  Receipt,
  SplitProposal,
  Transcript,
} from '@kitty/shared';

export interface AiService {
  /** Models load once: loading → ready | error. Shown in UI as "Runs on this device". */
  status(): AiStatus['status'];

  /**
   * Image → QVAC OCR → LLM → ReceiptSchema; at most 2 attempts with the zod error fed back,
   * then `ok: false` with what was parsed (pre-filled manual form). Strip code fences and the
   * empty `<think></think>` of Qwen3. The receipt text is untrusted data, never instructions.
   *
   * Rule the prompt must state (task A4): `quantity` is a whole number. For items sold by weight
   * or volume ("0.73 kg"): quantity = 1, the measure in the label ("Bananas (0.73 kg)"),
   * unitPrice = the line total. The split always uses the line total, never quantity.
   */
  extractReceipt(image: Uint8Array): Promise<AiResult<Receipt>>;

  /**
   * Items + names of the active travelers (never dave, never excluded) + a sentence in Italian
   * or English → SplitProposal. A name not in `members` or an index out of range is a
   * validation error → retry → `ok: false`. `clarification` answers a previous
   * clarificationNeeded, passed back once. The sentence is untrusted data (SPEC §11, §13 #6).
   * `payer` is who "I" / "io" means in the sentence.
   */
  proposeSplit(
    receipt: Receipt,
    members: MemberId[],
    text: string,
    clarification?: { question: string; answer: string },
    payer?: MemberId,
  ): Promise<AiResult<SplitProposal>>;

  /**
   * The speech model loads on its own, after the others: a missing Whisper never takes the
   * receipt or the split down. The dictation button shows only when this is 'ready'.
   */
  speechStatus(): AiStatus['status'];

  /**
   * WAV (PCM16, mono, 16 kHz, ≤ 30 s) → Whisper → the sentence, for the payer to read and edit
   * before proposeSplit. The text is untrusted data like a typed sentence (SPEC §13 #6): it moves
   * no money. `members` are the active travelers, a hint so their names are spelled right.
   * A format refused, silence or a model error → `ok: false`; the payer types instead.
   */
  transcribe(audio: Uint8Array, members?: MemberId[]): Promise<AiResult<Transcript>>;
}
