# Stato stream A: dominio, AI, cervello dell'agente

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream A scrive qui.

## Task
- [x] K0 Sessione contratto (con C), branch `k0-contract`
- [x] A1 deriveTrip (branch `a/A1-derive-trip`)
- [ ] A2 validateEvent
- [ ] A3 decideAutoPay
- [ ] A4 AI con QVAC + ai:eval
- [ ] A5 Flussi dell'agente (fake → reale)
- [ ] A7 liquidityPlan (SPEC §10.5)
- [ ] A6 (P1) Anti-injection e hash dei modelli

## Bloccato da
- niente

## Prossimo passo
- A2 `validateEvent`: trasformare in test gli `it.todo` di A2 in `packages/ledger/test/kitty.test.ts`. Per ricalcolare le quote usare `expenseShares` (`packages/ledger/src/shares.ts`); i costruttori di log con catena vera sono in `packages/ledger/test/helpers.ts`. Deve rifiutare le transizioni che `deriveTrip` ignora (es. contestazione dopo il silenzio-assenso).
- A4: il prompt dell'AI deve dire che `quantity` è intera; articoli a peso o volume → `quantity = 1`, misura nel label ("Bananas (0.73 kg)"), `unitPrice = total`. La divisione usa sempre il total della riga (JSDoc di `ReceiptItemSchema` e di `AiService.extractReceipt`).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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

