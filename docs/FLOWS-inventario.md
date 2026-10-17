# Inventario per C4: cosa c'è oggi (sab 17/10, `main` a `33a5615`)

> Fonti lette: `docs/SPEC.md`, `docs/PLAN.md`, `docs/status/{a,b,c}.md`, `packages/shared/src/{api,views,domain,events,errors,money}.ts`, `packages/ledger/src/{kitty,autopay,validate}.ts`, `apps/agent/src/routes/*`, `apps/agent/src/flows/*`, `apps/agent/src/dev-fakes/fake-ai.ts`, `apps/web/src/App.tsx`.
> Glossario: **parte** = quanto un membro deve per una spesa (`LineView.cents`); **limite** = cifra sotto la quale l'agente paga da solo (`Policy.autoPayLimitCents`).

## 1. Ruoli e cosa vede ciascuno
| Ruolo | Vede (`GET /api/:as/state` → `TripView`) | Non vede |
|---|---|---|
| **Viaggiatore** (alice, bob, charlie) | `me`: policy, saldo del **proprio** nodo (`balance`, `null` se il nodo non risponde), `oweCents`, `owedToMeCents`, `autoPaidTodayCents`, `debts` (le sue parti), `credits` (le parti dovute a lui); tutte le spese (`expenses`) e i membri (`members`, senza saldi); `activity`, `operations`, `ai`, `ledger` | saldi altrui; `coordinator` (sempre `null`, imposto da `TripViewSchema.superRefine`) |
| **Dave** | `coordinator`: per membro garanzia usata/residua, credito dell'operatore, margine di liquidità; `disputes`; `defaults` (con `coverable`); spese, membri, attività, registro | `me` (`null`): nessun saldo dei viaggiatori e nemmeno il proprio |
| **Agente** (uno per attore, `MemberAgent`/`CoordinatorAgent`) | la propria copia verificata del registro; ogni secondo `tick()`: sync, `LINE_SEEN`, pagamenti automatici, riemissione invoice, `CHECKPOINT` | non è un ruolo della UI: si vede tramite `LineView.agent` (decisione + motivo), `activity` con `kind: 'AGENT'`, `operations` |

## 2. Stati
**Riga** (spesa, debitore), derivata da `deriveTrip` (`packages/ledger/src/kitty.ts`):

| Stato | Causa d'ingresso | Chi/cosa la provoca |
|---|---|---|
| `submitted` | `EXPENSE_SUBMITTED` | agente del pagatore (`POST /expenses`) |
| `awaiting_decision` | `LINE_SEEN`; fine finestra = seenAt + 20 s | agente del debitore, da solo |
| `due` | approvata, oppure finestra scaduta con parte ≤ limite, oppure contestazione confermata | debitore (`approve`), orologio, Dave (`upheld`) |
| `awaiting_explicit` | finestra scaduta con parte > limite | orologio |
| `contested` | `LINE_DECIDED{contest}` (solo da `submitted`/`awaiting_*`) | debitore |
| `overdue` | seenAt + 30 s senza pagamento (da `due`/`awaiting_explicit`), oppure debitore escluso | orologio, Dave |
| `paid` | `PAYMENT_MADE` | agente del debitore |
| `guaranteed` | `GUARANTEE_PAID` | agente di Dave (Copri ed escludi) |
| `voided` | `EXPENSE_VOIDED`, `DISPUTE_RESOLVED{line_voided, expense_voided}` | pagatore, Dave |

**Spesa** (`ExpenseView.status`): `open` → `settled` (tutte le righe finali) | `voided`.
**Membro** (`MemberView.status`): `joined` → `admitted` → `active` (`CHANNELS_READY`) → `excluded` (`MEMBER_EXCLUDED`). "Insolvente" non è uno stato del membro: è una riga in `coordinator.defaults` (stato `overdue`).

## 3. Azioni
| Azione | Ruolo | Stato richiesto | Rotta | Se vietata |
|---|---|---|---|---|
| Leggi scontrino | viaggiatore | AI `ready` | `POST /api/:as/expenses/extract` | 503 `AI_NOT_READY` |
| Proponi divisione | viaggiatore | AI `ready`, membro attivo | `POST /api/:as/expenses/split` | 503 `AI_NOT_READY`; `preview: null` se non valida |
| Invia spesa | viaggiatore attivo | tasso del giorno presente, debitori attivi | `POST /api/:as/expenses` | 400 (`TOTAL_MISMATCH`, `MISSING_RATE`, …), 409 `INVALID_EVENT` dal relay |
| Approva | debitore | `submitted`/`awaiting_*`, oppure `due`/`overdue` confermata e non ancora approvata | `POST /api/:as/expenses/:id/decision {approve}` | 409 `INVALID_EVENT` ("a … line cannot be approved") |
| Contesta | debitore | `submitted`/`awaiting_*` (cioè **solo durante la finestra** o oltre limite) | idem `{contest, reason}` | 400 senza motivo; 409 su `due` |
| Annulla spesa | pagatore | nessuna riga `paid`/`guaranteed` | `POST /api/:as/expenses/:id/void` | 403 `NOT_ALLOWED` se non pagatore; 409 se già pagata |
| Imposta limite | viaggiatore membro | sempre, anche durante il viaggio | `PUT /api/:as/policy {policy}` (policy intera) | 403 se Dave |
| Risolvi contestazione | Dave | `contested` | `POST /api/dave/disputes/:expenseId/:member` | 403 "is …, not contested" |
| Copri ed escludi | Dave | `overdue` | `POST /api/dave/defaults/:expenseId/:member/cover-and-exclude` | 403 "not overdue"; 409 `INVOICE_EXPIRED`; `covered: null` oltre G |
| Tasso del giorno | Dave | sempre | `PUT /api/dave/rates` | 403 |
| Prova | tutti | pagamento nel registro | `GET /api/proof/:paymentHash` | 404 (per ~1 s dopo il pagamento, vedi b.md B8) |
| Ruolo sbagliato | — | — | qualsiasi | 403 `NOT_ALLOWED` con azione "Switch to …" |

## 4. Regole da far capire
- **Limite**: sotto il limite, se nessuno obietta nella finestra, l'agente paga da solo. Sopra il limite serve "Approve". Un'approvazione esplicita paga sempre, anche oltre limite e tetto giornaliero (`decideAutoPay`).
- **Tetto giornaliero** (`dailyCapCents`, 60.00): massimo pagato in automatico in 24 h. Esiste nel ledger anche se la funzione "Pagamento automatico" non lo mostra (domanda 2 di FLOWS.md).
- **Silenzio-assenso / finestra**: 20 s da quando il **tuo** agente ha visto la spesa (`LINE_SEEN`), non dall'invio. Vale per ogni parte, sotto o sopra il limite. Durante la finestra si può contestare; dopo, una parte sotto limite è `due` e viene pagata entro ~1 s: **non si può più contestare**.
- **Scadenza di pagamento**: 30 s da `LINE_SEEN` (10 s dopo la fine della finestra). Una parte sopra limite non approvata entro allora diventa insolvente.
- **Contestazione**: blocca la parte; decide Dave (conferma / annulla riga / annulla spesa). Una parte confermata **non** si paga da sola salvo `payUpheldDisputes`: va approvata entro 30 s dalla decisione.
- **Garanzia**: Dave paga lo stesso invoice con la liquidità dell'operatore, fino a G = 50.00 per membro; nasce un credito dell'operatore.
- **Esclusione**: chiusura cooperativa dei due canali, i DUSD tornano al membro on-chain; non può più essere incluso in spese.
- **Margine** (solo Dave): quanto può ancora ricevere un membro meno quanto gli è dovuto (`liquidityMarginCents`, SPEC §10.5). Se scende, l'agente di Dave apre liquidità.

## 5. SPEC vs rotte
**Nella SPEC, non nelle rotte:**
1. Anteprima delle parti per un'assegnazione **manuale** (SPEC §11, regola 4: "modulo manuale precompilato"). `MemberAgent.previewSplit` esiste, ma l'unica rotta che lo usa è `/expenses/split`, che passa dall'AI. → richiesta a Marco (BLOCCANTE per la storia 1 con i fake e per il modulo manuale).
2. Pagare a mano una riga `overdue` (`decideAutoPay` dice "Pay it yourself"): rimandato a P1 dal PM.
3. "Uguale su N/N telefoni": `ledger.checkpoints` è sempre `null` (P1, primo taglio di PLAN §1 dopo il backup).
4. `TRIP_CLOSED`, uscita volontaria del viaggiatore, ricarica: nessuna rotta (fuori demo).
5. Elenco degli eventi del registro (seq, hash, autore, firma): `/state` dà solo il riepilogo `LedgerHealth`. Basta per SPEC §9.5; un elenco per evento sarebbe un extra (richiesta non bloccante).

**Nelle rotte, non nella SPEC (o più ricco):** `operations` (attese con testo e errore), `LineView.agent` con la frase per ogni stato, `credits` simmetrico a `debts`, `coverable`, `serverNow` per i conti alla rovescia, `fakes`.

## 6. Risposte
**a) Limite per membro.** Sì: `Policy.autoPayLimitCents` (`packages/shared/src/domain.ts`, default 2000 = 20.00), pubblicato in `MEMBER_JOINED` e `POLICY_UPDATED`. Si legge in `/state` → `me.policy`; si imposta con `PUT /api/:as/policy` mandando la **policy intera** (`autoPayLimitCents`, `dailyCapCents`, `payUpheldDisputes`). Si cambia quando si vuole (`validateEvent` non pone vincoli su `POLICY_UPDATED`); vale la policy in vigore **alla fine della finestra**, e `decideAutoPay` la ricontrolla al momento del pagamento. Nota: la policy sta nel registro firmato, quindi non è privata verso gli altri agenti, anche se `MemberView` non la espone.

**b) Sopra il limite.** Alla fine della finestra la riga passa ad `awaiting_explicit`, `LineView.agent.reason` = "Not paid: X is above your automatic limit of Y. Approve it yourself.". La rotta per approvare a mano **esiste**: `POST /api/:as/expenses/:id/decision {decision:'approve'}` → `due` + `approvedExplicitly` → l'agente paga al tick successivo. Si può approvare anche durante la finestra. Attenzione: va fatto **entro seenAt + 30 s**, poi la riga è `overdue` e l'approvazione viene rifiutata.

**c) Notizia di una nuova spesa.** Niente SSE verso la UI: la UI parla solo con l'agente (`vite.config.ts`, proxy `/api`) e fa polling di `/state` ogni secondo. Il relay ha `GET /events/stream` (SSE) ma lo usa l'agente. La "notifica" è quindi una novità in `me.debts` (riga nuova in `submitted`/`awaiting_decision`) più la riga `EXPENSE_SUBMITTED` in `activity`; la UI la rileva confrontando con il polling precedente.

**d) Silenzio-assenso.** Sì, ogni pagamento automatico avviene solo dopo la finestra (`deriveTrip.advance`). Durante la finestra si può contestare (`awaiting_decision` è "undecided"). Durata: `TripParams.silentAssentSeconds` (`DEMO_TRIP_PARAMS` in `domain.ts`, 20), fissata in `TRIP_CREATED`, letta da `/state` → `trip.params.silentAssentSeconds`; non c'è rotta per cambiarla. Il conto alla rovescia è `LineView.deadlineAt` rispetto a `serverNow`.

**e) Saldo del canale.** Sì, dalla B8: `/state` chiama `MemberAgent.balances()` a ogni richiesta → `me.balance.tripOutboundCents` (spendibile), `inboundCents` (ricevibile), `onchainCents`, `tripChannelCents` (D), `topupWarning`. È `null` solo se il nodo non risponde (o prima di `TRIP_CREATED`). Con i fake viene da `FakeWallet.balances()`. Dave non ha un saldo in `/state`.
