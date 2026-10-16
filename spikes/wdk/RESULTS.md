# Spike 2: motore WDK, risultati

Data: venerdì 16/10/2026, 15:48–16:35 CEST. Branch `b/B0b-spike-wdk`, cartella `spikes/wdk/`. Mac arm64, Docker con 4 GB, stack regtest del vecchio repo (`settleup`: bitcoind, electrs, esplora, proxy; **container RLN spenti**).
Versioni: `@utexo/wdk-rgb-lightning` **`0.1.0-beta.15`**, `@utexo/rgb-lightning-node-nodejs` **`0.1.0-beta.11`** (compilato su RLN `UTEXO-Protocol/rgb-lightning-node` **`v0.10.0-beta.3`**), `@utexo/wdk-wallet-rgb` **`2.0.3`** (`@utexo/rgb-sdk` 1.0.3 → `@utexo/rgb-lib` 0.3.0-beta.8). Riferimenti API: `docs/vendor/wdk-rgb-lightning.md`, `docs/vendor/wdk-wallet-rgb.md`.
Log di ogni passo (senza segreti): `spikes/wdk/calls.log`. Mnemoniche in `spikes/wdk/.secrets*` (gitignored).

## Verdetto

**Motore consigliato: `rln-rest`**, con una sola eccezione WDK: `@utexo/wdk-wallet-rgb` per emissione e on-ramp dei DUSD di dave (motore **misto**, vedi sotto).

Alla lettera, le domande 5 e 6 sono verdi tra nodi `wdk` (canali da 1.000.000 sat e pagamento alice → dave → bob in 4,4 s con preimage). Però lo sono **solo** in una forma che rompe tre requisiti della demo:
1. **Niente `ln-2ch`.** Il firmatore VLS non annuncia i canali, quindi servono canali privati. In modalità SDK, però, l'inoltro verso canali privati si attiva solo con un flag che fa rifiutare a dave **ogni canale in ingresso**. Quindi dave deve aprire tutti i canali con `push_asset_amount`: è la modalità `ln-lsp` (finestra di custodia alla prenotazione).
2. **Non sopravvive a un riavvio.** Lo stato VLS sta solo in memoria. Dopo un riavvio del processo i canali non si chiudono più in modo cooperativo, e un nodo non si è più sbloccato (`rgb-lib inconsistency detected`). Con `pnpm dev` in watch, o con un crash dell'agente, la demo si rompe.
3. **L'esclusione non restituisce i DUSD.** La tx di chiusura cooperativa si conferma, ma i DUSD non tornano on-chain: nessuno sweep, output ancora non spesi dopo 14 blocchi. Il passo 6-7 della demo ("50.00 tornati a Charlie") non si può mostrare.

Le correzioni esistono upstream ma **non sono pubblicate su npm**: il main di `wdk-rgb-lightning` (16/10) usa `NativeExternalSigner.createWithStorage` e RLN `0.15.0-beta.3`, e il binding `0.1.0-beta.16` espone `createWithStorage`. Usarle significa cambiare le versioni fissate da CLAUDE.md: **decisione del PM**, non presa qui (vedi "Opzioni per il gate").

- **Firma:** **nativa** del nodo con il motore `wdk` (✅ firma davvero il messaggio, verifica in TS puro). Con `rln-rest` resta il fallback **ed25519** + invoice di legame (SPEC §9.1), perché `/signmessage` REST firma la stringa vuota.
- **Backup:** con `rln-rest` resta **lock → backup → unlock** (verificato nello spike 1). Con `wdk`, `vssBackup()` funziona a nodo acceso (circa 60 ms), ma il **ripristino da VSS si blocca** allo sblocco (domanda 9): il backup senza ripristino non serve alla demo `lose-phone`.

### Motore misto proposto (per non perdere il bonus WDK)
- Nodi Lightning: RLN `d4762ac` via REST, come nello spike 1 (`ln-2ch`, canali pubblici, routing, chiusure con sweep: tutto verificato).
- Wallet on-chain di dave: `@utexo/wdk-wallet-rgb@2.0.3` per emettere DUSD e fare l'on-ramp verso i nodi RLN (verificato verso nodi `wdk`; verso RLN REST l'invoice è lo stesso formato `rgb:~/~/~/bcrt:utxob:…`, ma **non provato**).
- Requisito: il processo che importa `wdk-wallet-rgb` gira su **Node 22** (il binario rgb-lib non compila su Node 24).

### Opzioni per il gate 2
| Opzione | Cosa | Rischio |
|---|---|---|
| A (consigliata) | `rln-rest` + `wdk-wallet-rgb` per DUSD di dave | basso: tutto il percorso Lightning è già verificato |
| B | `wdk` a `0.1.0-beta.15` in forma `ln-lsp`, senza mai riavviare i nodi con canali aperti, esclusione senza DUSD restituiti | alto: demo fragile e onestà sulla custodia |
| C | Nuovo spike di 1 ora con versioni più recenti (`wdk-rgb-lightning` dal main GitHub o una beta successiva quando sarà su npm, binding `0.1.0-beta.16`+) | servono il via libera sul cambio di versione e il tempo |

## Domande

| # | Domanda | Esito | Note |
|---|---|---|---|
| 1 | Installazione su Mac arm64, Node ≥ 22.17 | ⚠️ | `wdk-rgb-lightning` + binding Node: ok su Node 22 e 24 (`index-darwin-arm64.node` scaricato dal postinstall). `wdk-wallet-rgb@2.0.3`: il binario `@utexo/rgb-lib-darwin-arm64@0.3.0-beta.8` è una `optionalDependency` compilata con node-gyp/SWIG. **Su Node 24 fallisce** (`no member named 'Holder' in 'v8::FunctionCallbackInfo'`) e npm lo salta in silenzio. Su **Node 22.23.3** compila, ma va aggiunto esplicitamente in `package.json`. |
| 2 | 4 nodi nello stesso processo | ✅ (⚠️ riavvio) | 4 `WalletManagerRgbLightning` nello stesso processo, `dataDir` e `ldkPeerListeningPort` diverse: sblocco in 1,7 s in totale, pubkey distinte. Il runtime tokio è per nodo. **Ma** un nodo con canali non va riavviato (domanda 9 e trappole). Le chiamate native sono sincrone e bloccano l'event loop per la loro durata (da 10 a 400 ms osservati). |
| 3 | Sblocco su regtest | ✅ | `unlock({ bitcoind_rpc_*, indexer_url: 'tcp://127.0.0.1:50001', proxy_endpoint: 'rpc://127.0.0.1:3000/json-rpc', announce_addresses: [], announce_alias })`, senza password (firmatore esterno). |
| 4 | Fondi; emissione con `wdk-wallet-rgb`; stesso seed | ✅ | DUSD (NIA, precisione 2, 1.000.000 unità) emesso dal wallet on-chain di dave e trasferito ai nodi Lightning con invoice blinded. **Stesso seed per i due moduli: nessun conflitto** (indirizzi diversi, `dataDir` separate, come dice il README). L'invoice del nodo LN va creato **senza `asset_id`** finché il nodo non conosce l'asset (`Rln(NotFound)`). Un invio alla volta: il resto del mittente si sblocca solo dopo ACK → broadcast → 1 blocco → refresh. |
| 5 | Canali da 1.000.000 sat (viaggio 5000, liquidità 3000) | ⚠️ | Si aprono e diventano usabili dopo **6 blocchi**. Il finanziamento viene dalla **wallet colorata** (servono UTXO colorati ≥ capacità). Con `public: true` (forma `ln-2ch`) si aprono 6 canali, ma non vengono mai annunciati. La forma che instrada è `ln-lsp`: dave apre un canale privato per viaggiatore con `asset_amount: 8000, push_asset_amount: 5000, push_msat: 200_000_000`. |
| 6 | Pagamento instradato alice → dave → bob, 309 | ⚠️ | Con canali `public: true`: `Failed` subito (grafo vuoto). Con canali privati aperti dal viaggiatore: `PrivateChannelForward` su dave. Con `enableVirtualChannelsV0` su dave: canali in ingresso rifiutati. **Nella forma `ln-lsp`: `Succeeded` in 4,4 s, 0 blocchi**, preimage lato pagatore, `sha256(preimage) == payment_hash` ✅, `payee_pubkey` = bob ✅. Anche bob → alice 350: `Succeeded` in 5,0 s. |
| 7 | Limite in volo a 1.000.000 sat | ✅ | `next_outbound_htlc_limit_msat` = 100.000.000 → **33 HTLC** da 3.000.000 in volo (10% della capacità, come nello spike 1). Outbound iniziale 989.340.000 msat (aperto dal viaggiatore) → 329 pagamenti; con `push_msat` 200.000.000 → circa 63. |
| 8 | Firma con l'identità del nodo; verifica in TS puro | ✅ | `account.sign(msg)`: zbase32 di 65 byte `[31+recid, r, s]`, ECDSA ricuperabile secp256k1 su `sha256d("Lightning Signed Message:" + msg)` (formato LDK/LND). Messaggi diversi → firme diverse. `verify` nativo e `spikes/wdk/verify.ts` (`@noble/curves`, nessuna libreria nativa) accettano la firma giusta e rifiutano messaggio sbagliato, messaggio vuoto, firma alterata e pubkey di un altro nodo. |
| 9 | VSS | ⚠️ backup ✅ / ripristino ❌ | Server locale: `lightningdevkit/vss-server` al commit `e4c8359` con la feature `sigs` + Postgres 16, dal Dockerfile di RLN `v0.10.0-beta.3` (`spikes/wdk/vss/`, build in circa 3 min, `127.0.0.1:8081/vss`). Configurazione: `vssUrl: 'http://127.0.0.1:8081/vss', vssAllowHttp: true`. **`vssBackup()` in 51–65 ms a nodo acceso** (`{ version: 3 }`, poi `4`); un pagamento subito dopo riesce, quindi niente lock. **Ripristino** (stesso seed, `dataDir` vuota, stesso `vssUrl`): i dati arrivano dal server (`Successfully loaded channel … at update_id 9`), poi `unlock` **si blocca a tempo indefinito** (più di 9 min e più di 3 min in due tentativi). `clearVssFence` prima dell'init dà `Rln(NotInitialized)`. Dopo un init manuale del firmatore dà `{ ok: true }`, ma lo sblocco si blocca nello stesso punto. Ipotesi coerente con la trappola 3: il firmatore VLS non ha lo stato del canale. |
| 10 | Chiusura cooperativa dave ↔ bob | ❌ | Nello stesso processo: `closeChannel({ channel_id, peer_pubkey, force: false })` → tx in mempool in circa 1 s (subito dopo un pagamento serve un retry: `waiting on a monitor update`). Ma i DUSD **non tornano**: dopo 14 blocchi gli output (200.000 sat di bob, 798.663 di dave) sono ancora non spesi e `settled` non cambia. `src/rgb_sweep.rs` non esiste in RLN `v0.10.0-beta.3` né `v0.11.0-beta.3`. Dopo un riavvio, la chiusura si ferma allo scambio di `shutdown` (nessuna tx). |
| 11 | `wdk` ↔ RLN `d4762ac` | non fatta | Facoltativa; non serve con il verdetto `rln-rest`. |

## Codice minimo che funziona
Il codice completo e rieseguibile è in `spikes/wdk/` (`lib.ts`, `08-full-single.ts` per l'intero flusso in un processo, `verify.ts`). Le firme esatte dei metodi sono in `docs/vendor/wdk-rgb-lightning.md`.

```js
// costruttore + sblocco
const manager = new WalletManagerRgbLightning(mnemonic, { network: 'regtest', dataDir, ldkPeerListeningPort: 9835 /*, enableVirtualChannelsV0: true solo dave */ })
const account = await manager.getAccount(0)
await account.unlock({ bitcoind_rpc_username: 'user', bitcoind_rpc_password: 'password', bitcoind_rpc_host: '127.0.0.1', bitcoind_rpc_port: 18443, indexer_url: 'tcp://127.0.0.1:50001', proxy_endpoint: 'rpc://127.0.0.1:3000/json-rpc', announce_addresses: [], announce_alias: 'alice' })

// UTXO colorati grandi abbastanza per il canale
await account.createUtxos({ up_to: false, num: 4, size: 1_100_000, fee_rate: 2, skip_sync: false })

// canale ln-lsp (dave → viaggiatore)
await dave.openChannel({ peer_pubkey_and_opt_addr: `${pk}@127.0.0.1:${port}`, capacity_sat: 1_000_000, push_msat: 200_000_000, asset_id, asset_amount: 8000, push_asset_amount: 5000, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 })

// invoice, pagamento, preimage
const { invoice } = await bob.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id, asset_amount: 309 })
const { payee_pubkey } = await alice.decodeInvoice(invoice)
const { payment_hash } = await alice.sendPayment({ invoice })
const p = await alice.getPayment(payment_hash, 'Outbound')   // polling 250 ms → { status: 'Succeeded', preimage }

// firma
const sig = await alice.sign('kitty:v1:…')   // verifica: verify.ts → verifyNodeSignature(msg, sig, nodePubkey)

// chiusura cooperativa (tx sì, sweep dei DUSD no)
await dave.closeChannel({ channel_id, peer_pubkey, force: false })

// emissione (wdk-wallet-rgb, Node 22)
const dw = await new WalletManagerRgb(mnemonic, { network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc', dataDir }).getAccount()
await dw.createUtxos({ upTo: false, num: 6, size: 32_000, feeRate: 2 })
const { assetId } = dw.issueAssetNia({ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] })
const inv = await lnNode.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
await dw.transfer({ recipient: inv.invoice, token: assetId, amount: 10_000, feeRate: 2, minConfirmations: 1 })
// poi: lnNode.refreshTransfers → dw.refreshWallet → mina 1 → refresh di entrambi
```

## Sorprese e trappole
1. **Il firmatore VLS non firma `channel_announcement`.** Nei log LDK (`<dataDir>/.ldk/logs/logs.txt`): `ERROR Signer rejected channel_announcement signing. Channel will not be announced!`. Grafo vuoto (`network_channels: 0`) e pagamenti a più salti impossibili con canali "pubblici".
2. **Inoltro verso canali privati solo con `enableVirtualChannelsV0`**, che fa rifiutare ogni canale in ingresso non virtuale (`unsupported_scid_alias`). In modalità SDK il `config.toml` di RLN non viene letto (`accept_forwards_to_priv_channels` resta `false`).
3. **Stato VLS solo in memoria** (`NativeExternalSigner.create` senza storage). Riavviare un nodo con canali aperti li rende inaffidabili (chiusura bloccata; un nodo non si è più sbloccato per `rgb-lib inconsistency detected: spent bitcoins with another wallet`). Upstream lo corregge con `createWithStorage` (binding `0.1.0-beta.16`+ e main di `wdk-rgb-lightning`, non pubblicato).
4. **Nessuno sweep RGB dopo la chiusura**: gli output della tx di chiusura restano non spesi e i DUSD non si rivedono.
5. **Canali finanziati dalla wallet colorata**: servono UTXO colorati ≥ `capacity_sat`; altrimenti `Rln(NoAvailableUtxos)` (messaggio fuorviante).
6. **Una sola allocazione di DUSD = una sola apertura per volta** (`Rln(Conflict): Not enough assets`, 2-3 blocchi di attesa). Dare a dave più allocazioni.
7. **Nel canale aperto da dave il viaggiatore ha 0 sat** e non può pagare: serve `push_msat`.
8. **`wdk-wallet-rgb` richiede Node 22**, e il binario rgb-lib va dichiarato esplicitamente (npm lo salta in silenzio).
9. `getPayment(hash, type)`: `type` è `'Outbound' | 'InboundAutoClaim' | 'InboundHodl'`.
10. `decodeInvoice` non restituisce `description`. Se la descrizione `kitty:<tripId>:<expenseId>:<debtor>` di SPEC §6.3 serve all'agente, va verificata a parte (non provato a passarla).
11. `manager.dispose()` (entrambi i moduli) lancia un'eccezione dopo lo spegnimento: va avvolto in try/catch.
12. Le chiamate native sono sincrone: con 4 nodi in un processo, una chiamata lenta (es. `createUtxos`, `openChannel`) blocca anche gli altri agenti.

## Parametri consigliati per il seed (se si usa `wdk`)
| Parametro | Valore |
|---|---|
| Node | 22.x (per `wdk-wallet-rgb`) |
| `createUtxos` sul nodo LN | `{ up_to: false, num: <canali da aprire + 1>, size: 1_100_000 }` |
| Allocazioni DUSD di dave | una per canale da aprire (trasferimenti on-chain separati) |
| Canale | dave → viaggiatore, `capacity_sat` 1.000.000, `asset_amount` D + L, `push_asset_amount` D, `push_msat` 200.000.000, `public: false` |
| Flag di dave | `enableVirtualChannelsV0: true` |
| Blocchi per l'apertura | 6 |
| `amt_msat` degli invoice | 3.000.000 |
