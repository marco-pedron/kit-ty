import type { MemberId, Receipt, SplitProposal } from '@kitty/shared';
import { z } from 'zod';

// The split proposal (SPEC §11): the LLM says who shares each item. The schema is built per
// request: one key per item ("0. Pho bo"), so the model goes through every item in order, and
// the members as an enum, so the sampler cannot name anyone else (prompt injection,
// SPEC §13 #6). The same rules are checked again after parsing.

export const itemKey = (receipt: Receipt, i: number) => `${i}. ${receipt.items[i]?.label ?? ''}`;

export function llmSplitSchema(receipt: Receipt, members: readonly MemberId[]) {
  const names = z.enum(members as [MemberId, ...MemberId[]]);
  const shape: Record<string, z.ZodArray<typeof names>> = {};
  receipt.items.forEach((_, i) => {
    shape[itemKey(receipt, i)] = z.array(names).max(members.length);
  });
  return z.object({
    items: z.object(shape).strict(),
    clarificationNeeded: z.string().max(200).nullable(),
  });
}

export function llmSplitJsonSchema(receipt: Receipt, members: readonly MemberId[]) {
  return z.toJSONSchema(llmSplitSchema(receipt, members), { target: 'draft-7' });
}

type Conversion =
  | { ok: true; proposal: SplitProposal }
  | { ok: false; error: string; partial: Partial<SplitProposal> };

/** LLM output (already JSON) → SplitProposal, or the error to feed back to the model. */
export function toSplitProposal(
  value: unknown,
  receipt: Receipt,
  members: readonly MemberId[],
): Conversion {
  const all = receipt.items.map((_, i) => i);
  const parsed = llmSplitSchema(receipt, members).safeParse(value);
  if (!parsed.success)
    return { ok: false, error: z.prettifyError(parsed.error), partial: { unassigned: all } };

  const byItem = parsed.data.items as Record<string, MemberId[] | undefined>;
  const proposal: SplitProposal = { assignments: [], unassigned: [] };
  for (const i of all) {
    // in the order of `members`: the shares never depend on the order the model wrote
    const named = new Set(byItem[itemKey(receipt, i)] ?? []);
    const who = members.filter((m) => named.has(m));
    if (who.length > 0) proposal.assignments.push({ itemIndex: i, members: who });
    else proposal.unassigned.push(i);
  }
  const q = parsed.data.clarificationNeeded?.trim();
  if (q) proposal.clarificationNeeded = q;
  return { ok: true, proposal };
}
