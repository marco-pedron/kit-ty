// demo:reset refuses fakes (CLAUDE.md rule 2). Uses the agent's own assertNoFakes(): guard.ts
// has no imports and only erasable types, so Node 22 type stripping can load it as is.
export async function assertNoFakesFromAgent(): Promise<void> {
  const { assertNoFakes } = await import('../../apps/agent/src/dev-fakes/guard.ts');
  assertNoFakes();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await assertNoFakesFromAgent();
  } catch (e) {
    console.error(`ERR: ${(e as Error).message}`);
    process.exit(1);
  }
}
