# Tappe 1 e 2: esito e piano della tappa 3

> Branch `experiment/rgb-lightning-node`, stack `kitty-kaleido` (porte 23xxx e 28443, volumi propri). Lo stack `kitty` della demo non è mai stato toccato. Log completi in `.out/stage1.log` e `.out/stage2.log` (gitignored).

## Componenti usati (commit esatti)

| Pezzo | Repo e commit | Come |
|---|---|---|
| Nodo Lightning | `kaleidoswap/rgb-lightning-node` `1e4b1c3905ace8833ceebbdf06fb69f79aac340d` (`kaleido/next`); submodule `bitwalt/rust-lightning` `65e84530`; rgb-lib (in RLN) `RGB-Tools/rgb-lib` `2b9af115` (dal `Cargo.lock` del fork) | immagine `kitty/rln:kaleido-next` (`39b4e78fe759`), costruita con il loro Dockerfile più `CARGO_BUILD_JOBS=2` (circa 15 min) |
| HTLC on-chain | `kaleidoswap/rgb-lib` `dbdf82dac3ffd2a41b1ec3cc9b410c5a4fa56f2f` (pubblico; quello fissato da `kaleidoswap-sdk` `385254a` `examples/rgb-regtest`) | `htlc-tool/` (Rust, nostro), immagine `kitty/htlc-tool:dev`, `Cargo.lock` di partenza preso da rgb-lib |
| Logica dell'HTLC | `kaleidoswap/rgb-lib` `src/wallet/test/htlc_swap_tree.rs` (commit `ec7466a`) e `kaleidoswap-sdk` `examples/rgb-regtest/src/wallet.rs` | adattata in `htlc-tool/src/main.rs` |

**Perché non `PreparedRgbSpend` dell'SDK:** `PreparedRgbSpend::new` (`src/swaps/rgb.rs:757`) ammette solo le spese del *taker*, cioè il claim di una reverse swap o il refund di una submarine. Il nostro schema ha bisogno di entrambe sullo stesso HTLC: claim di dave e refund del viaggiatore. La spesa mancante è quella del maker, che sta nel repo privato. Il test HTLC del fork di rgb-lib firma a mano tutte e due le foglie e non ha questo limite. L'HTLC è lo stesso albero Boltz (claim `OP_HASH160 <ripemd160(H)> OP_EQUALVERIFY <dave> OP_CHECKSIG`, refund `<viaggiatore> OP_CHECKSIGVERIFY <T> OP_CLTV`). La chiave interna è il punto NUMS di BIP341, quindi non esiste la spesa per chiave, che chi conosce quella chiave potrebbe usare.

## Punto di verifica 1: invoice HODL RGB sul fork ✅

`node src/stage1-hodl.ts`, dave e alice:

| Passo | Risultato |
|---|---|
| NIA emesso su dave | 1 000 000 unità (10 000.00), precisione 2 |
| **Un** canale dave → alice, `asset_amount` 8000 (D + L), `push_msat` 300 000 000, 1 000 000 sat, pubblico | usabile dopo **6 blocchi**; dave 8000 asset, 699 013 sat; alice 0 asset, 300 000 sat |
| HODL di alice (hash scelto da lei, 5000, `expiry_sec` 900) | `min_final_cltv_expiry_delta` di default = **42**; un secondo invoice con lo stesso hash → `400 PaymentHashAlreadyUsed` |
| dave `/sendpayment` | `Pending`; alice `Claimable` in **0,63 s**; `/invoicestatus` `Claimable`; dave **senza** preimage |
| preimage sbagliata | `400 InvalidPaymentPreimage` |
| `/claimhodlinvoice` con P | dave `Succeeded` dopo 0,36 s (**1,0 s in tutto, 0 blocchi**); `/getpayment` di dave restituisce `preimage = P`, e `sha256(P) = H` ✓ |
| canale dopo lo scambio | alice 5000 / dave 3000 asset; alice 303 000 sat (+3000 sat portati dall'HTLC) |
| `/cancelhodlinvoice` | dave `Failed`, alice `Cancelled`, saldi identici |
| scadenza per blocchi (mai riscosso) | rimandato indietro dopo **157 blocchi** (pagato a 113, fallito a 270); poi `/claimhodlinvoice` → `404 InvoiceNotClaimable`; saldi identici |
| scadenza per tempo (invoice da 5 s pagato dopo 7 s) | `/sendpayment` `Failed`, `/invoicestatus` `Expired` |

Differenze di API trovate e gestite: `/getpayment` **richiede** `payment_type` (`Outbound` / `InboundHodl` / `InboundAutoClaim`); `Payment.inbound` non esiste più; nuovi stati `Claimable`, `Claiming`, `Cancelled`.

## Punto di verifica 2: HTLC RGB on-chain con asset nati su RLN ✅

`node src/stage2-htlc.ts`, sullo stesso stack:

| Passo | Risultato |
|---|---|
| on-ramp RLN → RLN (dave → alice, 100.00 on-chain) | `Settled` dopo 1 blocco |
| **blocco dal nodo RLN di alice**: `/sendrgb` al `wvout:` dell'HTLC con `witness_data { amount_sat: 1000, blinding }` | tx `2bc2d37a…:1`, 1 blocco; alice settled 10000 → 5000 |
| dave (wallet rgb-lib del fork) accetta il blocco: `fetch_and_accept_transfer_by_recipient_id` (asset, schema NIA, 5000) | `[Fungible(5000)]` sull'outpoint dell'HTLC → **la consignment di RLN (rgb-lib `2b9af11`) è accettata dal fork (`dbdf82d`)** |
| claim con preimage sbagliata | il nodo la rifiuta: `Script failed an OP_EQUALVERIFY operation` |
| claim con P | confermato (1 blocco + 1 dopo `psbt_op_apply`), 5000 `settled` nel wallet di dave, 4,0 s |
| verso il nodo RLN di dave (`/rgbinvoice` blinded + `send`) | dave settled +5000 → **la consignment del fork è accettata da RLN** |
| secondo blocco (2000, T = h + 15) e refund prima di T | `non-final` (rifiutato) |
| refund dopo 14 blocchi minati fino a T | confermato, 2000 `settled` nel wallet rgb-lib di alice, poi rimandati al suo nodo RLN: 3000 → 5000 |
| conservazione | dave 987 000 on-chain + 3000 nel canale; alice 5000 on-chain + 5000 nel canale = **1 000 000** ✓ |

Costi per HTLC: 1000 sat sull'output dell'HTLC (vanno a chi lo spende), fee del blocco pagata dal nodo RLN, fee della spesa 1500 sat (fissa nel tool, su regtest).

**Limite strutturale trovato:** RLN via REST sa **bloccare** (con `/sendrgb` a un recipient witness), ma non sa **spendere** un HTLC colorato, perché non espone le operazioni PSBT. Il claim (dave) e il refund (viaggiatore) richiedono quindi un wallet rgb-lib del fork **accanto** al nodo RLN di ciascuno. Le due librerie sono compatibili sulle consignment in entrambe le direzioni (provato sopra).

## Valori di T_onchain e perché

- Il pagamento LN trattenuto viene rimandato indietro **157 blocchi** dopo il pagamento, con il `min_final_cltv_expiry_delta` di default (42): LDK aggiunge margini propri. Fino a quel momento il viaggiatore può riscuotere, quindi rivelare P.
- Rischio di dave: il viaggiatore riscuote tardi (rivela P al blocco h_pay + 157) e dave deve **confermare** il claim on-chain prima di T_onchain; altrimenti il viaggiatore fa anche il refund e prende due volte D.
- Vincolo: `T_onchain ≥ h_pay + LN_deadline + margine`; e dave paga solo se `T_onchain − altezza attuale ≥ LN_deadline + margine`.
- **Valori per la tappa 3 (regtest):** `min_final_cltv_expiry_delta` esplicito nell'invoice HODL (misuro di nuovo la scadenza effettiva con quel valore), `LN_deadline` misurata, **margine 72 blocchi** (circa 12 ore in produzione, per confermare il claim anche con fee alte), quindi **T_onchain = h_lock + 300**. dave rifiuta di pagare se mancano meno di `LN_deadline + 72` blocchi a T. In produzione questi numeri vanno ripensati con le altezze reali (un giorno ≈ 144 blocchi).
- Rischio del viaggiatore: nessuno. P esce solo con la sua riscossione LN, che lo paga; dave senza P non può spendere la foglia di claim.

## Piano della tappa 3 (da approvare)

**Linguaggio:** TypeScript, come le tappe 1 e 2, più la CLI Rust `htlc-tool` in Docker. **Non servono i binding dell'SDK** (né Python né TypeScript): l'SDK non copre lo scambio con i ruoli invertiti.

**Stack:** `scripts/stack.sh reset` (solo `kitty-kaleido`) e `rm -rf run/wallets`, poi `stack.sh up full` (bitcoind, electrs, esplora, proxy e 4 nodi RLN: 8 container, 2 in più rispetto a ora).

`src/stage3-e2e.ts`, con blocchi, sat e tempi misurati per ogni passo:
1. **Setup:** dave emette il NIA; on-ramp on-chain di 100.00 a alice, bob e charlie; dave apre **un** canale verso ciascuno (8000 asset, `push_msat` 300 000 000, 1 000 000 sat), in sequenza, poi 6 blocchi.
2. **Scambio atomico riuscito** per ogni viaggiatore:
   1. il viaggiatore genera P e H e una chiave di refund; dave dà la sua chiave di claim e T;
   2. il viaggiatore blocca D = 5000 on-chain dal suo nodo RLN; il suo wallet rgb-lib accetta il blocco (serve per un eventuale refund);
   3. dave **verifica**: ricalcola lo script da (H, la sua chiave, la chiave del viaggiatore, T) e lo confronta con l'output del blocco (1000 sat), accetta la consignment (asset, schema, 5000), controlla 1 conferma e il margine su T;
   4. il viaggiatore crea l'HODL (H, 5000, delta esplicito); dave lo decodifica (hash, importo, asset, `payee_pubkey` del viaggiatore) e paga;
   5. il viaggiatore `/claimhodlinvoice`; dave legge P da `/getpayment` e riscuote on-chain, poi manda i 5000 al suo nodo RLN.
   
   Atteso: canale 5000 lato viaggiatore e 3000 lato dave; il viaggiatore ha 50.00 on-chain in meno, dave 50.00 in più.
3. **Il viaggiatore non riscuote** (un secondo giro con bob, 1000): dave ha pagato e l'HTLC è `Claimable`; dave prova a riscuotere on-chain con una P falsa e viene rifiutato; si minano blocchi fino a `Failed` (dave riavrà i suoi asset nel canale), poi fino a T; il viaggiatore fa il refund e rimanda i fondi al suo nodo RLN. Atteso: nessun saldo cambiato, a parte le fee in sat.
4. **3.09 da bob ad alice via dave:** preimage verificata, saldi dei due canali, latenza, blocchi = 0.
5. **charlie paga bob** (bob riceve grazie a L).
6. **Garanzia:** charlie crea un invoice; dave lo paga dal suo lato.
7. **Chiusura** cooperativa del canale di charlie da dave: si mina finché la chiusura è confermata, poi 6 blocchi per lo sweep, poi `/refreshtransfers`; DUSD di charlie on-chain = il suo saldo nel canale.
8. Controllo di conservazione su tutto l'emesso.

**Fine:** `RESULTS.md` con tutto questo, la finestra di fiducia (attesa zero: P esce solo con il pagamento LN, e dave senza P non può spendere), il confronto con `ln-2ch` e cosa servirebbe per portarlo in `RlnWallet`, `seed.ts` e `LightningRail`.

Rischi noti: il routing a più hop (bob → dave → alice) su canali pubblici appena aperti potrebbe richiedere qualche secondo di gossip; il test dei 157 blocchi va rifatto con il delta esplicito; RAM con 6 container RLN e il tool (oggi 31-33% libera con la demo accesa).
