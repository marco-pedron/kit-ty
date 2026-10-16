// Fakes are for development only (CLAUDE.md rule 2). Anything that shows the demo
// (demo:reset, e2e:demo) calls assertNoFakes() first.

export const FAKES_BANNER = 'FAKES ON: simulated wallet and AI, no real RGB transactions';

export function fakesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KITTY_FAKES === '1';
}

export function assertNoFakes(env: NodeJS.ProcessEnv = process.env): void {
  if (fakesOn(env))
    throw new Error(
      'refusing to run with KITTY_FAKES=1: the demo uses real RGB only; unset it and retry',
    );
}

/** Constructors of fakes call this, so a fake can never be built by mistake in the demo. */
export function assertFakesOn(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!fakesOn(env)) throw new Error(`${what} is a dev fake: set KITTY_FAKES=1 to use it`);
}
