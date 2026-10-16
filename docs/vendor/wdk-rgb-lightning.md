# @utexo/wdk-rgb-lightning `0.1.0-beta.15` (+ `@utexo/rgb-lightning-node-nodejs` `0.1.0-beta.11`)

> Estratto dai `.d.ts` e dai sorgenti in `node_modules` (`index.d.ts`, `src/node-binding.js`, `src/wallet-account-rgb-lightning.js`, `src/wallet-manager-rgb-lightning.js`) e dal README del pacchetto, più quello che lo spike 2 ha verificato su regtest (`spikes/wdk/`, `docs/spike-wdk.md`). **Solo i metodi qui sotto sono stati provati.** Per tutto il resto fanno fede i `.d.ts`.
>
> Il binario nativo `0.1.0-beta.11` è compilato su **RLN `UTEXO-Protocol/rgb-lightning-node` `v0.10.0-beta.3`** (note della release GitHub). I body delle richieste seguono l'`openapi.yaml` di quel tag, che per i campi che usiamo coincide con `docs/vendor/rln-openapi.yaml`.

## Installazione (macOS arm64, verificata)
```json
"@utexo/wdk-rgb-lightning": "0.1.0-beta.15",
"@utexo/rgb-lightning-node-nodejs": "0.1.0-beta.11"
```
Il `postinstall` di `rgb-lightning-node-nodejs` scarica `index-darwin-arm64.node` dalla release GitHub e funziona su Node 22 e 24. Il binario è N-API: un nodo per `SdkNode` e un runtime tokio per nodo.

## Costruttore e sblocco
```js
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'

const manager = new WalletManagerRgbLightning(mnemonic /* BIP-39 */, {
  network: 'regtest',                 // obbligatorio
  dataDir: '/abs/path/<member>/ln',   // obbligatorio, una per nodo
  ldkPeerListeningPort: 9835,         // 0 = effimera; noi una porta fissa per membro
  // daemonListeningPort: 0,          // non serve in modalità SDK
  // enableVirtualChannelsV0: true,   // SOLO dave, vedi "Trappole"
  // vssUrl: 'http://127.0.0.1:8081/vss', vssAllowHttp: true,  // VSS, vedi sotto
})
const account = await manager.getAccount(0)   // solo l'indice 0
await account.unlock({
  bitcoind_rpc_username: 'user',
  bitcoind_rpc_password: 'password',
  bitcoind_rpc_host: '127.0.0.1',
  bitcoind_rpc_port: 18443,
  indexer_url: 'tcp://127.0.0.1:50001',          // electrs
  proxy_endpoint: 'rpc://127.0.0.1:3000/json-rpc',
  announce_addresses: [],
  announce_alias: 'alice'
})                                                // → { ok: true }; nessuna password: firmatore esterno VLS
const { pubkey } = await account.getNodeInfo()   // node id, 33 byte hex
```
- Il nodo deriva l'identità dai primi 32 byte del seed BIP-39 (`wdkSeedToNodeSeedHex`), stessa mnemonica → stesso `pubkey`.
- Sblocco in circa 0,4 s per nodo. **4 manager nello stesso processo Node funzionano** (porte peer diverse).
- Spegnimento: `manager.dispose()` spegne il nodo ma poi **lancia un'eccezione** (`attachExternalSigner(seedHex) must be called before bootstrap()`), perché `WalletManager.dispose` legge `keyPair` dopo lo shutdown. Va avvolto in `try {} catch {}`.

## Metodi usati (tutti `async`; le chiamate native sono **sincrone** e bloccano l'event loop per la loro durata)

| Metodo | Richiesta (esatta) | Risposta osservata |
|---|---|---|
| `getNodeInfo()` | — | `{ pubkey, num_channels, num_usable_channels, local_balance_sat, num_peers, rgb_htlc_min_msat: 3000000, rgb_channel_capacity_min_sat: 30010, channel_capacity_max_sat: 16777215, network_nodes, network_channels, account_xpub_vanilla, account_xpub_colored, … }` |
| `getAddress()` | — | indirizzo `bcrt1p…` (vanilla, riusato) |
| `sync()` | — | `{ ok: true }` |
| `getBalanceDetails(skipSync)` | `false` | `{ vanilla: {settled,future,spendable}, colored: {…} }` in sat |
| `listUnspents(skipSync)` | `false` | `[{ utxo: { outpoint, btc_amount, colorable }, rgb_allocations: [{ asset_id, assignment, settled }] }]` |
| `createUtxos(req)` | `{ up_to: false, num: 4, size: 1_100_000, fee_rate: 2, skip_sync: false }` | `{ ok: true }` (UTXO **colorati**) |
| `createRgbInvoice(req)` | `{ min_confirmations: 1, witness: false, duration_seconds: 3600 }` (senza `asset_id` se il nodo non conosce ancora l'asset) | `{ recipient_id, invoice: 'rgb:~/~/~/bcrt:utxob:…?expiry=…&endpoints=rpc://…', expiration_timestamp, batch_transfer_idx }` |
| `refreshTransfers(req)` | `{ skip_sync: false }` | `{ ok: true }` |
| `getAssetBalance(assetId)` | `'rgb:…'` | `{ settled, future, spendable, offchain_outbound, offchain_inbound }` |
| `listAssets()` | — | `{ nia: [{ asset_id, ticker, precision, balance: {…} }], uda: [], cfa: [], ifa: [] }` |
| `connectPeer(uri)` | `'<pubkey>@127.0.0.1:<port>'` | `{ ok: true }` (`Conflict` se già connesso: ignorato) |
| `openChannel(req)` | `{ peer_pubkey_and_opt_addr, capacity_sat: 1_000_000, push_msat: 200_000_000, asset_id, asset_amount: 8000, push_asset_amount: 5000, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 }` | `{ temporary_channel_id }` |
| `listChannels()` | — | array di `{ channel_id, peer_pubkey, status: 'Opening'|'Opened', ready, is_usable, public, capacity_sat, local_balance_sat, outbound_balance_msat, inbound_balance_msat, next_outbound_htlc_limit_msat, next_outbound_htlc_minimum_msat, funding_txid, short_channel_id, asset_id, asset_local_amount, asset_remote_amount }` |
| `createInvoice(req)` | `{ amt_msat: 3_000_000, expiry_sec: 3600, asset_id, asset_amount: 309 }` | `{ invoice: 'lnbcrt30u1…' }` |
| `decodeInvoice(bolt11)` | — | `{ amt_msat, expiry_sec, timestamp, asset_id, asset_amount, payment_hash, payment_secret, payee_pubkey, network }`. **Nessun campo `description`** (non provato a passarla nella richiesta). |
| `sendPayment(req)` | `{ invoice }` | `{ payment_id, payment_hash, payment_secret, status: 'Pending'|'Failed' }` |
| `getPayment(hash, type)` | `type`: `'Outbound'` (pagatore) o `'InboundAutoClaim'` (ricevente); i vecchi `sent`/`received` non esistono più | `{ amt_msat, asset_amount, asset_id, payment_hash, payment_type, status: 'Pending'|'Succeeded'|'Failed', payee_pubkey, preimage, created_at, updated_at }` |
| `closeChannel(req)` | `{ channel_id, peer_pubkey, force: false }` | `{ ok: true }`; subito dopo un pagamento può dare `Rln(Conflict): Cannot begin shutdown while … waiting on a monitor update`: riprovare dopo 3 s |
| `sign(message)` | stringa | firma zbase32 (104 caratteri) |
| `verify(message, signature)` | — | `boolean`; verifica contro la chiave di **questo** nodo |
| `vssBackup()` | — | `{ version }` (vedi `docs/spike-wdk.md`) |
| `vssStatus()` | — | `{ configured, url, allowHttp, lastBackupVersion }` (solo stato locale) |
| `clearVssFence(password)` | stringa | `{ ok: true }` |

## Firma dei messaggi (formato verificato)
`account.sign(msg)` = `lightning::util::message_signing::sign`: zbase32 di 65 byte `[31 + recid, r(32), s(32)]`, ECDSA ricuperabile secp256k1 su `sha256(sha256("Lightning Signed Message:" + msg))`. Si verifica ricuperando la pubkey e confrontandola con il `nodePubkey`. Implementazione in TypeScript puro: `spikes/wdk/verify.ts` (`@noble/curves` `1.9.7`, `@noble/hashes` `1.8.0`). A differenza di `/signmessage` REST di RLN `d4762ac`, **firma davvero il messaggio**.

## Trappole (tutte osservate)
1. **I canali RGB si finanziano dalla wallet colorata.** `openChannel` fa un `rgb_send_begin` con `witness_data.amount_sat = capacity_sat`, quindi serve `colored.spendable ≥ capacity_sat`. I `createUtxos` di default fanno UTXO da 20.000 sat, e con canali da 1.000.000 sat l'errore è `Rln(NoAvailableUtxos)` (fuorviante). Rimedio: `createUtxos({ up_to: false, num, size: 1_100_000, … })`.
2. **Un'allocazione di DUSD = un'apertura per blocco.** Il resto torna spendibile solo dopo 2-3 blocchi (`Rln(Conflict): Not enough assets`). Rimedio: dare a dave più allocazioni (più trasferimenti on-chain separati).
3. **Il firmatore VLS non firma `channel_announcement`** (`ERROR Signer rejected channel_announcement signing. Channel will not be announced!` nei log LDK). Nessun canale finisce nel grafo (`network_channels: 0`) e un pagamento a 2 salti fallisce subito (`Failed`) con canali `public: true`.
4. Servono quindi canali privati e route hint, ma **in modalità SDK l'inoltro verso canali privati si attiva solo con `enableVirtualChannelsV0: true`** (`accept_forwards_to_priv_channels = config || enable_virtual_channels_v0`; il `config.toml` lo legge solo il daemon CLI). Con quel flag il nodo **rifiuta ogni canale in ingresso non virtuale** (`unsupported_scid_alias`). Conseguenza: **dave apre tutti i canali** (forma `ln-lsp` di SPEC §10.4).
5. In un canale aperto da dave il viaggiatore ha 0 sat: non può pagare (ogni HTLC RGB richiede 3000 sat del pagatore) e alla chiusura non ha un output per i suoi DUSD. Rimedio: `push_msat` (es. 200.000.000 = 200.000 sat ≈ 66 pagamenti in uscita).
6. **Lo stato del firmatore VLS sta solo in memoria** (`NativeExternalSigner.create(seedHex, network, policy)`, senza storage; il `new_with_storage` di upstream non è esposto in `0.1.0-beta.11`). Dopo un riavvio del processo, i canali aperti prima non chiudono in modo cooperativo (si fermano dopo `shutdown`) e un nodo è finito in `rgb-lib inconsistency detected: spent bitcoins with another wallet` allo sblocco. **Non riavviare un nodo con canali aperti.**
7. **Dopo una chiusura cooperativa i DUSD non tornano on-chain.** La tx di chiusura si conferma, ma gli output restano non spesi dopo 14 blocchi (`src/rgb_sweep.rs` non esiste a `v0.10.0-beta.3`).
8. `manager.dispose()` lancia un'eccezione dopo lo shutdown (vedi sopra).

## VSS (domanda 9 dello spike)
- Server locale: `spikes/wdk/vss/` (`lightningdevkit/vss-server@e4c8359`, feature `sigs`, Postgres 16), URL `http://127.0.0.1:8081/vss`, nel manager `vssUrl` + `vssAllowHttp: true`.
- `vssBackup()` → `{ version }` in circa 60 ms, a nodo acceso.
- Ripristino: stessa mnemonica, `dataDir` vuota, stesso `vssUrl`. `clearVssFence(password)` prima di `unlock` dà `Rln(NotInitialized)`, perché il manager WDK fa init e unlock insieme dentro `unlock()`. Con l'init fatto a mano il fence si toglie, ma `unlock` **si blocca** subito dopo aver caricato il canale da VSS. Non è usabile con `0.1.0-beta.15`/`0.1.0-beta.11`.
