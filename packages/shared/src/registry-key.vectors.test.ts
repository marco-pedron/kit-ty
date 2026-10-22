import { describe, expect, it } from 'vitest';
import { sha256Hex } from './canonical.js';
import { registryKey, seedFromMnemonic } from './registry-key.js';

// Official NIP-06 vectors, downloaded at every run (not kept in the repo): the text of NIP-06
// at a pinned commit of nostr-protocol/nips, accepted only if its sha256 is the one pinned
// here (NIP-06 publishes no checksum). Without network the suite is skipped with a warning; an
// HTTP error or a wrong checksum still fails.
const NIP06_URL =
  'https://raw.githubusercontent.com/nostr-protocol/nips/5491bd5c6311456964e1126d66d28b73d6f1781a/06.md';
const NIP06_SHA256 = 'a7d86f43c3723b7a67765e81910a2478007d4655024e2899a163a09e2c834b3a';

class OfflineError extends Error {}

async function download(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new OfflineError(`cannot download ${url}`, { cause: e });
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadSpec(): Promise<string | null> {
  try {
    const text = await download(NIP06_URL);
    if (sha256Hex(text) !== NIP06_SHA256)
      throw new Error(`${NIP06_URL} does not match the pinned sha256`);
    return text;
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    process.stderr.write(`\nWARNING: NIP-06 vector tests skipped, no network (${e.message})\n`);
    return null;
  }
}

/** The "Test vectors" of NIP-06: mnemonic, private key (hex), public key (hex), account 0. */
function vectorsOf(spec: string): { mnemonic: string; secret: string; pubkey: string }[] {
  const re =
    /mnemonic: ([a-z ]+)\\?\s+private key \(hex\): ([0-9a-f]{64})\\?\s+nsec: \S+\s+public key \(hex\): ([0-9a-f]{64})/g;
  return [...spec.matchAll(re)].map((m) => ({
    mnemonic: m[1] ?? '',
    secret: m[2] ?? '',
    pubkey: m[3] ?? '',
  }));
}

const spec = await loadSpec();

describe('NIP-06 derivation on the official vectors (needs network)', () => {
  if (spec === null) {
    it.skip('no network: NIP-06 not downloaded, suite skipped', () => {});
    return;
  }
  const vectors = vectorsOf(spec);

  it('uses the pinned text of NIP-06, with its two vectors', () => {
    expect(sha256Hex(spec)).toBe(NIP06_SHA256);
    expect(vectors).toHaveLength(2);
  });

  it.each(vectors)('account 0 of "$mnemonic"', (v) => {
    const key = registryKey(seedFromMnemonic(v.mnemonic), 0);
    expect(key.secret).toBe(v.secret);
    expect(key.pubkey).toBe(v.pubkey);
  });
});
