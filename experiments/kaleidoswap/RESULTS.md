# Un canale RGB per viaggiatore, finanziato con uno scambio atomico on-chain ↔ Lightning: risultati

> Esperimento sul branch `experiment/rgb-lightning-node` (sab 17 / dom 18 ottobre 2026). Niente in `apps/`, `infra/`, `packages/`; nessun push, PR o merge. Lo stack della demo (`kitty`) non è mai stato toccato.
> Si rilancia tutto da zero con **`experiments/kaleidoswap/run.sh`**. L'ultimo run: **20/20 casi verdi**, log in `.out/stage3.log` (gitignored). Tappe 1 e 2: `STAGES-1-2.md`. Analisi iniziale: `ANALYSIS.md`.

## Riassunto per il team (10 righe)

1. Un solo canale Lightning RGB per viaggiatore invece di due: dave apre il canale con D + L dollari suoi, e il viaggiatore ci porta i suoi D on-chain con uno **scambio atomico**.
2. Il viaggiatore blocca i DUSD on-chain in un HTLC RGB (Bitcoin taproot). dave paga lo stesso importo nel canale con un invoice HODL legato allo **stesso hash**.
3. Il viaggiatore incassa il pagamento Lightning e così rivela il segreto; solo con quel segreto dave può prendere i DUSD on-chain.
4. **Per il viaggiatore la finestra di fiducia è zero:** il segreto esce solo quando lui è già stato pagato. Se qualcosa va storto, i suoi DUSD tornano a lui dopo il timeout.
5. Per dave la sicurezza è una regola deterministica: paga solo se l'HTLC è confermato e corrisponde esattamente (8 controlli in una funzione testata) e se il timeout copre il caso peggiore di Lightning più 72 blocchi.
6. Su regtest lo scambio richiede 2 blocchi e circa 8-10 s; il pagamento Lightning in sé meno di 1 s.
7. Dopo lo scambio tutto funziona come oggi: rimborso di 3.09 da bob ad alice via dave in 2,7 s, ricezione grazie a L, garanzia di dave, esclusione con un solo canale da chiudere.
8. Provati anche i fallimenti: il viaggiatore non incassa, incassa all'ultimo blocco, dave si riavvia, HTLC sbagliati (4 varianti) rifiutati, claim senza segreto rifiutato dal nodo Bitcoin.
9. Il limite onesto: dave deve tenere acceso un "osservatore". Se non incassa prima del timeout, perde D, e lo abbiamo misurato.
10. Costruito su codice KaleidoSwap (fork di RGB Lightning Node con invoice HODL e fork di rgb-lib con HTLC RGB): la conservazione di tutti i 1 000 000 di DUSD emessi torna al centesimo.

## 1. Schema dello scambio

**Prima** (setup, una volta): dave tiene i DUSD in **allocazioni separate**, una per canale; apre un canale verso ogni viaggiatore con `asset_amount = D + L` (8000), `push_msat` 300 000 000 (BTC per i pagamenti del viaggiatore), 1 000 000 sat, pubblico; 6 blocchi. Il viaggiatore ha D on-chain sul suo nodo RLN (on-ramp).

| # | Chi | Cosa | Chi sa cosa |
|---|---|---|---|
| 1 | viaggiatore | genera P (32 byte) e H = sha256(P), una chiave di refund | P solo lui |
| 2 | dave | genera una chiave di claim e fissa **T = altezza + 600** | |
| 3 | viaggiatore | dal suo nodo RLN, `/sendrgb` di D al `wvout:` dell'HTLC (foglia claim: `HASH160(P) = RIPEMD160(H)` + chiave di dave; foglia refund: chiave del viaggiatore + `T` CLTV; chiave interna NUMS); 1 conferma; il suo wallet rgb-lib accetta il lock (per l'eventuale refund) | tutti vedono H, T, le chiavi |
| 4 | viaggiatore | `/lninvoice` HODL con `payment_hash = H`, D DUSD, `min_final_cltv_expiry_delta` 42 (il nodo scrive 45) | |
| 5 | dave | `verifySwap` (§3): se un controllo fallisce, **non paga** | |
| 6 | dave | salva lo scambio su disco come `paid`, poi `/sendpayment` | |
| 7 | viaggiatore | vede `Claimable`, fa `/claimhodlinvoice` con P → riceve D nel canale | P arriva a dave nel pagamento |
| 8 | osservatore di dave | `/getpayment` (`payment_type: Outbound`) → P → spende la foglia claim (wallet rgb-lib), 1 conferma; poi i DUSD vanno al suo nodo RLN | |
| — | se dave non paga | dopo T il viaggiatore spende la foglia refund e rimanda i DUSD al suo nodo RLN | |
| — | se il viaggiatore non incassa | l'HTLC trattenuto torna a dave a `cltv_expiry − 39`; dopo T il viaggiatore fa il refund | |

### Timeout: perché 157 blocchi, e la regola

LDK (in `bitwalt/rust-lightning` `65e8453`, il submodule del fork) fissa il `cltv_expiry` dell'HTLC in arrivo a `altezza + 1 + delta_finale + shadow`, dove lo shadow offset (`routing/router.rs:3785`) è una passeggiata casuale di 1-3 salti sul grafo pubblico, ogni salto il `cltv_expiry_delta` di un canale (72 di default) o 40, **con un tetto di 3·144 = 432**. Chi riceve rimanda indietro l'HTLC a `cltv_expiry − 39` (`HTLC_FAIL_BACK_BUFFER` = 2·18 + 3, `channelmanager.rs:8022`). Nella tappa 1: pagato a 113, shadow 72 + 40 + 40 = 152, `cltv_expiry` 308, scadenza 269, fallito a 270 → "157 blocchi".

Regola di dave (in `src/swap-verify.ts`, test inclusi):
- accetta il `min_final_cltv_expiry_delta` dell'invoice solo tra **42 e 48**, e usa il valore letto;
- `scadenza_max = altezza_pagamento + 1 + delta_invoice + 432`;
- paga solo se **`T ≥ scadenza_max + 72`**: anche se il viaggiatore rivela P all'ultimo momento possibile, dave ha 72 blocchi per confermare il claim.

Misurato nel run (`cltv_expiry − altezza − 1 − 45` = shadow effettivo): 72, 112, 152, 184, 184, 72, 72 blocchi; massimo 184, sempre sotto il tetto 432. Con T = altezza del lock + 600 il margine reale tra la scadenza LN e T è stato **408-520 blocchi**.

**In produzione** 600 blocchi sono circa 4 giorni e 4 ore: un refund può richiedere **circa 4 giorni**, ma solo se lo scambio fallisce. Lo scambio riuscito si chiude in 1-2 conferme.

## 2. Finestra di fiducia

- **Viaggiatore: zero.** P esce solo con `/claimhodlinvoice`, che lo paga nello stesso istante (il pagamento LN e la rivelazione sono la stessa operazione). Senza P la foglia claim non si spende: caso 3, il nodo Bitcoin rifiuta (`Script failed an OP_EQUALVERIFY`). La chiave interna è NUMS, quindi non esiste spesa per chiave. Se dave non paga, il viaggiatore ha il refund dopo T. **Costo residuo:** se dave non paga mai, i D del viaggiatore restano bloccati fino a T (griefing, circa 4 giorni in produzione), senza perdita.
- **dave: zero se l'osservatore è attivo.** I controlli prima di pagare (§3) garantiscono che il lock sia quello giusto e confermato; la regola sul timeout garantisce 72 blocchi per il claim dopo l'ultima rivelazione possibile. **Se l'osservatore è fermo fino a T, dave perde D** (caso 11). Il processo di osservazione è **critico**, come un watchtower.
- dave rischia anche di avere liquidità ferma se il viaggiatore non incassa: al massimo fino alla scadenza LN (caso 2), senza perdita.

## 3. Le verifiche di dave prima di pagare

Una funzione pura, `verifySwap(expected, observed)` (`src/swap-verify.ts`), con **22 test unitari** (`node --test src/swap-verify.test.ts`). dave calcola lo script atteso **da sé** (H dall'invoice, la sua chiave, la chiave del viaggiatore registrata, T concordato, NUMS) e il suo wallet rgb-lib cerca la consignment sotto il recipient id di **quello** script: un lock su un altro script semplicemente non si trova. Controlli:

| Controllo | Fonte |
|---|---|
| lock **confermato** (≥ 1 conferma, non solo in mempool), output ≥ dust | bitcoind |
| script dell'output **esattamente** quello atteso (copre hash, chiavi, T e chiave interna) | ricalcolato da dave con `htlc-tool` |
| chiave interna = NUMS | idem |
| consignment RGB accettata e validata dal wallet di dave per asset_id e importo = D | rgb-lib (fork) `fetch_and_accept_transfer_by_recipient_id` |
| invoice: hash = H dichiarato, asset, importo = D, payee = nodo del viaggiatore, non scaduto | `/decodelninvoice` |
| H, chiave di claim = dave, chiave di refund = viaggiatore, timeout = T (uno per uno, per messaggi leggibili) | termini dichiarati |
| `min_final_cltv_expiry_delta` tra 42 e 48 | invoice |
| `T ≥ altezza + 1 + delta + 432 + 72` | regola §1 |

## 4. Numeri di ogni caso (ultimo run, da stack pulito)

| Caso | Esito | Blocchi | Tempo | Dettagli |
|---|---|---|---|---|
| 0a. Un canale dave → ogni viaggiatore | ✅ | 7 | 1,7 s | 3 aperture una dopo l'altra senza attese, 3 funding tx, 6 blocchi in un colpo (+1); dave 8000 asset e 699 013 sat, viaggiatore 0 asset e 300 000 sat |
| 0b. On-ramp 100.00 on-chain a ognuno | ✅ | 3 | 1,0 s | RLN → RLN |
| 1. Scambio alice / bob / charlie | ✅ ✅ ✅ | 2 ciascuno | 7,8 / 9,2 / 9,8 s | lock 2,0 s (1 blocco), dave verifica e paga, `Claimable` in 0,7 s, claim LN 0,1-0,4 s, claim on-chain di dave 2,4-3,2 s (1 blocco). Canale finale: **viaggiatore 5000, dave 3000**. BTC on-chain del viaggiatore −1987 sat (1000 sull'HTLC + 987 di fee); canale: 3000 sat da dave al viaggiatore con l'HTLC |
| 1. dave porta i 15 000 riscossi sul suo nodo RLN | ✅ | 1 | 7,8 s | wallet rgb-lib → RLN |
| 4. Invoice di alice da 3.09, paga bob via dave | ✅ | 0 | 2,7 s | preimage ✓; alice 5000 → 5309, bob 5000 → 4691 |
| 5. charlie paga bob 2.00 | ✅ | 0 | 3,0 s | bob riceve grazie a L |
| 6. Garanzia: dave paga un invoice di charlie da 3.50 | ✅ | 0 | 1,6 s | dal lato di dave del canale di charlie |
| 8. Il viaggiatore incassa all'ultimo blocco utile | ✅ | 160 | 15,7 s | `cltv_expiry` 328 dal log (`UpdateAddHTLC`), scadenza 289, incasso a 288; claim on-chain di dave a 289, **margine residuo 440 blocchi** prima di T (729) |
| 9. dave si riavvia tra incasso LN e claim | ✅ | 2 | 17,2 s | `docker restart` di dave, unlock; l'osservatore rilegge lo stato `paid` da disco, prende P da `/getpayment` (`Outbound`) e riscuote |
| 2. Il viaggiatore non incassa | ✅ | 1 + 81 | 12,3 s | trattenuto, poi fallito a 373 (scadenza 371); asset di dave sul canale di bob tornati (3009); refund dopo T sotto |
| 3. dave prova il claim on-chain senza P | ✅ | 0 | 2,1 s | `mempool-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation)` |
| 10. HTLC sbagliati: dave non paga | ✅ ×4 | 4 | 25 s | a) importo minore: `assignment mismatch: got [Fungible(90)], expected Fungible(100)`; b) hash diverso: script diverso, consignment non trovata, hash ≠ invoice; c) T troppo vicino: `T 475 < worst-case LN expiry 854 + 72`; d) chiave di claim non di dave: script diverso, consignment non trovata, chiave di claim non di dave |
| 11. Osservatore di dave fermo | ✅ | 1 | 11,2 s | charlie incassa 1000 nel canale (lato di dave 2850 → 1850) |
| Refund dopo T (casi 2, 10a-d, 11), poi verso i nodi RLN | ✅ ×6 | 607 | 60 s | alice +100, +90, +100, +100; bob +100; charlie +1000 |
| 11. (seguito) dave si sveglia dopo il refund | ✅ | 0 | 2,2 s | claim tardivo: `bad-txns-inputs-missingorspent`. **Perdita di dave: 1000 unità (10.00 DUSD) + 3000 sat**; charlie ha 1000 nel canale e 1000 tornati on-chain |
| 7. dave chiude il canale di charlie | ✅ | 7 | 135 s | 6150 di charlie tornati on-chain dopo lo sweep e `/refreshtransfers` (5000 → 11 150); anche i 1850 di dave tornano a lui. Lo sweep di LDK parte **a tempo, non a blocchi** (circa 130 s di attesa) |
| Conservazione | ✅ | 0 | 7,0 s | dave 962 850 + 5600, alice 4900 + 5409, bob 4900 + 4991, charlie 11 150, `dave-htlc` 200 → **1 000 000** |

Costi in sat per scambio (regtest): HTLC 1000 sat (dal viaggiatore a dave con il claim), fee del lock circa 987 sat, fee del claim 1500 sat (fissa nel tool), 3000 sat dal lato di dave a quello del viaggiatore con il pagamento HODL (`rgb_htlc_min_msat`).

## 5. Limiti

1. **Un wallet rgb-lib del fork accanto a ogni nodo RLN.** RLN via REST sa *bloccare* (`/sendrgb` a un recipient witness) ma non sa *spendere* un HTLC colorato: claim (dave) e refund (viaggiatore) passano da `kaleidoswap/rgb-lib` `dbdf82d` (`psbt_op_prepare_with_expiry`, `fetch_and_accept_transfer_by_recipient_id`, `psbt_op_provide_receive_consignment`). Le consignment sono compatibili in entrambe le direzioni con il rgb-lib dentro RLN (`RGB-Tools/rgb-lib` `2b9af11`), entrambi RGB `0.11.1-rc.11`. Il wallet ha bisogno di BTC suoi per le fee. In demo è `htlc-tool` in Docker; in produzione sarebbe una libreria nell'app.
2. **L'osservatore di dave è critico** (caso 11): deve girare sempre, con lo stato su disco (caso 9), e riscuotere entro T. Va monitorato come un watchtower.
3. **`push_msat`:** il canale lo finanzia tutto dave, quindi il viaggiatore parte con 0 sat e ogni pagamento RGB porta 3000 sat. Senza `push_msat` (qui 300 000 000 msat = 300k sat, circa 100 pagamenti) il viaggiatore non potrebbe pagare. Quei sat tornano al viaggiatore alla chiusura: sono un costo per dave, da dimensionare o far pagare.
4. **Allocazioni separate:** con una sola allocazione di DUSD dave apre un canale per volta (il resto del funding diventa spendibile solo dopo 6 conferme e un refresh; trappola 6 di `docs/spike-wdk.md`). Qui l'emissione è `[8000 ×5, 960 000]`, su UTXO distinti (verificato con `/listunspents` e scritto nel log). In più la selezione di rgb-lib non sceglie l'allocazione dell'importo esatto: l'on-ramp prima delle aperture ha consumato le allocazioni da 8000. **In produzione l'operatore deve tenere allocazioni separate e riservate per aprire canali in parallelo.**
5. **Immagine del fork e rotture di API** (`kaleidoswap/rgb-lightning-node` `1e4b1c3`): `/getpayment` richiede `payment_type`; `Payment.inbound` diventa `payment_type`; nuovi stati `Claimable`, `Claiming`, `Cancelled`; `min_final_cltv_expiry_delta` nella decodifica; `/signmessage` è ancora rotto; rgb-lib da `branch = master` (fissato solo dal `Cargo.lock`); rust-lightning da un fork personale. Mai usare questo binario sui volumi della demo.
6. **La scadenza esatta dell'HTLC trattenuto** non è esposta dall'API: l'abbiamo letta dalla riga TRACE `UpdateAddHTLC` del log del nodo. Una richiesta naturale a KaleidoSwap: esporre `claim_deadline_height` in `/getpayment`.
7. **Timeout lunghi in produzione:** il tetto dello shadow offset (432) porta T a circa 4 giorni. Si accorcerebbe se RLN permettesse di limitare `max_total_cltv_expiry_delta` o lo shadow offset in `/sendpayment` (oggi non si può via REST).
8. Su regtest il minare è istantaneo. In produzione lock e claim chiedono 1 conferma ciascuno (circa 10-20 minuti) e l'apertura del canale 6.

## 6. Confronto con `ln-2ch` (su `main`)

| | `ln-2ch` | Un canale + scambio atomico |
|---|---|---|
| Canali per viaggiatore | 2 (viaggio + liquidità) | **1** |
| Chi finanzia BTC | viaggiatore il suo canale, dave la liquidità | **dave tutto** (+ `push_msat` al viaggiatore) |
| DUSD di dave all'apertura | L | D + L (rientrano D on-chain con il claim) |
| Transazioni on-chain all'onboarding | 2 funding | 1 funding + 1 lock + 1 claim |
| Blocchi | 6 | 6 per il canale + 1 per il lock + 1 per il claim |
| Custodia | nessuna | nessuna (scambio atomico; finestra zero per il viaggiatore) |
| Pagamenti, ricezione, garanzia | come da SPEC | **identici** (casi 4-6) |
| Esclusione | 2 chiusure | **1 chiusura** |
| Componenti in più | — | wallet rgb-lib del fork, osservatore di dave, immagine del fork |
| Rischi in più | — | dave offline fino a T → perde D; griefing sul lock del viaggiatore (fino a T) |

## 7. Cosa servirebbe per portarlo nel progetto

**`RlnWallet` (`apps/agent/src/wallet/rln-wallet.ts`)**
- Client rigenerato dall'`openapi.yaml` del fork; `/getpayment` con `payment_type`; il controllo `if (p.inbound)` riscritto su `payment_type` (oggi diventerebbe sempre falso, in silenzio); stati `Claimable`, `Claiming`, `Cancelled` nel polling.
- Nuove operazioni: viaggiatore `lockForSwap` (`/sendrgb` witness), `createHodlInvoice`, `claimHodl`, `refundSwap`; dave `verifySwap` + `pay`, `watcher` (P da `/getpayment` → claim), `claimSwap`.
- Un `HtlcWallet` (rgb-lib del fork) accanto a ogni nodo, con i suoi BTC per le fee: libreria nativa nell'agente (binding del fork: C-FFI e uniffi; Node da verificare) oppure il sidecar `htlc-tool`.
- `balances()`: viaggio = lato asset del viaggiatore nell'unico canale; in arrivo = lato di dave. `closeChannelsWith`: un canale. `openLiquidity`: resta un canale in più, oppure splicing in roadmap.

**`seed.ts` (`infra/treasury/seed.ts`)**
- dave: `/createutxos` con abbastanza UTXO colorabili, poi DUSD in allocazioni separate (oggi arrivano dalla tesoreria WDK: un invio per allocazione, ognuno confermato).
- Aperture `dave → viaggiatore` con D + L e `push_msat`, tutte insieme, poi 6 blocchi; lo scambio per ogni viaggiatore al posto del suo `/openchannel`.
- Attesa dello sweep a tempo dopo le chiusure (lo sweeper di LDK non reagisce ai blocchi minati in fretta).

**`LightningRail`**: il pagamento delle spese non cambia (invoice normali, via dave). Serve una nuova `KITTY_RAIL_MODE` (es. `ln-1ch-swap`) che cambia solo l'onboarding.

**Altro (fuori dalle tre cartelle):** l'immagine del fork in `infra/` (con un tag diverso); nuovi eventi firmati in `packages/shared` (`SWAP_OFFERED`, `SWAP_LOCKED`, `SWAP_SETTLED`) e la loro validazione in `packages/ledger` (A); l'osservatore di dave come processo monitorato.

**Modifiche alla SPEC da proporre al team** (non applicate): §4 e §6.2 un canale per viaggiatore e lo scambio atomico all'onboarding; §10.4 nuova modalità `ln-1ch-swap`; §13 due righe nuove (osservatore di dave offline → perdita di D; griefing sul lock del viaggiatore → fondi fermi fino a T); §15 T = altezza + 600, `push_msat`, allocazioni separate; §20 la decisione.

## 8. Commit e versioni usati

| Cosa | Riferimento |
|---|---|
| Fork di RLN | `kaleidoswap/rgb-lightning-node` `1e4b1c3905ace8833ceebbdf06fb69f79aac340d` (`kaleido/next`) |
| rust-lightning (submodule) | `bitwalt/rust-lightning` `65e845303b2841d607fe4640b659458eeda7340e` (`rgb-stock-ldk-interop-hodl-same-hash`) |
| rgb-lib dentro RLN | `RGB-Tools/rgb-lib` `2b9af1152f29caf4ac75ae1debdce38088ea9816` (dal `Cargo.lock` del fork) |
| Immagine RLN | `kitty/rln:kaleido-next` `sha256:39b4e78f…`, dal Dockerfile del fork più `CARGO_BUILD_JOBS=2` (`docker/rln-kaleido.Dockerfile`) |
| rgb-lib per l'HTLC | `kaleidoswap/rgb-lib` `dbdf82dac3ffd2a41b1ec3cc9b410c5a4fa56f2f` (pubblico) |
| Logica HTLC adattata | `kaleidoswap/rgb-lib` `src/wallet/test/htlc_swap_tree.rs` (`ec7466a`); `kaleidoswap/kaleidoswap-sdk` `385254a26f4c15fece212221d51066d206bbf618` `examples/rgb-regtest/src/wallet.rs` |
| Immagine `htlc-tool` | `kitty/htlc-tool:dev` `sha256:9ee84058…`, Rust 1.95; `Cargo.lock` partito da quello di rgb-lib `dbdf82d`, perché `secp256k1 0.32.0-beta.2`, richiesto da `rgb-consensus 0.11.1-rc.11`, è ritirato da crates.io |
| Servizi | bitcoind `hashbeam/bitcoind:30.2`, electrs `hashbeam/electrs:0.11.0`, esplora (digest come la demo), `rgb-proxy-server:0.3.0` |
| TypeScript | Node v24.14.0 (strip-types), `openapi-fetch` 0.17.0, `openapi-typescript` 7.13.0, `typescript` 5.9.3 |

**Scelte diverse da quanto chiesto all'inizio:**
- `htlc-tool` invece di `PreparedRgbSpend` dell'SDK, che ammette solo le spese del taker, mentre qui servono il claim di dave e il refund del viaggiatore sullo stesso HTLC.
- Chiave interna **NUMS** invece di una chiave nota: niente spesa per chiave.
- `Cargo.lock` di rgb-lib come punto di partenza, per la dipendenza ritirata da crates.io.

## 9. Come si rilancia

```sh
experiments/kaleidoswap/run.sh
```
Controlla RAM e porte, costruisce le immagini se mancano, esegue i test unitari, azzera **solo** lo stack `kitty-kaleido` (porte 23xxx e 28443, volumi propri) e lancia `src/stage3-e2e.ts`, che stampa esito, blocchi, sat e tempi di ogni caso (circa 5-6 minuti). Fermare lo stack: `experiments/kaleidoswap/scripts/stack.sh down`.
