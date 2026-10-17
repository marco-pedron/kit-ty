# Stato stream A: dominio, AI, cervello dell'agente

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream A scrive qui.

## Task
- [x] K0 Sessione contratto (con C), branch `k0-contract`
- [x] A1 deriveTrip (branch `a/A1-derive-trip`)
- [x] A2 validateEvent (branch `a/A2-validate-event`)
- [x] A3 decideAutoPay (branch `a/A3-decide-auto-pay`)
- [ ] A4 AI con QVAC + ai:eval
- [ ] A5 Flussi dell'agente (fake → reale): **A5a fatto** (branch `a/A5-agent-flows`), A5b (Dave, ingresso nel viaggio, passi 2-7) da fare
- [x] A7 liquidityPlan (SPEC §10.5) (branch `a/A7-liquidity-plan`)
- [ ] A6 (P1) Anti-injection e hash dei modelli

## Bloccato da
- niente

## Prossimo passo
- A5b: `flows/dave.ts` (`setRate`, `resolveDispute`, `coverAndExclude`), ingresso nel viaggio (`joinTrip`, `createTrip`, `admit`, `channelsReady`) e il test completo dei passi 2-7 di SPEC §16.
- **Per il PM, SPEC §10.5 punto 2:** sostituire "per `daRicevere(m) − margine(m) + soglia`" con "per `soglia − margine(m)`" (vedi registro A7).
- A4: il prompt dell'AI deve dire che `quantity` è intera; articoli a peso o volume → `quantity = 1`, misura nel label ("Bananas (0.73 kg)"), `unitPrice = total`. La divisione usa sempre il total della riga (JSDoc di `ReceiptItemSchema` e di `AiService.extractReceipt`).

## API di `MemberAgent` per C3 (`apps/agent/src/flows/member-agent.ts`)
Un'istanza per attore (alice, bob, charlie, dave), costruita da chi costruisce gli agenti (`server.ts`):
```ts
new MemberAgent({
  actor,                 // 'alice' | 'bob' | 'charlie' | 'dave'
  wallet,                // SOLO il wallet di quel membro
  relay,                 // RelayClient (C2)
  verifier,              // KITTY_FAKES=1 → fakeVerifier; altrimenti signatureVerifier (B4)
  now?,                  // orologio iniettato, default new Date()
  tripId?,               // solo per pubblicare prima di TRIP_CREATED (default 'vietnam-2026')
  retryMs?,              // back-off di un pagamento fallito, default 10 s
  checkpointEvery?,      // default 10 eventi
})
```
- **Loop:** il server chiama `agent.tick()` ogni secondo per ogni agente (un tick chiamato mentre il precedente è ancora in corso ritorna subito, lo garantisce l'agente). `tick()` = sync con il relay e validazione locale, `LINE_SEEN`, pagamenti automatici (uno alla volta, in background), `INVOICE_REISSUED` degli invoice scaduti, `CHECKPOINT`. `await agent.idle()` aspetta i pagamenti in volo (test, spegnimento).
- **Lettura per `GET /state`:**
  - `agent.trip()` → `TripState | null` (dalla copia verificata, all'ora corrente): membri, spese, righe, `defaults`, `rate`.
  - `agent.me()` → `MemberState | null` (null per Dave); `agent.policy()`.
  - `agent.decisionFor(line)` → `AutoPayDecision | null`: il campo `LineView.agent` delle righe in cui l'agente è debitore (null per le altre).
  - `agent.activity()` → `ActivityItem[]` con `kind: 'AGENT'` (decisioni e pagamenti dell'agente, il più recente prima, con `proof`); le righe degli eventi del registro le costruisce la rotta dai `trip().expenses/lines`.
  - `agent.operations()` → `OperationView[]` (`paying`, `submitting_expense`, con errore e azione se fallisce).
  - `agent.log.health()` → `LedgerHealth` ("Registro verificato"); `agent.log.divergence` → `{ seq, hash, reason } | null` se il relay ha consegnato un evento che l'agente rifiuta (da quel momento la copia è congelata e `chainValid` è false).
  - `agent.log.invoices` → `Map<bolt11, DecodedInvoice>` decodificati dal proprio nodo (per `invoiceExpiresAt` di `LineView` e il pannello Prova).
- **Azioni (lanciano `FlowError`, `WalletError` o `LedgerError`, tutte con un `code` di `ErrorCode`; `FlowError`/`WalletError` hanno `toApiError()`):**
  - `previewSplit(receipt, assignments)` → `SplitPreview` (sincrono) per `POST /expenses/split`.
  - `submitExpense(receipt, assignments, receiptImageSha256)` → `StoredEvent` di `EXPENSE_SUBMITTED` per `POST /expenses`; l'`expenseId` è generato dall'agente (`body.expenseId`).
  - `decide(expenseId, 'approve' | 'contest', reason?)` → `LineRecord` per `POST /expenses/:id/decision`.
  - `voidExpense(expenseId)` per `POST /expenses/:id/void`.
  - `updatePolicy(policy)` → `Policy` per `PUT /policy`.
  - Dave (A5b): `resolveDispute`, `coverAndExclude`, `setRate`.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### A5a, sab 17/10
- Funziona (con `KITTY_FAKES=1`): `apps/agent/src/flows/`
  - `local-log.ts`: copia verificata del registro. Ogni evento del relay passa da `validateEvent` con il `trip` derivato a `receivedAt`; gli invoice li decodifica il **nodo del membro** (`wallet.decodeInvoice`, in cache, perché `validateEvent` vuole un decoder sincrono). Primo evento rifiutato → copia congelata, `chainValid: false`, motivo in `divergence`. Nodo irraggiungibile → nessun rifiuto, si riprova al tick dopo.
  - `publish.ts`: `inner` con nonce casuale di 16 byte, firma con il wallet del membro, `relay.append`.
  - `expense.ts`: `planExpense` (assegnazioni → quote del ledger con il tasso del giorno; ogni riga assegnata una volta, solo viaggiatori attivi, quota a 0.00 rifiutata) e `previewOf`.
  - `member-agent.ts`: `MemberAgent` (API sopra). Pagamenti uno alla volta per membro; una prova già ottenuta ma non pubblicata resta in memoria e viene ripubblicata, mai ripagata; pagamento fallito ritentato dopo il back-off.
- Scelte (approvate): opzione A (l'agente non è collegato al server: lo fa C3); `fakeVerifier` con i fake, `signatureVerifier` senza; l'agente decodifica con il proprio nodo, non con il decoder JS del relay (che sta in `apps/relay` e non legge gli invoice del `FakeWallet`).
- Come si prova: `pnpm test` (`apps/agent/src/flows/member-agent.test.ts`, relay in memoria con il vero `validateEvent`, quattro `FakeWallet`, orologio manuale): seed verificato da ogni agente; anteprima 3.09/3.09/3.50; **alice invia la cena → charlie contesta → bob, in silenzio, paga in automatico esattamente a 20 s**, preimage verificata, saldi spostati, una sola `PAYMENT_MADE`, stessa testa del registro su 4/4; sopra limite paga solo dopo l'approvazione; pagamento fallito (`TOPUP_REQUIRED`) ritentato; invoice scaduto riemesso e pagato; `CHECKPOINT` ogni 10 eventi; evento falsificato dal relay rifiutato da ogni agente.
- Problemi noti:
  - Nessuna azione per pagare a mano una riga `overdue` ("Pay it yourself" di `decideAutoPay`): manca anche la rotta in `api.ts`. In demo non serve (Charlie non paga). Da decidere con il PM.
  - Doppio controllo degli invoice con il decoder JS (spostarlo in `packages/shared`): P1.
  - Collaudo con il wallet reale (★3) dopo B3, C2 e B2.

### A7, sab 17/10
- Funziona: `liquidityPlan(trip, thresholdCents, extraLiquidity?)` (`packages/ledger/src/liquidity.ts`, riesportato da `kitty.ts`): una voce per membro attivo (canali pronti, non escluso) con `inboundCents`, `toReceiveCents`, `marginCents`, `openCents`.
- `inbound = L + extra + inviato − ricevuto`: L = `params.liquidityCents`; inviato = righe pagate da m via Lightning; ricevuto = righe a favore di m pagate via Lightning o coperte dalla garanzia; i pagamenti on-chain non toccano i canali. `daRicevere` = righe aperte a favore di m, contestate e scadute incluse.
- **Scelte approvate:**
  - apertura = `soglia − margine` quando margine < soglia. La formula di SPEC §10.5 (`daRicevere − margine + soglia`) apre troppo, esattamente di `daRicevere`: con inbound 30.00, da ricevere 45.00, soglia 5.00 aprirebbe 65.00 invece di 20.00. **Proposta di modifica alla SPEC per il PM**, non applicata.
  - terzo parametro `extraLiquidity: ReadonlyMap<Pubkey, bigint>` (default vuoto): la liquidità aperta da Dave dopo il primo canale, che il registro non contiene; la passa l'agente di Dave dal proprio nodo (B9). Senza, il piano richiederebbe la stessa apertura a ogni evento.
- Come si prova: `pnpm test` (blocco "A7 liquidityPlan": i 5 casi della checklist, più on-chain che non conta, `extraLiquidity` che azzera l'apertura, cena della demo: alice inbound 30.00, da ricevere 6.59, margine 23.41).
- Problemi noti: la soglia la sceglie chi chiama (agente di Dave, B9); non c'è ancora un valore in `TripParams`.

### A3, sab 17/10
- Funziona: `decideAutoPay(policy, line, trip, now, invoice)` (`packages/ledger/src/autopay.ts`, riesportato da `kitty.ts`) e `autoPaidLast24h(trip, debtor, now)`.
- **Cambio di firma (approvato, opzione A; avvisare C):** quinto parametro `invoice: DecodedInvoice | null`, decodificato dall'agente con il proprio nodo (`Wallet.decodeInvoice` di `line.bolt11`). `null` = non leggibile → non paga. Per `LineView.agent` di un debitore le rotte possono passare il decodificato o `null` (la frase degli stati non `due` non dipende dall'invoice).
- Regole: paga solo una riga `due` di un viaggio aperto, debitore e creditore non esclusi (creditore escluso → "pay on-chain"), spesa non annullata e con Σ che torna, invoice = quello firmato nel registro, payee = nodo del creditore, asset del viaggio, importo della riga, non scaduto; riga confermata da Dave senza approvazione esplicita solo con `payUpheldDisputes`. Per i pagamenti automatici: importo ≤ `autoPayLimitCents` (ricontrollato: la policy può cambiare dopo l'assenso) e tetto `dailyCapCents` su 24 h mobili (un pagamento di esattamente 24 h fa non conta più). L'approvazione esplicita salta limite e tetto (SPEC §8).
- `reason` per ogni stato, in inglese, per la UI: es. "Paying 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00." (prima di pagare), "Paid 3.09 to alice automatically: …" (dopo), "Will pay 3.09 to alice in 8 s unless you object.", "Not paid: 45.00 is above your automatic limit of 20.00. Approve it yourself.", tetto giornaliero, invoice scaduto, contestata, confermata da Dave, scaduta, coperta, annullata, viaggio chiuso.
- Come si prova: `pnpm test` (blocco "A3 decideAutoPay": gli 8 casi della checklist più frasi degli stati, policy abbassata dopo l'assenso, finestra mobile esatta, creditore escluso).
- Problemi noti: un creditore escluso non viene pagato in automatico (il rail on-chain B5 è P1): la riga resta `due` e poi `overdue` finché non c'è il rail on-chain; nemmeno la copertura di Dave funziona, perché paga via Lightning e il creditore escluso non ha più canali. Fuori dal percorso della demo.

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

