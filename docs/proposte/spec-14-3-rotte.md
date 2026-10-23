# Proposta di modifica a SPEC §14.3 (API dell'agente): le rotte del blocco

> **Proposta, NON applicata.** Va approvata dal PM e registrata in SPEC §20.
> Allineata al codice: rotte in `packages/shared/src/api.ts` (tabella `routes`, con il test `api.test.ts` "has exactly the routes of the SPEC") e gestori in `apps/agent/src/routes/index.ts` (PR #73, mergiata il 23/10). Regole: `docs/proposte/regole-conflitto.md` (D6, C7, esclusione) e `docs/ADR-001-formato-eventi.md` §5.
> Formato: `-` riga tolta, `+` riga aggiunta; le righe di §14.3 non citate restano come sono.

## 1. Le tre rotte del blocco (richieste il 23/10)

Valgono solo con `KITTY_REGISTRY=v2`; con `v1` l'agente risponde `NOT_ALLOWED` ("blocking needs the registry v2").

```diff
 | `PUT /api/:as/policy` | viaggiatore | limiti dell'agente |
+| `GET /api/:as/members/:member/block` | viaggiatore | v2: l'avviso prima di bloccare (`{ warning }`): il blocco conta anche per l'esclusione, con quanti membri bloccano già. Non blocca |
+| `POST /api/:as/members/:member/block` | viaggiatore | v2: `MEMBER_BLOCKED` su `:member` (D6, per coppia) → `{ warning }` |
+| `POST /api/:as/members/:member/unblock` | viaggiatore | v2: `MEMBER_UNBLOCKED`: toglie tutti i blocchi di `:as` su `:member` che conosce (C7) → `{ ok: true }` |
```

Nel `TripView`, ogni `MemberView` porta con v2 anche `registry: { blockedByMe, excluded }` (`packages/shared/src/views.ts`).

## 2. Da aggiungere insieme: voto e uscita (decisioni del 23/10)

Non sono tra le tre rotte richieste, ma esistono dal 23/10 e la tabella del SPEC deve restare uguale alla tabella `routes`. Si possono approvare separatamente.

```diff
+| `POST /api/:as/expenses/:id/lines/:member/vote` | viaggiatore (né creditore né debitore della riga) | v2: `LINE_VOTED` `{ outcome: due \| voided }` sulla riga contestata di `:member` (regola provvisoria a maggioranza) → `LineView` |
+| `POST /api/:as/leave` | viaggiatore | v2: `MEMBER_LEFT` (solo senza debiti noti), poi il wallet di `:as` chiude i propri canali con l'LSP → `{ closingTxids, warning }` (`warning` se `:as` esce con crediti, che da allora si pagano solo on-chain) |
```

E, sempre con v2, le rotte di Dave come coordinatore non sono disponibili:

```diff
-| `POST /api/dave/disputes/:expenseId/:member` | Dave | `{ outcome, note }` |
-| `POST /api/dave/defaults/:expenseId/:member/cover-and-exclude` | Dave | garanzia + esclusione |
-| `PUT /api/dave/rates` | Dave | tasso del giorno |
+| `POST /api/dave/disputes/:expenseId/:member` | Dave | v1: `{ outcome, note }`. v2: `NOT_ALLOWED` (nessun coordinatore) |
+| `POST /api/dave/defaults/:expenseId/:member/cover-and-exclude` | Dave | v1: garanzia + esclusione. v2: `NOT_ALLOWED` |
+| `PUT /api/dave/rates` | Dave | v1: tasso del giorno. v2: `NOT_ALLOWED` |
```

## 3. Già nel codice e non nel SPEC (fuori da questa proposta)

`POST /api/:as/expenses/transcribe` (voce → testo, stream A) è nella tabella `routes` ma non in SPEC §14.3. Lo segnalo soltanto.
