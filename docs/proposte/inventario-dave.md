# Inventario di Dave: cosa fa nel registro vecchio durante la demo, e cosa lo sostituisce nel v2

> **23/10/2026.** Richiesto con le decisioni del 23/10: Dave resta solo LSP (deciso il 21/10). Fonti: `apps/agent/src/flows/dave.ts` (l'agente di Dave), `runtime.ts` (`seedTrip`), `apps/agent/src/e2e/demo.e2e.ts` (la demo v1 passo per passo), `infra/treasury` (il seed).
> **Esito:** ogni azione ha un sostituto. Nessuna resta scoperta.

## Azioni nel registro vecchio

| # | Quando | Azione di Dave (v1) | Evento | Cosa la sostituisce nel v2 | Dove |
|---|---|---|---|---|---|
| 1 | avvio | Crea il viaggio | `TRIP_CREATED` | Lo crea un membro (Alice); i parametri non cambiano più | `seedRegistryV2`, `RegistryV2.createTrip` |
| 2 | avvio | Pubblica il cambio del giorno | `RATE_SET` | **Il cambio firmato al tavolo nella quota:** chi paga mette nella proposta il cambio salvato sul telefono, con data e fonte (`proposal.rate`); il ledger ricalcola le quote con quello | `RegistryAgent.planExpense`; oracolo con il passo 5 |
| 3 | avvio | Ammette ogni membro, dopo aver controllato la fattura di legame | `MEMBER_ADMITTED` ×3 | **L'invito di un membro:** `MEMBER_INVITED` di Alice, poi `MEMBER_JOINED` con l'invito; la fattura `kitty-bind:v2` la verifica ogni telefono | `RegistryV2.invite`, `join`; `checkJoin` |
| 4 | avvio | Attesta che i canali del membro sono aperti | `CHANNELS_READY` ×3 | Niente nel registro: ognuno vede i propri canali dal proprio nodo (documento del team, "Spariscono") | `balances()` del wallet |
| 5 | passo 5 | Conferma la riga contestata di Charlie | `DISPUTE_RESOLVED` (`upheld`) | **C3 o la maggioranza:** Charlie ritira la contestazione approvando dopo averla vista (la storia della demo v2); oppure votano gli altri membri (`LINE_VOTED`) | `RegistryAgent.decide`, `vote`; `groupMajority` |
| 6 | passo 6 | Paga la riga di Charlie con la liquidità dell'operatore | `GUARANTEE_PAID` | **La maggioranza dei blocchi:** chi non paga può essere escluso da più della metà degli altri; non c'è garanzia (21/10): il debito resta e si paga a mano | `isExcluded`, `manual_only` |
| 7 | passo 6 | Esclude Charlie | `MEMBER_EXCLUDED` | **La maggioranza dei blocchi**, calcolata da ogni telefono | `isExcluded`, `blockersMajority` |
| 8 | passo 6 | Chiude i due canali di Charlie | (`closingTxids` in `MEMBER_EXCLUDED`) | **L'uscita di ciascun membro:** `MEMBER_LEFT`, poi il suo wallet chiude i propri canali con l'LSP | `RegistryAgent.leave` |
| 9 | passo 6 | Copre anche le altre righe aperte dell'escluso, fino a G | `GUARANTEE_PAID` | Come 6: niente garanzia, i debiti restano e si pagano a mano | |
| 10 | sempre | Ogni 10 eventi pubblica un `CHECKPOINT` | `CHECKPOINT` | I `CHECKPOINT` dei membri attivi (passo 4). Fino ad allora la demo confronta lo stato del registro dei tre telefoni (`stateHash`, "uguale su 3/3") | passo 4 |

## Azioni fuori dal registro (restano a Dave come LSP)

| # | Azione | Nel v2 |
|---|---|---|
| 11 | Instrada ogni pagamento (canale di viaggio del debitore → Dave → canale di liquidità del creditore) | Resta: è il lavoro dell'LSP |
| 12 | Apre liquidità quando il margine di un membro scende (`liquidityPlan` sul viaggio, B9; nella demo non scatta) | **Guardando solo i suoi canali** (`lspLiquidityPlan` su `peerChannels`): sotto 10.00 ricevibili, riapre fino a L = 30.00. Non legge il registro, quindi riapre dopo un pagamento e non prima |
| 13 | Nel seed: emette i DUSD con la tesoreria WDK, li vende ai viaggiatori (on-ramp simulato) e apre i canali di liquidità | Resta com'è nel seed (`demo:reset`) |
| 14 | Le sue schermate: contestazioni, insolvenze, "Copri ed escludi", cambio del giorno | La finestra di Dave mostra solo l'LSP e le sue operazioni; le rotte da coordinatore rispondono `NOT_ALLOWED` |
| 15 | Il suo agente fornisce la prova di pagamento (`GET /api/proof`) | La prova si ricalcola dal registro v2 del creditore |

Nessun backup automatico del nodo di Dave, né prima né ora (B6).
