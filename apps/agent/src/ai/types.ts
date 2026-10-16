// On-device AI (SPEC §11), QVAC in-process, loaded once at agent start. Task A4;
// dev-fakes/fake-ai.ts stands in until then (KITTY_FAKES=1).
import type { AiResult, AiStatus, MemberId, Receipt, SplitProposal } from '@kitty/shared';

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
   */
  proposeSplit(
    receipt: Receipt,
    members: MemberId[],
    text: string,
    clarification?: { question: string; answer: string },
  ): Promise<AiResult<SplitProposal>>;
}
