import type { MemberId, Receipt, SplitProposal } from '@kitty/shared';
import { z } from 'zod';

// The split proposal (SPEC §11): the LLM goes through the payer's sentence one part at a time
// ("Bob got pho", "cokes for everyone") and says who that part names and which items it is
// about. Asking for each item's people instead made the 1.7B model pair parts and items
// wrongly and fill the items nobody mentioned. The schema is built per request: items as an
// enum of "0. Pho bo" keys and members as an enum, so the sampler cannot name anything else
// (prompt injection, SPEC §13 #6). The same rules are checked again after parsing.

export const itemKey = (receipt: Receipt, i: number) => `${i}. ${receipt.items[i]?.label ?? ''}`;

export function llmSplitSchema(receipt: Receipt, members: readonly MemberId[]) {
  const names = z.enum(members as [MemberId, ...MemberId[]]);
  const keys = receipt.items.map((_, i) => itemKey(receipt, i));
  const items = z.enum(keys as [string, ...string[]]);
  return z.object({
    parts: z
      .array(
        z
          .object({
            // the words of the sentence this part is about: it keeps the model on one part
            said: z.string().max(160),
            members: z.array(names).max(members.length),
            items: z.array(items).max(keys.length),
          })
          .strict(),
      )
      .max(keys.length),
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

  const indexOf = new Map(all.map((i) => [itemKey(receipt, i), i]));
  // An item named in several parts ("Bob had pho", "Charlie had pho too") is shared by all.
  const named = all.map(() => new Set<MemberId>());
  for (const part of parsed.data.parts)
    for (const key of part.items)
      for (const m of part.members) named[indexOf.get(key) ?? -1]?.add(m);

  const proposal: SplitProposal = { assignments: [], unassigned: [] };
  for (const i of all) {
    // in the order of `members`: the shares never depend on the order the model wrote
    const who = members.filter((m) => named[i]?.has(m));
    if (who.length > 0) proposal.assignments.push({ itemIndex: i, members: who });
    else proposal.unassigned.push(i);
  }
  const q = parsed.data.clarificationNeeded?.trim();
  if (q) proposal.clarificationNeeded = q;
  return { ok: true, proposal };
}
