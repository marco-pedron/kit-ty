# Prompt 01: sessione contratto (Dev A alla tastiera, Dev C rivede; venerdì 10:45-13:15)

> Da incollare come primo messaggio di una sessione Claude Code nel nuovo repo `kit-ty`, su una sola macchina. Obiettivo: in circa due ore `main` contiene lo scheletro del monorepo e **tutte le interfacce** che servono ai tre stream per lavorare in parallelo senza toccarsi. Niente logica di prodotto.

---

Sei nella **sessione contratto** di kit+ty. Leggi `CLAUDE.md`, `docs/SPEC.md` (tutto) e `docs/PLAN.md` §2 e §5. Elenca il contenuto di `_legacy/` (struttura e `package.json`), senza leggere tutto il codice.

## Regole della sessione
- Branch `k0-contract`. Commit dopo ogni passo, scope `contract`.
- Scrivi solo: configurazione del monorepo, schemi zod, tipi, firme di funzioni, interfacce, stub, fake, scheletri dei server, dipendenze. Le uniche cose che **copi già funzionanti** da `_legacy/` sono il ledger esistente (cambi, divisione, saldi, utilità sui soldi) con i suoi test, e il client RLN.
- Importi: `bigint` in TypeScript, stringhe decimali di centesimi nel JSON. Un solo codec, riusato ovunque.
- Dopo ogni passo: `pnpm typecheck && pnpm lint && pnpm test` verdi; incolla l'esito.
- Fermati dopo il passo 0 e aspetta l'approvazione. Poi fermati solo per le decisioni umane indicate o dopo 3 fallimenti uguali.

## Passo 0: inventario e piano (poi aspetta)
Riporta in breve: cosa esporta `_legacy/packages/ledger` e `_legacy/packages/shared`; come è generato `_legacy/packages/rgb-client`; versioni di TypeScript, zod, vitest, eslint, fastify, `@qvac/sdk` e il campo `packageManager` nel vecchio `package.json`; la regola lint sui soldi.
Poi proponi: l'elenco esatto dei file dei passi 1-6, le dipendenze (nome, workspace, perché; solo quelle necessarie a SPEC §9, §11, §14), ogni conflitto tra SPEC e codice vecchio.
**Decisione umana:** elenco delle dipendenze e conflitti.

## Passo 1: scheletro del monorepo
- pnpm workspace con `packages/{shared,ledger,rln-client}` e `apps/{relay,agent,web}`; nomi `@kitty/*`.
- TypeScript strict con config di base condivisa; ESLint con la **regola sui soldi** portata da `_legacy` (niente `number` per gli importi, niente `Math.*`, `parseFloat` o letterali float nel codice monetario) e il suo test; Prettier; Vitest.
- Script radice: `typecheck`, `lint`, `test`, `dev` (relay + agent + web in parallelo). `engines.node >= 22.17`, `packageManager` come nel vecchio progetto.
- Verifica che `.github/workflows/ci.yml` funzioni con questi script.

## Passo 2: `packages/shared`
- `ids.ts`: `MemberId` (`alice | bob | charlie`), `CoordinatorId` (`dave`), `Role`, `TripId`, `ExpenseId`, `Pubkey`.
- `money.ts`: codec bigint ↔ stringa decimale di centesimi.
- `canonical.ts`: JSON canonico (chiavi ordinate, bigint come stringa, niente float; rifiuta `number` non interi) e `sha256Hex`, con test.
- `events.ts`: busta `SignedEvent` e `StoredEvent` (SPEC §9.1) e uno schema zod per **ogni** tipo di evento di SPEC §9.2, in un'unione discriminata su `type`.
- `domain.ts`: `Receipt`, `SplitProposal`, `AiResult<T>` (SPEC §11), `Policy` con i default di SPEC §8, `TripParams` (SPEC §15), `LineState` (SPEC §7), `PaymentProof` (SPEC §10.2), `DecodedInvoice`.
- `views.ts`: `TripView`, `MemberView`, `ExpenseView`, `LineView` (con stato, scadenza, motivo della decisione dell'agente), `DisputeView`, `DefaultView`, `ProofView` (i tre controlli di SPEC §10.2), `LedgerHealth` (SPEC §9.5).
- `api.ts`: tabella delle rotte di SPEC §14.3 (metodo, percorso, schema della richiesta e della risposta), `ApiError { code, message, action }` e i codici d'errore (`TOPUP_REQUIRED`, `NODE_UNREACHABLE`, `INVOICE_EXPIRED`, `AI_NOT_READY`, `TOTAL_MISMATCH`, `NOT_ALLOWED`, `INVALID_EVENT`, `NOT_IMPLEMENTED`, più quelli del ledger esistente).
- `client.ts`: `createAgentClient(baseUrl, as)` tipizzato dalla tabella delle rotte, sopra `fetch`, che decodifica con zod.
- `crypto.ts` (**proprietà di B**): solo l'interfaccia `SignatureVerifier` di SPEC §14.2 (`verify(authorPubkey, message, signature)`); il formato dipende dal motore del wallet (SPEC §9.1) e lo implementa B; il corpo lancia `NOT_IMPLEMENTED`. In più `fakeSign`/`fakeVerify` usabili solo con `KITTY_FAKES=1`.

**Decisione umana:** C rivede `api.ts` e `views.ts` (guidano la UI); B rivede `crypto.ts` e `PaymentProof` quando rientra dallo spike.

## Passo 3: `packages/ledger` e `packages/rln-client`
- Copia da `_legacy/packages/ledger` cambi, divisione, saldi, utilità e i loro test; adatta gli import a `@kitty/shared`. Lascia fuori `pot`, `kitty` e la semplificazione dei debiti. Test verdi.
- Stub con JSDoc che cita la regola di SPEC: `deriveTrip(events, now)`, `validateEvent(stored, trip, verify)`, `decideAutoPay(policy, line, trip, now)`, `liquidityPlan(trip)`. I corpi lanciano `NOT_IMPLEMENTED`.
- `test/kitty.test.ts` con la lista dei test dei task A1-A3 di `PLAN.md` come `it.todo(...)`: è la checklist di A.
- Copia `_legacy/packages/rgb-client` in `packages/rln-client` (`@kitty/rln-client`); conserva lo script di generazione da `docs/vendor/rln-openapi.yaml`.

## Passo 4: interfacce e fake dell'agente
- `apps/agent/src/wallet/types.ts`: `Wallet` di SPEC §14.2, motore-agnostico (`engine: 'wdk' | 'rln-rest'`). `apps/agent/src/rail/types.ts`: `Rail` con `pay`, `requestPayment`, `mode`.
- `apps/agent/src/ai/types.ts`: `AiService`. `apps/agent/src/relay/types.ts`: `RelayClient`.
- `apps/agent/src/dev-fakes/`: `FakeWallet` (invoice in memoria, preimage casuale con `paymentHash = sha256(preimage)`, saldi che si muovono, firma con `fakeSign`) e `FakeAi` (lo scontrino della cena di SPEC §15 e la divisione della demo, con 2 s di ritardo). Attivi solo con `KITTY_FAKES=1`, con un banner nei log e nella risposta di `/state`. `assertNoFakes()` per `demo:reset`.
- `apps/agent/src/config.ts`: variabili d'ambiente (URL dei 4 nodi, URL del relay, `KITTY_RAIL_MODE`, timer di SPEC §15, `KITTY_FAKES`), validate con zod.

## Passo 5: scheletri dei server e della UI
- `apps/relay`: Fastify su :4000 con `/health`. `apps/agent`: Fastify su :4100 con `/health` e un'istanza `Agent` per membro, ognuna con il solo `Wallet` del proprio membro (vuota per ora). `apps/web`: Vite + React + TypeScript + Tailwind su :5173, ruolo letto da `?as=`, una pagina che chiama `/state` con `createAgentClient`.
- `pnpm dev` avvia i tre e la pagina mostra il ruolo e "fakes on" quando serve.

## Passo 6: chiusura
- Verifica che `docs/status/a.md`, `b.md`, `c.md` esistano.
- `pnpm install` e commit del lockfile. Controllo finale verde. Stampa l'elenco dei commit del branch.

Poi fermati. Un umano apre la PR, A e C la rileggono, si mergia su `main` e si avvisa B.
