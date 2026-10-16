# Stato stream A: dominio, AI, cervello dell'agente

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream A scrive qui.

## Task
- [x] K0 Sessione contratto (con C), branch `k0-contract`
- [ ] A1 deriveTrip
- [ ] A2 validateEvent
- [ ] A3 decideAutoPay
- [ ] A4 AI con QVAC + ai:eval
- [ ] A5 Flussi dell'agente (fake → reale)
- [ ] A7 liquidityPlan (SPEC §10.5)
- [ ] A6 (P1) Anti-injection e hash dei modelli

## Bloccato da
- niente

## Prossimo passo
- A1 `deriveTrip`: trasformare in test, in ordine, gli `it.todo` di `packages/ledger/test/kitty.test.ts`. Firme e tipi (`TripState`, `LineRecord`, `ValidationDeps`) in `packages/ledger/src/kitty.ts`.
- A4: il prompt dell'AI deve dire che `quantity` è intera; articoli a peso o volume → `quantity = 1`, misura nel label ("Bananas (0.73 kg)"), `unitPrice = total`. La divisione usa sempre il total della riga (JSDoc di `ReceiptItemSchema` e di `AiService.extractReceipt`).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### K0, ven 16/10 22:45
- Funziona: monorepo pnpm (`@kitty/*`), TS strict, regola lint sui soldi con test, CI; `packages/shared` (id, codec unico dei soldi, JSON canonico + `sha256Hex`, schemi di tutti i 17 eventi, dominio, viste, rotte, client tipizzato, errori con azione); ledger copiato da `_legacy` (cambi, divisione, saldi) con i test; stub di `deriveTrip`, `validateEvent(stored, trip, deps)`, `decideAutoPay`, `liquidityPlan`; interfacce `Wallet`, `Rail`, `AiService`, `RelayClient`; `FakeWallet`/`FakeAi` solo con `KITTY_FAKES=1`; scheletri di relay (:4000), agente (:4100) e web (:5173).
- Come si prova: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm dev:fakes` e apri `http://127.0.0.1:5173/?as=alice`.
- SPEC aggiornata (con approvazione del PM): §9.2 `payerCents`, `payerItemIndexes`; §9.3 `validateEvent(stored, trip, deps)`.
- Problemi noti: nessuno. Nessuna dipendenza nativa (QVAC, `@utexo/*`, SQLite) installata: vanno in PR dedicate.

