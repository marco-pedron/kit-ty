// Dave's on-chain treasury: @utexo/wdk-wallet-rgb 2.0.3 (rgb-lib), Node 22 only.
// It issues DUSD and does the on-ramp to the RLN nodes (SPEC §14.0). Its mnemonic is its
// own: RLN also uses rgb-lib, so reusing a node's mnemonic could derive the same wallet.
import { mkdirSync } from 'node:fs';
import WalletManagerRgb from '@utexo/wdk-wallet-rgb';
import {
  INDEXER_HOST,
  PROXY_HOST,
  PROXY_INTERNAL,
  TREASURY_DATA_DIR,
  type Member,
  log,
  mine,
  rln,
  sleep,
  waitFor,
} from './lib.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the package's account type is loose JS
type Account = any;

export function newTreasuryMnemonic(): string {
  return WalletManagerRgb.getRandomSeedPhrase(12);
}

export async function openTreasury(mnemonic: string) {
  mkdirSync(TREASURY_DATA_DIR, { recursive: true });
  const manager = new WalletManagerRgb(mnemonic, {
    network: 'regtest',
    indexerUrl: INDEXER_HOST,
    transportEndpoint: PROXY_HOST,
    dataDir: TREASURY_DATA_DIR,
  });
  const account: Account = await manager.getAccount();
  return {
    account,
    dispose() {
      // dispose() throws "Invalid checksum" on regtest (docs/vendor/wdk-wallet-rgb.md)
      try {
        manager.dispose();
      } catch {
        /* expected */
      }
    },
  };
}

/**
 * The RLN invoice names the proxy by its compose address (proxy:3000), which the host cannot
 * resolve. The treasury sends to the same proxy through 127.0.0.1:3000 instead. Deviation from
 * the verified parameters, approved by the PM (docs/status/b.md, B2).
 */
export function invoiceForHost(invoice: string): string {
  return invoice.split(PROXY_INTERNAL).join(PROXY_HOST);
}

interface AssetBalance {
  settled: number;
  future: number;
  spendable: number;
  offchain_outbound: number;
  offchain_inbound: number;
}

export async function assetBalance(m: Member, assetId: string): Promise<AssetBalance> {
  return rln<AssetBalance>(m, '/assetbalance', { asset_id: assetId });
}

async function refresh(m: Member): Promise<void> {
  await rln(m, '/refreshtransfers', { asset_id: null, filter: [], skip_sync: false });
}

/**
 * Sends `amount` DUSD units from the treasury to a new blinded allocation on `to`'s RLN node,
 * and waits until it is settled there. One transfer at a time: the treasury's change is locked
 * until the transfer is confirmed (docs/vendor/wdk-wallet-rgb.md).
 */
export async function onramp(
  treasury: Account,
  assetId: string,
  to: Member,
  amount: number,
): Promise<string> {
  const before = await assetBalance(to, assetId)
    .then((b) => b.settled)
    .catch(() => 0);
  const { invoice } = await rln<{ invoice: string }>(to, '/rgbinvoice', {
    min_confirmations: 1,
    asset_id: null,
    assignment: null,
    witness: false,
    expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
    transport_endpoints: [PROXY_INTERNAL],
  });
  const res = await treasury.transfer({
    recipient: invoiceForHost(invoice),
    token: assetId,
    amount,
    feeRate: 2,
    minConfirmations: 1,
  });
  const txid: string = res.hash;
  // receiver ACKs the consignment, then the sender broadcasts; then confirm and settle both
  await sleep(1000);
  await refresh(to);
  treasury.refreshWallet();
  mine(1);
  await waitFor(
    `${amount} DUSD units settled on ${to}`,
    async () => {
      await refresh(to);
      treasury.refreshWallet();
      const b = await assetBalance(to, assetId);
      if (b.settled >= before + amount) return true;
      mine(1);
      return false;
    },
    { timeoutMs: 90_000, everyMs: 1500 },
  );
  log('onramp', { to, amount, txid });
  return txid;
}
