// htlc-tool runner (kaleidoswap rgb-lib fork, see htlc-tool/) and the RLN side of an RGB HTLC.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mine, post, rawTx, refresh, PROXY_ENDPOINT, type Member } from './lib.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS = join(ROOT, 'run', 'wallets');
const NETWORK = process.env.KK_NETWORK ?? 'kitty-kaleido_default';
const IMAGE = process.env.KK_HTLC_IMAGE ?? 'kitty/htlc-tool:dev';
export const HTLC_SAT = 1000;

export class ToolError extends Error {}

/** Runs one htlc-tool command in a container on the experiment network; returns its JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tool(cmd: string, args: Record<string, string | number | boolean> = {}): any {
  mkdirSync(WALLETS, { recursive: true });
  const argv = Object.entries(args).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)]));
  let out: string;
  try {
    out = execFileSync('docker', ['run', '--rm', '--network', NETWORK, '-v', `${WALLETS}:/wallets`, IMAGE, cmd, ...argv], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
    const last = out.trim().split('\n').pop() ?? '';
    throw new ToolError(`htlc-tool ${cmd}: ${last || (e as Error).message}`);
  }
  return JSON.parse(out.trim().split('\n').pop()!);
}

export interface HtlcTerms {
  hash: string; // sha256(P), the Lightning payment hash
  claim: string; // x-only key of the claimer (dave)
  refund: string; // x-only key of the locker (the traveler)
  timeout: number; // absolute block height of the refund leaf (T_onchain)
}
export function htlcInfo(t: HtlcTerms): { script_pubkey: string; address: string; recipient_id: string } {
  return tool('htlc', { ...t });
}

/** The locker's RLN node sends `amount` of the asset to the HTLC output (witness recipient). */
export async function lockFromRln(m: Member, p: { assetId: string; amount: number; recipientId: string; blinding: number }) {
  const { txid } = await post(m, '/sendrgb', {
    donation: true,
    fee_rate: 5,
    min_confirmations: 1,
    expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
    recipient_map: {
      [p.assetId]: [
        {
          recipient_id: p.recipientId,
          witness_data: { amount_sat: HTLC_SAT, blinding: p.blinding },
          assignment: { type: 'Fungible', value: p.amount },
          transport_endpoints: [PROXY_ENDPOINT],
        },
      ],
    },
  });
  return txid;
}

/** vout of the output paying `scriptPubkey` in a confirmed tx. */
export async function voutOf(txid: string, scriptPubkey: string): Promise<number> {
  const tx = (await rawTx(txid)) as unknown as { vout: { n: number; scriptPubKey: { hex: string }; value: number }[] };
  const o = tx.vout.find((v) => v.scriptPubKey.hex === scriptPubkey);
  if (!o) throw new Error(`tx ${txid} has no output to the HTLC`);
  return o.n;
}

/** An RLN node's blinded RGB invoice for `amount` of the asset (on-chain receive). */
export async function rlnRgbInvoice(m: Member, assetId: string, amount: number): Promise<string> {
  // no asset_id: a node that never saw the contract answers UnknownContractId (first receive)
  void assetId;
  const r = await post(m, '/rgbinvoice', {
    min_confirmations: 1,
    asset_id: null,
    assignment: { type: 'Fungible', value: amount },
    expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
    witness: false,
    transport_endpoints: [PROXY_ENDPOINT],
  });
  return r.recipient_id;
}

/** On-chain RGB transfer between RLN nodes (the on-ramp): blinded invoice, donation send. */
export async function rlnSend(from: Member, to: Member, assetId: string, amount: number): Promise<string> {
  const rid = await rlnRgbInvoice(to, assetId, amount);
  const { txid } = await post(from, '/sendrgb', {
    donation: true,
    fee_rate: 5,
    min_confirmations: 1,
    expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
    recipient_map: { [assetId]: [{ recipient_id: rid, assignment: { type: 'Fungible', value: amount }, transport_endpoints: [PROXY_ENDPOINT] }] },
  });
  await mine(1);
  await refresh(to);
  await refresh(from);
  return txid;
}
