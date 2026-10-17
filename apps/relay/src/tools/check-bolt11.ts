// Checks the relay's BOLT11 decoder against a live rgb-lightning-node (TODO of C1b in
// docs/status/c.md): one invoice for an asset whose id contains `_` or `~`, decoded by the
// node (/decodelninvoice) and by decodeBolt11, must give the same fields.
//
// Usage, on an unlocked node with colorable UTXOs (e.g. dave after the seed of B2):
//   pnpm --filter @kitty/relay exec tsx src/tools/check-bolt11.ts http://127.0.0.1:3004
// Regtest only. If no asset of the node has `_` or `~` in its id, it issues throwaway NIA
// assets ("Baid64 check", ticker CHK) until one does, at most 8.
// Requests as in docs/spike-lightning.md and docs/vendor/rln-openapi.yaml.
import { decodeBolt11 } from '../bolt11.js';

const node = (process.argv[2] ?? 'http://127.0.0.1:3004').replace(/\/+$/, '');
const special = (id: string) => /[_~]/.test(id);

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${node}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok || text === '')
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text || '(empty)'}`);
  return JSON.parse(text) as T;
}

interface AssetNia {
  asset_id: string;
}

async function pickAsset(): Promise<string> {
  const { nia } = await call<{ nia: AssetNia[] | null }>('POST', '/listassets', {
    filter_asset_schemas: ['Nia'],
  });
  const found = (nia ?? []).find((a) => special(a.asset_id));
  if (found) return found.asset_id;
  for (let i = 0; i < 8; i++) {
    const { asset } = await call<{ asset: AssetNia }>('POST', '/issueassetnia', {
      amounts: [1000],
      ticker: 'CHK',
      name: 'Baid64 check',
      precision: 2,
    });
    console.log(`issued ${asset.asset_id}`);
    if (special(asset.asset_id)) return asset.asset_id;
  }
  throw new Error('8 issued assets and none has _ or ~ in its id (odds ≈ 1 in 60k): run again');
}

const { pubkey } = await call<{ pubkey: string }>('GET', '/nodeinfo');
const assetId = await pickAsset();
const { invoice } = await call<{ invoice: string }>('POST', '/lninvoice', {
  amt_msat: 3000000,
  expiry_sec: 3600,
  asset_id: assetId,
  asset_amount: 309,
  description: 'kitty:check:baid64:alice',
});
const n = await call<{
  amt_msat: number | null;
  expiry_sec: number;
  timestamp: number;
  asset_id: string | null;
  asset_amount: number | null;
  description: string | null;
  payment_hash: string;
  payee_pubkey?: string;
}>('POST', '/decodelninvoice', { invoice });
const ours = decodeBolt11(invoice);

const rows: [string, unknown, unknown][] = [
  ['payeePubkey', n.payee_pubkey ?? pubkey, ours.payeePubkey],
  ['paymentHash', n.payment_hash, ours.paymentHash],
  ['assetId', n.asset_id, ours.assetId],
  // The point of the check: the invoice must be for the asset with `_` or `~` we asked for.
  ['requested asset', assetId, ours.assetId],
  ['cents', n.asset_amount === null ? null : BigInt(n.asset_amount), ours.cents],
  ['amtMsat', n.amt_msat === null ? null : BigInt(n.amt_msat), ours.amtMsat],
  ['description', n.description ?? '', ours.description],
  ['expiresAt', new Date((n.timestamp + n.expiry_sec) * 1000).toISOString(), ours.expiresAt],
];
let ok = true;
for (const [field, theirs, mine] of rows) {
  const same = theirs === mine;
  ok &&= same;
  console.log(`${same ? 'OK  ' : 'DIFF'} ${field}: node=${String(theirs)} relay=${String(mine)}`);
}
console.log(`\ninvoice: ${invoice}\nnode /decodelninvoice: ${JSON.stringify(n)}`);
console.log(ok ? '\nPASS: decodeBolt11 matches the node' : '\nFAIL: see DIFF lines above');
process.exitCode = ok ? 0 : 1;
