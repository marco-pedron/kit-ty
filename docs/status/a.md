# Stato stream A: dominio, AI, cervello dell'agente

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream A scrive qui.

## Task
- [x] K0 Sessione contratto (con C), branch `k0-contract`
- [x] A1 deriveTrip (branch `a/A1-derive-trip`)
- [x] A2 validateEvent (branch `a/A2-validate-event`)
- [ ] A3 decideAutoPay
- [ ] A4 AI con QVAC + ai:eval
- [ ] A5 Flussi dell'agente (fake → reale)
- [ ] A7 liquidityPlan (SPEC §10.5)
- [ ] A6 (P1) Anti-injection e hash dei modelli

## Bloccato da
- niente

## Prossimo passo
- A3 `decideAutoPay`: trasformare in test gli `it.todo` di A3. `TripState.autoPayments` è già derivato da `deriveTrip`; i log di test con invoice decodificabili e preimage vere sono in `packages/ledger/test/helpers.ts` (`Log.invoice`, `Log.proof`, `Log.check`).
- A4: il prompt dell'AI deve dire che `quantity` è intera; articoli a peso o volume → `quantity = 1`, misura nel label ("Bananas (0.73 kg)"), `unitPrice = total`. La divisione usa sempre il total della riga (JSDoc di `ReceiptItemSchema` e di `AiService.extractReceipt`).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### A2, sab 17/10
- Funziona: `validateEvent(stored, trip, deps)` (`packages/ledger/src/validate.ts`, riesportato da `kitty.ts`): catena (seq, prevHash, hash), firma via `deps.verify` su `signingMessage(inner)`, tripId, nonce (replay), autori (`EVENT_AUTHOR`: tipi di Dave solo da Dave, tipi dei membri mai da Dave, autore ammesso tranne `TRIP_CREATED`/`MEMBER_JOINED`), viaggio chiuso (solo `CHECKPOINT`), e le regole di ogni tipo di SPEC §9.3. Non lancia mai: un errore del decoder o del ledger diventa un rifiuto con il motivo.
- **Come chiamarlo (relay e agente, avvisare C):** `validateEvent(stored, deriveTrip(precedenti, new Date(stored.receivedAt)), deps)`, così lo stato delle righe è quello al momento della ricezione. La forma va già parsata con `StoredEventSchema`.
- Scelte (approvate): tasso = solo l'**ultimo** `RATE_SET` (USD = "1"); `INVOICE_REISSUED` solo con l'invoice precedente scaduto; `bindInvoice: null` rifiutato (rln-rest). Descrizione dell'invoice di legame `kitty-bind:${sha256Hex(appPubkey)}` (sha256 della stringa hex, come il `FakeWallet` di K0: **B4 e B3 devono usare lo stesso formato**). Invoice di riga: payee = nodo del pagatore, asset del viaggio, importo della riga, descrizione `kitty:<tripId>:<expenseId>:<debtor memberId>`, non scaduto alla ricezione, payment hash distinti. Preimage: `sha256(byte della preimage) = paymentHash`.
- Aggiunti al ledger: `expenseFingerprint(receipt, receiptImageSha256)` (`shares.ts`) e `hexToBytes` (`hex.ts`), da usare anche in A5.
- Come si prova: `pnpm test` (blocco "A2 validateEvent"): un log con tutti i 17 tipi di evento passa evento per evento; un test per ogni regola di rifiuto.
- Problemi noti: `PAYMENT_MADE` on-chain accettato con il solo `txid` (una funzione pura non può cercarlo sulla catena; la verifica va nel pannello Prova). `CHECKPOINT` controlla solo che `seq` esista: il confronto delle teste è in UI (P1).

### A1, sab 17/10 10:05
- Funziona: `deriveTrip(events, now): TripState | null` (`packages/ledger/src/kitty.ts`), tutti gli stati di SPEC §7; `expenseShares` (`packages/ledger/src/shares.ts`): scontrino + chi condivide cosa + tasso → quote in centesimi (cena: 3.09 / 3.09 / 3.50 su 9.68).
- Scelte (approvate): orologio = `receivedAt` del relay; `null` per un log vuoto (**cambio di firma, avvisare C**). Prima di ogni evento scattano le scadenze fino al suo `receivedAt` (con `>=`: esattamente alla scadenza la transizione è avvenuta), quindi il silenzio-assenso usa la policy in vigore alla scadenza. Silenzio-assenso se `cents ≤ autoPayLimitCents`. Un evento non applicabile allo stato della riga non cambia nulla (lo rifiuta A2).
- Campi aggiunti ai tipi del ledger (non a `shared`): `LineRecord.paymentDeadlineAt`, `overdueAt`, `contestedAt`; `MemberState.oweCents`, `owedToMeCents`; `TripState.defaults` (righe `overdue`, la più vecchia prima).
- Esclusione: tutte le righe aperte del membro come debitore diventano `overdue` (anche `submitted` e `contested`); quelle in cui è creditore restano. Spesa annullata (`EXPENSE_VOIDED` o `expense_voided`): le righe già `paid`/`guaranteed` restano, il fingerprint viene liberato per poterla reinviare corretta.
- `autoPayments`: i `PAYMENT_MADE` su righe senza approvazione esplicita (un `approve` su una riga `due` confermata da Dave la rende esplicita).
- Come si prova: `pnpm test` (blocco "A1 deriveTrip" e "expenseShares" di `packages/ledger/test/kitty.test.ts`, inclusa la proprietà fast-check Σ righe + quota pagatore = totale).
- Problemi noti: un debitore che non pubblica mai `LINE_SEEN` non va mai in `overdue` (SPEC: la scadenza parte da lì; in demo l'agente lo pubblica da solo; Dave può comunque escluderlo). Con `expense_voided` dopo un pagamento, chi ha già pagato va rimborsato fuori dalla piattaforma.

### K0, ven 16/10 22:45
- Funziona: monorepo pnpm (`@kitty/*`), TS strict, regola lint sui soldi con test, CI; `packages/shared` (id, codec unico dei soldi, JSON canonico + `sha256Hex`, schemi di tutti i 17 eventi, dominio, viste, rotte, client tipizzato, errori con azione); ledger copiato da `_legacy` (cambi, divisione, saldi) con i test; stub di `deriveTrip`, `validateEvent(stored, trip, deps)`, `decideAutoPay`, `liquidityPlan`; interfacce `Wallet`, `Rail`, `AiService`, `RelayClient`; `FakeWallet`/`FakeAi` solo con `KITTY_FAKES=1`; scheletri di relay (:4000), agente (:4100) e web (:5173).
- Come si prova: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm dev:fakes` e apri `http://127.0.0.1:5173/?as=alice`.
- SPEC aggiornata (con approvazione del PM): §9.2 `payerCents`, `payerItemIndexes`; §9.3 `validateEvent(stored, trip, deps)`.
- Problemi noti: nessuno. Nessuna dipendenza nativa (QVAC, `@utexo/*`, SQLite) installata: vanno in PR dedicate.

