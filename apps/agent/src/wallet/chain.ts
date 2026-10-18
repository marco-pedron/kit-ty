import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The regtest chain as dave's wallet sees it when it closes channels (task B7): a miner, and
// the esplora REST server the proofs link to (/tx/<txid>). Regtest only (CLAUDE.md rule 9).

export interface Miner {
  /** Mines `blocks` regtest blocks; returns the new height. */
  mine(blocks: number): Promise<number>;
}

const execFileP = promisify(execFile);
const composeFile =
  process.env.KITTY_COMPOSE_FILE ??
  fileURLToPath(new URL('../../../../infra/docker-compose.yml', import.meta.url));

/**
 * The same command as infra/scripts/mine.sh and infra/treasury/lib.ts: bitcoin-cli inside the
 * bitcoind container, miner wallet. No RPC credentials leave the container.
 */
export const dockerMiner: Miner = {
  async mine(blocks) {
    if (!Number.isSafeInteger(blocks) || blocks <= 0) throw new Error(`bad block count ${blocks}`);
    const cli = ['compose', '-f', composeFile, 'exec', '-T', '-u', 'blits', 'bitcoind'];
    const bcli = [...cli, 'bitcoin-cli', '-regtest'];
    await execFileP('docker', [...bcli, '-rpcwallet=miner', '-generate', String(blocks)]);
    const { stdout } = await execFileP('docker', [...bcli, 'getblockcount']);
    return Number(stdout.trim());
  },
};

export type EsploraTx = {
  txid: string;
  vout: { value: number; scriptpubkey_type: string }[];
  status: { confirmed: boolean; block_height?: number };
};
export type EsploraOutspend = { spent: boolean; txid?: string; status?: { confirmed: boolean } };

export interface Esplora {
  readonly baseUrl: string;
  /** null when esplora does not know the tx (404). */
  tx(txid: string): Promise<EsploraTx | null>;
  outspends(txid: string): Promise<EsploraOutspend[]>;
  tipHeight(): Promise<number>;
}

export function createEsplora(
  baseUrl: string,
  fetchFn: (input: Request) => Promise<Response> = (r) => fetch(r),
): Esplora {
  const base = baseUrl.replace(/\/+$/u, '');
  const get = async (path: string): Promise<Response> => {
    const res = await fetchFn(new Request(`${base}${path}`));
    if (!res.ok && res.status !== 404) throw new Error(`esplora ${path}: HTTP ${res.status}`);
    return res;
  };
  return {
    baseUrl: base,
    async tx(txid) {
      const res = await get(`/tx/${txid}`);
      return res.status === 404 ? null : ((await res.json()) as EsploraTx);
    },
    async outspends(txid) {
      const res = await get(`/tx/${txid}/outspends`);
      if (res.status === 404) throw new Error(`esplora does not know tx ${txid}`);
      return (await res.json()) as EsploraOutspend[];
    },
    async tipHeight() {
      const n = Number((await (await get('/blocks/tip/height')).text()).trim());
      if (!Number.isSafeInteger(n)) throw new Error('esplora returned no tip height');
      return n;
    },
  };
}

/** The link the UI shows for a closing tx (SPEC §16 step 6). */
export const explorerTxUrl = (esplora: Esplora, txid: string): string =>
  `${esplora.baseUrl}/tx/${txid}`;
