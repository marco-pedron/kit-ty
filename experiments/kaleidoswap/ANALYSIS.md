# Un solo canale per viaggiatore con scambio atomico: analisi del fork di KaleidoSwap

> Esperimento sul branch `experiment/rgb-lightning-node`. Fase 1 (analisi) e fase 2 (esecuzione del test, **bloccata**, vedi §6). Nessun codice nel nostro repo.
> Cloni fuori dal repo, mai committati: `../kaleidoswap/rln` (fork di RLN) e `../kaleidoswap/sdk` (`kaleidoswap-sdk`).
> Data: sabato 17/10/2026.

## 0. In breve

- Il fork di RLN (`kaleido/next`) aggiunge le **invoice HODL** (`/lninvoice` con `payment_hash`, `/claimhodlinvoice`, `/cancelhodlinvoice`). **Non ha nessuna parte on-chain**: tutti i suoi test HODL e `swap_*` sono scambi **LN ↔ LN**, anche quando usano un solo canale (`same_channel`).
- Lo scambio **LN ↔ on-chain con RGB** che passa davvero sta nell'**SDK**: `kaleidoswap-sdk`, `examples/rgb-regtest`, scambi Boltz "submarine" (2a) e "reverse" (2b) per `USDT-RGB` on-chain ↔ **BTC** su Lightning. La parte on-chain **è** un HTLC taproot bloccato dallo stesso hash, e porta anche l'asset RGB. Però:
  1. il lato Lightning è **BTC su ldk-server**, non RGB su RLN;
  2. la controparte è il demone maker **`kaleidoswap-maker-rs`, che non è pubblico** (GitHub risponde 404): il test non si può rifare senza;
  3. la spesa colorata dell'HTLC (claim e refund) richiede le API PSBT di un **fork di rgb-lib** (`kaleidoswap/rgb-lib` `96f039d`), che l'API REST di RLN non espone.
- Quindi, per il nostro caso (DUSD on-chain del viaggiatore → il suo lato del canale RGB con dave), **oggi non esiste un test che passa**. Si può costruire con i pezzi esistenti in due modi (§5): **A**, con le sole invoice HODL di RLN, fattibile ma **non atomico** (il viaggiatore si fida di dave per una finestra); **B**, atomico, con l'HTLC on-chain dell'SDK, ma con molto lavoro in Rust e un pezzo di maker da scrivere da zero.
- Fase 2: il test di RLN **non è partito**. Usa le porte 18443, 50001, 3000, 3001-3003 e 3002, già occupate dallo stack `kitty` della demo, e su questa macchina non c'è Rust. Mi sono fermato come da istruzioni (§6).

## 1. Qual è il test "che passa"

Ce ne sono due candidati, e nessuno fa esattamente ciò che ci serve.

| | Test | Dove | Commit | Cosa scambia |
|---|---|---|---|---|
| (a) | `claim_hodl_invoice_btc_rgb` (con `cancel_hodl_invoice_btc_rgb`, `expire_hodl_invoice_time_and_blocks`, `use_same_hodl_invoice_hash_for_inbound_rgb_and_outbound_btc`) | `kaleidoswap/rgb-lightning-node`, branch `kaleido/next`, `src/test/hodl_invoice.rs` | introdotto in `0a502a7bb95565f94fd1692cdf2692b1b290bd7b`; testa del branch `1e4b1c3905ace8833ceebbdf06fb69f79aac340d` (29/09/2026) | un pagamento RGB su un canale, trattenuto e poi riscosso con la preimage. **Nessuna gamba on-chain.** |
| (a') | `chain_bolt12_hold_to_rgb_hodl` (`#[ignore]`, richiede binari ldk-server di un altro branch) | stesso branch, `src/test/chain_bolt12_hold.rs`, commit `1e4b1c3` | | BOLT12 BTC trattenuto su ldk-server → pagamento RGB su RLN, **stesso hash**. LN ↔ LN, due implementazioni. |
| (b) | `swap_roundtrip_buy_same_channel`, `swap_reverse_same_channel` | `feat/swaps-with-hodl` (`1ae39290baf2fdd05ab1f47a1cd9a42f32e26b4a`, 20/04/2026); su `kaleido/next` esistono nella versione precedente (intercept a due gambe, `maker_init` → `taker` → `maker_execute`) | | BTC ↔ RGB **sullo stesso canale**: il taker paga un'invoice HODL in BTC, il maker gli manda RGB con un keysend, poi riscuote. LN ↔ LN. |
| (c) | `examples/rgb-regtest` (`bootstrap` + `run`, e `ts-run.ts`) | `kaleidoswap/kaleidoswap-sdk`, `main` `385254a26f4c15fece212221d51066d206bbf618` (14/10/2026); report in `examples/rgb-regtest/validation-report.json` (submarine, refund e reverse riusciti) | maker `49c6ce2` (TS: `866215f`), rgb-lib `96f039d`, ldk-server `86ca542` | **USDT-RGB on-chain ↔ BTC su Lightning**, HTLC on-chain con lo stesso hash. È l'unico LN ↔ on-chain. |

**Ipotesi:** KaleidoSwap intendeva (c), che è lo scambio atomico on-chain ↔ LN, oppure (a) come mattone lato RLN. Prima della fase 3 conviene chiederglielo e chiedere l'accesso a `kaleidoswap-maker-rs`.

## 2. Il flusso, passo per passo

### 2.1 Invoice HODL su RLN (test (a))
1. **Il ricevente** (node2) sceglie preimage `P` e hash `H = sha256(P)` (`random_preimage_and_hash()`).
2. node1 ha già aperto il canale verso node2 con l'asset (`open_channel_with_retry`, 500 000 sat, `push_msat` 0, 100 unità).
3. node2: `POST /lninvoice` con `payment_hash = H`, `asset_id`, `asset_amount`, `amt_msat = HTLC_MIN_MSAT`, `expiry_sec` 120. Una seconda invoice con lo stesso hash → `400 PaymentHashAlreadyUsed`.
4. node1: `/sendpayment` → `Pending`. Da node2 il pagamento diventa **`Claimable`** (anche `/invoicestatus`). L'HTLC è bloccato nel canale, i fondi non sono di nessuno dei due.
5. Lo stato `Claimable` sopravvive a un riavvio di node2.
6. node2: `POST /claimhodlinvoice { payment_hash, payment_preimage }`: preimage sbagliata → `400 InvalidPaymentPreimage`; riscossione in corso → `403 InvoiceSettlingInProgress`; seconda riscossione → `409 InvoiceAlreadyClaimed`.
7. Il pagamento diventa `Succeeded` su entrambi; il pagatore vede `preimage = P`; `/getpayment` riporta `payment_type: InboundHodl`. I saldi RGB fuori catena si spostano di `ASSET_PAYMENT_AMOUNT`.
8. In alternativa: `POST /cancelhodlinvoice { payment_hash }` → HTLC restituito, stato `Cancelled`. Oppure scadenza per tempo o per blocchi (`expire_hodl_invoice_time_and_blocks`).

### 2.2 Scambio sullo stesso canale (test (b), `feat/swaps-with-hodl`)
1. Il maker apre il canale verso il taker (100 000 sat, **`push_msat` 50 000 000**, 600 unità RGB).
2. `maker_init`: il maker sceglie **lui** `P`, crea un'invoice HODL per `qty_from` (BTC) e restituisce una swapstring.
3. Il taker paga l'invoice HODL con `/sendpayment` (gamba taker → maker, trattenuta).
4. Su `PaymentClaimable` il maker manda al taker un keysend con `qty_to` RGB sullo **stesso canale**.
5. Su `PaymentSent` del keysend il maker riscuote l'HODL. Se il keysend fallisce, il maker restituisce l'HTLC con `fail_htlc_backwards`.
6. È sicuro per il taker: i suoi fondi tornano indietro se il maker non manda. Il maker rischia solo la propria vitalità.

### 2.3 Scambio on-chain ↔ LN dell'SDK (test (c))
**Submarine 2a (USDT-RGB on-chain → BTC LN):**
1. Il taker (cliente) crea l'invoice LN, quindi sceglie `P`, e chiede lo scambio al maker.
2. Il maker risponde con l'albero taproot e l'oggetto `rgb` (`assetId`, `amount`, `recipientId` `wvout:` dello script, `blinding`, `htlcSat`, `minConfirmations`). L'SDK verifica tutto (`validate_rgb`): hashlock, CLTV, chiavi, indirizzo, contract id fissato dal chiamante.
3. Il taker **blocca** gli RGB on-chain: una `send` di rgb-lib (donation) al `recipientId` dell'HTLC, con `htlcSat` sat sull'output.
4. Il maker vede il blocco confermato e paga l'invoice LN del taker, così impara `P`.
5. Il maker spende l'HTLC dalla foglia di claim (`OP_HASH160 <hash160(P)> OP_EQUALVERIFY <maker> OP_CHECKSIG`) con una PSBT colorata.
6. Se il maker non paga: dopo `timeoutBlockHeight` il taker spende dalla foglia di refund (`<taker> OP_CHECKSIGVERIFY <T> OP_CLTV`), con una PSBT colorata e di solito un input BTC per le fee. Una spesa non colorata **brucia l'asset**: l'SDK la impedisce.

**Reverse 2b (BTC LN → USDT-RGB on-chain):** il maker blocca gli RGB quando l'invoice hold del taker è accettata; il taker riscuote on-chain rivelando `P`; il maker usa `P` per chiudere l'invoice hold.

## 3. La parte on-chain è bloccata dallo stesso hash?

- **Nel fork di RLN: no**, perché non c'è nessuna parte on-chain. Le invoice HODL bloccano solo l'HTLC **dentro** il canale.
- **Nell'SDK: sì**, per BTC e per RGB. L'output on-chain è un HTLC taproot Boltz (hashlock `HASH160(P)`, compatibile con l'hash del pagamento LN, più un refund con CLTV), e l'allocazione RGB sta su quell'output (`wvout:` + `blinding`). È validato su regtest da KaleidoSwap (report del 06/10), ma con BTC dal lato Lightning, il maker privato e il fork di rgb-lib.
- **Per noi, con il solo RLN REST, no.** Il blocco si potrebbe fare (`/sendrgb` accetta `witness_data { amount_sat, blinding }` e un `recipient_id`), ma né dave (claim) né il viaggiatore (refund) possono spendere un output con hashlock colorato: RLN non espone `psbt_op_prepare_with_expiry` né `accept_transfer_pinned`. Senza refund il blocco è una perdita, non un HTLC.

**Senza HTLC on-chain (variante A, §5), chi si fida di chi:**

| Ordine | Chi rischia | Finestra | Quanto |
|---|---|---|---|
| dave sceglie `P`; il viaggiatore crea l'HODL con `H`; dave paga (HTLC trattenuto dal viaggiatore); il viaggiatore manda D on-chain con `/sendrgb`; dave vede `Settled` e rivela `P`; il viaggiatore riscuote | **il viaggiatore** | da `/sendrgb` alla rivelazione di `P` (1 blocco + `/refreshtransfers` + la reazione di dave; in produzione circa 10-60 min) | D |
| il viaggiatore sceglie `P`; dave paga l'HODL; il viaggiatore riscuote e poi manda on-chain | **dave** | dalla riscossione all'invio on-chain | D |
| se il viaggiatore non manda niente | nessuno | l'HTLC resta bloccato fino al cancel o alla scadenza (CLTV): la liquidità di dave è ferma | 0 |

La prima riga è la scelta coerente con il nostro modello: l'operatore conosce il cliente e garantisce già fino a G. Però rompe "Dave non può rubare" durante la finestra, ed è di fatto il `ln-lsp` di SPEC §10.4 con un miglioramento: il viaggiatore vede i fondi di dave bloccati prima di pagare. **Non è atomica, e va detto.**

## 4. Differenze di API tra il fork (`kaleido/next`) e il nostro `d4762ac`

`kaleido/next` = `d4762ac` più 5 commit (interoperabilità con LDK standard, HODL, build e CI, rust-lightning con la correzione per lo stesso hash, test BOLT12).

**Aggiunte (compatibili):**
- `POST /claimhodlinvoice { payment_hash, payment_preimage }`, `POST /cancelhodlinvoice { payment_hash }`;
- `LNInvoiceRequest`: `payment_hash?` (crea un HODL), `min_final_cltv_expiry_delta?`;
- `DecodeLNInvoiceResponse`: `min_final_cltv_expiry_delta` (obbligatorio nella risposta);
- `HTLCStatus` e `InvoiceStatus`: nuovi valori `Claimable`, `Claiming`, `Cancelled`.

**Rotture:**
- `Payment.inbound: boolean` → `Payment.payment_type: Outbound | InboundAutoClaim | InboundHodl`. In `apps/agent/src/wallet/rln-wallet.ts:166,455` il controllo `if (p.inbound)` diventerebbe **sempre falso in silenzio**, e si perderebbe il controllo "payment is inbound" in `waitForPayment`. Andrebbe aggiornato insieme al tipo locale.
- `status` dei pagamenti: il tipo locale `'Pending' | 'Succeeded' | 'Failed'` è incompleto; il polling non si rompe, ma uno stato `Cancelled` arriverebbe al timeout di 30 s invece che subito.
- `packages/rln-client/src/schema.d.ts` va rigenerato (nell'esperimento, non lì).

**Cosa non cambia o resta un problema:** `/signmessage` firma ancora la stringa vuota (`src/routes.rs:4489`), quindi resta ed25519; `/backup` resta a nodo bloccato; `maker_init`/`taker`/`maker_execute` restano nella versione con intercept.

**Build e riproducibilità:** `Cargo.toml` usa `rgb-lib` da `RGB-Tools/rgb-lib` **`branch = "master"`** (in movimento: la build non è riproducibile senza fissare il commit nel `Cargo.lock`); il submodule `rust-lightning` punta a un fork personale (`bitwalt/rust-lightning`, branch `rgb-stock-ldk-interop-hodl-same-hash`, `65e8453`); il Dockerfile usa `cargo-chef`. Il formato dei dati persistiti cambia (pagamenti con `payment_type`): **mai** usare il nuovo binario sui volumi della demo.

## 5. Un solo canale per viaggiatore nel nostro modello

**Schema:** dave apre un solo canale verso il viaggiatore m, con `asset_amount = D + L` dei suoi DUSD. Uno scambio sposta D sul lato di m, in cambio dei D che m ha on-chain. Dopo lo scambio il canale ha D dal lato di m e L dal lato di dave, cioè gli stessi saldi dei due canali di `ln-2ch`, ma in un canale solo.

**Cosa si conserva:**
- **Instradamento:** debitore → dave → creditore, su due canali (uno per membro): come oggi.
- **Garanzia (§6.7):** dave paga lo stesso invoice dal suo lato del canale del creditore: 1 hop, nessun cambiamento.
- **Esclusione (§6.7):** dave chiude **un** canale invece di due; m riceve on-chain il suo saldo con lo sweep, come oggi (`closeChannelsWith` già chiude tutti i canali con il peer).
- **`liquidityPlan` (§10.5):** la formula `inbound(m) = L + inviato − ricevuto` non cambia; una nuova liquidità just-in-time diventerebbe un secondo canale (o, in roadmap, lo splicing).

**Cosa cambia o va risolto:**
1. **Capitale di dave:** deve avere `D + L` DUSD per viaggiatore al momento dell'apertura (oggi solo L). Torna in equilibrio con lo scambio, perché riceve D on-chain.
2. **Sat del viaggiatore nel canale:** il canale lo finanzia tutto dave, quindi m parte con **0 sat** e ogni pagamento RGB porta 3000 sat (`rgb_htlc_min_msat`). Lo scambio stesso (un pagamento da `amt_msat` ≥ 3 000 000) gliene porta 3000, cioè un solo pagamento, e in più c'è la riserva del canale. Serve un `push_msat` all'apertura (il test (b) usa 50 000 000 msat): è un regalo di BTC da parte di dave, non di DUSD, da dimensionare (circa 3000 sat per pagamento previsto, più la riserva).
3. **La finestra di fiducia** della variante A (§3), oppure la complessità della variante B.
4. **Atomicità vera (variante B):** il viaggiatore blocca D on-chain in un HTLC (hash di `P` scelto da lui, claim per dave, refund per lui dopo T); dave verifica il blocco e paga l'invoice normale del viaggiatore sul canale (D DUSD), quindi impara `P`; dave spende l'HTLC. Serve: (i) costruire l'HTLC e la spesa con l'SDK (`SwapScript`, `PreparedRgbSpend`), che però si aspetta la risposta di un maker, quindi dave dovrebbe produrla da sé; (ii) un portafoglio rgb-lib (fork `96f039d`) **accanto** al nodo RLN di dave, per accettare la consignment e colorare il claim, e un altro accanto al nodo di ogni viaggiatore per il refund; (iii) la logica del maker (verifica del blocco, pagamento, claim prima di T), che è nel repo privato. Sono giorni di lavoro in Rust, non ore.

## 6. Fase 2: perché il test non è partito

Ho controllato prima di avviare qualsiasi cosa:

- **Porte:** la suite di RLN chiama `./regtest.sh start` (`src/test/mod.rs:2480`), che avvia il `compose.yaml` del fork su **18443, 50001, 3000 e 3002**, e i nodi di test usano le porte API **3001-3003**. Sono tutte occupate dallo stack `kitty` acceso (`kitty-bitcoind-1` 18443, `kitty-electrs-1` 50001, `kitty-proxy-1` 3000, `kitty-rln-bob-1` 3002, alice, bob e charlie su 3001-3003). Le porte 18443 e 50001 sono anche scritte nel codice dei test. Il compose del fork è un altro progetto, quindi non cancellerebbe i volumi della demo, ma non partirebbe e alcuni test fanno `docker compose stop electrs`.
- **Toolchain:** `cargo` e `rustup` non sono installati. Una prima build di RLN (LDK + rgb-lib) richiede l'installazione di Rust 1.95 e, a occhio, 20-40 minuti di CPU.
- **RAM:** 8 GB in tutto, VM Docker da 4 GB, il 45% libero; la demo usa circa 430 MB nei container. Una build di Rust in parallelo con la demo è possibile, ma stretta.
- **Test (c) dell'SDK:** richiede il binario del maker `kaleidoswap-maker-rs`, che non è accessibile. Non si può eseguire.

**Mi sono fermato qui come richiesto.** Opzioni nel §7.

## 7. Piano della fase 3 (da approvare)

### Decisioni che ti servono
1. **Come far girare il test di RLN** (fase 2):
   - **(R1, consigliata)** installo Rust con `rustup`, e **nel clone esterno** (non nel nostro repo) sposto le porte del suo `compose.yaml` e le costanti dei test (18443 → 28443, 50001 → 25001, 3000 → 23100, 3002 → 23102, API dei nodi 3001+ → 23201+), poi `cargo test claim_hodl_invoice_btc_rgb -- --nocapture`. La demo resta accesa. Costo: circa 40 minuti di build sulla macchina della demo.
   - (R2) Salto `cargo test` e riproduco lo stesso flusso HODL via REST sull'immagine `kitty/rln:kaleido-next` nel nostro compose separato: è comunque il test 7 della fase 3.
   - (R3) Lo eseguo su un'altra macchina.
2. **Variante dello scambio:**
   - **(A, consigliata per l'esperimento)** HODL con la preimage di dave: tutto con le API del fork, fattibile oggi, **non atomica**, con la finestra di fiducia del §3 misurata e documentata.
   - (B) Atomica con l'HTLC on-chain dell'SDK: richiede il fork di rgb-lib, un portafoglio rgb-lib accanto ai nodi RLN e la logica del maker da riscrivere. Non entra in questo esperimento; la scriverei solo come design in `RESULTS.md`, oppure dopo aver chiesto a KaleidoSwap l'accesso al maker.
3. Chiediamo a KaleidoSwap quale test intendevano e l'accesso a `kaleidoswap-maker-rs`?

### Lavoro (variante A), tutto in `experiments/kaleidoswap/`
1. `docker/`: build dell'immagine dal fork a `1e4b1c3` con il tag **`kitty/rln:kaleido-next`** (la demo usa `settleup/rln:d4762ac`, che non tocco), con `CARGO_BUILD_JOBS=2` per contenere la RAM. Se `rgb-lib` `master` non compila, fisso il commit del `Cargo.lock` del fork e lo scrivo.
2. `compose.yaml`: progetto **`kitty-kaleido`**, bitcoind 28443, electrs 25001, proxy 23100, dave, alice, bob e charlie su 23201-23204, tutto su `127.0.0.1`, volumi propri.
3. `src/client/`: client tipizzato generato con `openapi-typescript` dall'`openapi.yaml` del fork (copiato in `experiments/kaleidoswap/vendor/`), con lo stesso stile di `packages/rln-client`, che non tocco.
4. `src/`: `node.ts` (init, unlock e chiamate), `chain.ts` (mining e invio BTC via RPC), `swap.ts` (lo scambio HODL di §3, prima riga: preimage di dave, HODL del viaggiatore, `/sendrgb` on-chain, `/refreshtransfers`, `/claimhodlinvoice`; cancel e scadenza), `e2e.ts`.
5. **e2e** (eseguito davvero, output in `RESULTS.md`):
   1. dave emette un NIA (precisione 2), lo manda a ciascun viaggiatore on-chain (100.00) e apre **un** canale verso ognuno con `D + L` = 80.00 e un `push_msat` da dimensionare; 6 blocchi;
   2. ogni viaggiatore porta i suoi D = 50.00 nel canale con lo scambio HODL; controllo i saldi on-chain e nel canale, i blocchi e i tempi;
   3. alice crea un invoice da 3.09, bob paga via dave: preimage verificata, saldi, latenza;
   4. charlie paga bob (bob riceve grazie a L);
   5. dave copre un invoice di charlie (garanzia: paga dal suo lato);
   6. dave chiude il canale di charlie: sweep, `/refreshtransfers`, DUSD di charlie tornati on-chain;
   7. fallimento: un viaggiatore non manda gli on-chain → `/cancelhodlinvoice` (e in un secondo caso la scadenza) → nessuno perde fondi; saldi identici a prima.
6. `RESULTS.md`: cosa funziona, numeri (blocchi, sat, tempi), confronto con `ln-2ch`, cosa servirebbe in `RlnWallet`, `seed.ts` e `LightningRail`, modifiche alla SPEC da proporre.

Commit piccoli, solo su questo branch, niente push. Non tocco lo stack `kitty`, `infra/`, `packages/rln-client` né l'immagine della demo. Se lo stesso errore si ripete 3 volte, mi fermo.
