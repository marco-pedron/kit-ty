// RLN node setup steps shared by the on-ramp check and the seed.
import { randomBytes } from 'node:crypto';
import {
  type Member,
  type Secrets,
  RlnError,
  fund,
  log,
  rln,
  saveSecrets,
  unlockBody,
  waitFor,
} from './lib.ts';

/** /init with a fresh random password (or RLN_<NAME>_PASSWORD), then /unlock. */
export async function initAndUnlock(m: Member, secrets: Secrets): Promise<string> {
  const password =
    process.env[`RLN_${m.toUpperCase()}_PASSWORD`] || randomBytes(24).toString('hex');
  try {
    const { mnemonic } = await rln<{ mnemonic: string }>(m, '/init', { password });
    secrets.nodes[m] = { password, mnemonic };
    saveSecrets(secrets);
  } catch (e) {
    if (e instanceof RlnError && e.rlnName === 'AlreadyInitialized')
      throw new Error(
        `${m} is already initialized: run \`pnpm demo:reset\` to start from scratch`,
        {
          cause: e,
        },
      );
    throw e;
  }
  await unlock(m, password);
  const { pubkey } = await rln<{ pubkey: string }>(m, '/nodeinfo');
  log('node ready', { member: m, pubkey });
  return pubkey;
}

/** /unlock; an already unlocked node counts as success. */
export async function unlock(m: Member, password: string): Promise<void> {
  try {
    await rln(m, '/unlock', unlockBody(m, password));
  } catch (e) {
    if (e instanceof RlnError && e.rlnName === 'AlreadyUnlocked') return;
    throw e;
  }
}

export async function fundNode(m: Member, btc: string): Promise<void> {
  const { address } = await rln<{ address: string }>(m, '/address', {});
  fund(address, btc);
}

/**
 * Colorable UTXOs. The base call (`size` null) is the body verified in spike 1. RLN funds
 * channels from the colored wallet, so 1,000,000-sat channels also need big UTXOs: those use
 * `up_to: false` and an explicit `size` (approved deviation, docs/status/b.md, B2).
 */
export async function createUtxos(
  m: Member,
  num: number,
  size: number | null = null,
): Promise<void> {
  await waitFor(
    `${m} /createutxos`,
    async () => {
      await rln(m, '/createutxos', {
        up_to: size === null,
        num,
        size,
        fee_rate: 5,
        skip_sync: false,
      });
      return true;
    },
    { timeoutMs: 30_000, everyMs: 2000 },
  );
}
