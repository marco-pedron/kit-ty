// Clean-up of raw LLM output before JSON.parse (SPEC §11): Qwen3 may emit a <think>…</think>
// block (often empty) and wrap the JSON in a code fence.

export function stripLlmNoise(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/u.exec(s);
  if (fence) s = (fence[1] ?? '').trim();
  return s;
}

/** The JSON value in the output, or an error message to feed back to the model. */
export function parseLlmJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const s = stripLlmNoise(raw);
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: `the output is not valid JSON (${(e as Error).message})` };
  }
}
