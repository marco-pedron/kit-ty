# Proposta: documenti dello stream A in PLAN §2

> **Proposta, NON applicata.** `docs/PLAN.md` lo modifica solo il PM. Questa modifica mette per iscritto l'autorizzazione permanente data il 22/10/2026 dal responsabile.

## Perché

PLAN §2 lascia a ogni stream, in `docs/`, solo il proprio file di stato. Il lavoro sullo Stack A produce però documenti che appartengono allo stream A: il piano di migrazione, gli ADR del formato, le proposte per PM e team. Senza la modifica, ogni PR che li tocca viola PLAN e va fermata prima del merge.

## Diff proposto (PLAN §2, tabella "Squadra e proprietà")

```diff
-| **A: dominio, AI, cervello dell'agente** | Dev A | `packages/shared` (tranne `crypto.ts`), `packages/ledger`, `apps/agent/src/{ai,flows}`, `apps/agent/src/index.ts`, `infra/fixtures` | il più forte su logica TypeScript e test |
+| **A: dominio, AI, cervello dell'agente** | Dev A | `packages/shared` (tranne `crypto.ts`), `packages/ledger`, `apps/agent/src/{ai,flows}`, `apps/agent/src/index.ts`, `infra/fixtures`; in `docs/`: `piano-migrazione-stack-a.md`, gli `ADR-*.md` dello Stack A, `proposte/`, e `stack-a-decisioni.md` solo per le modifiche chieste dal responsabile | il più forte su logica TypeScript e test |
```

E sotto la tabella, dopo "Contratto condiviso":

```diff
+**Documenti dello Stack A** (dal 22/10): lo stream A scrive i documenti elencati nella sua riga. `docs/stack-a-decisioni.md` è il documento del team: lo stream A lo modifica solo su richiesta esplicita del responsabile, segnando ogni modifica con la data. `docs/proposte/` contiene proposte per PM e team, mai applicate da chi le scrive. `SPEC.md` e `PLAN.md` restano del PM.
```
