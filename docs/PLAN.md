# kit+ty: piano di lavoro

> Chi fa cosa, in che ordine, con quali priorità. Il **cosa** è in `docs/SPEC.md`; qui c'è il **come ci organizziamo**. Lo modifica solo il PM; gli stream aggiornano solo il proprio file in `docs/status/`.

## 1. Priorità

- **P0**: serve al percorso della demo (SPEC §16, passi 1-7). Senza, non si presenta.
- **P1**: rafforza le risposte alle critiche (backup, checkpoint, test anti-injection). Si fa dopo `demo-v1`.
- **P2**: extra (correzione di `/signmessage` in un fork di RLN, LSP e canali virtuali). Solo con tempo avanzato, con ritorno all'ultimo tag se la finestra scade.

**Ordine dei tagli se siamo in ritardo** (dal primo da tagliare): ripristino del backup in demo (resta la slide) → confronto checkpoint tra telefoni (resta la verifica della catena) → contestazione in UI (Charlie semplicemente non paga e va in insolvenza) → Lightning (modalità `onchain`, SPEC §10.4).

## 2. Squadra e proprietà

Tre stream. Ognuno scrive **solo** nelle proprie cartelle; il resto è in sola lettura. Questo è ciò che permette a tre Claude Code di lavorare in parallelo senza conflitti.

| Stream | Chi | Possiede | Profilo |
|---|---|---|---|
| **A: dominio, AI, cervello dell'agente** | Dev A | `packages/shared` (tranne `crypto.ts`), `packages/ledger`, `apps/agent/src/{ai,flows}`, `apps/agent/src/index.ts`, `infra/fixtures` | il più forte su logica TypeScript e test |
| **B: nodi e soldi** | Dev B | `infra/` (tranne `fixtures`), `packages/rln-client`, `packages/shared/src/crypto.ts`, `apps/agent/src/{wallet,rail}`, script `demo:*` ed `e2e:*`, `spikes/` | il più a suo agio con Docker, Bitcoin, Lightning |
| **C: relay e interfaccia** | Dev C, consigliato al PM | `apps/relay`, `apps/web`, `apps/agent/src/{relay,routes}` | frontend e API; lo stream con meno incognite, lascia tempo per coordinare |

Il **PM** (chi crea il repo) fa anche lo stream C, tiene `PLAN.md` e il registro decisioni in `SPEC.md`, conduce i checkpoint e il gate.

**Contratto condiviso:** `packages/shared` è di A. Se B o C hanno bisogno di un cambiamento, lo chiedono ad A, che apre una PR piccola entro 30 minuti e avvisa in chat. Tutti fanno `git pull` subito dopo il merge.

## 3. Calendario

| Quando | Cosa | Chi |
|---|---|---|
| **Ven 16, 10:00-10:45** | Setup del repo (`docs/SETUP.md`) | PM |
| 10:00-10:45 | Preparazione macchine: Docker con almeno 8 GB di RAM se possibile, vecchio stack avviato, Claude Code aggiornato | A, B |
| **10:45-13:30** | **B0 Spike Lightning** (nel vecchio repo, prompt `00`) | B |
| **10:45-13:15** | **K0 Sessione contratto** (prompt `01`), A alla tastiera, C rivede; PR mergiata entro le 13:15 | A, C |
| **13:30** | **Gate** (15 min): risultati dello spike → modalità rail → registro decisioni | tutti |
| 14:00-20:30 | Ondata 1 (task ★1 della tabella §4) | tutti |
| **20:30** | **Checkpoint I1**: con i fake, una spesa inviata da Alice arriva a Bob, scade il silenzio-assenso, il pagamento (fake) compare su tutte le finestre; tutto passa dal relay | tutti |
| **Sab 17, 08:30** | Kickoff all'hackathon; dalle 09:30 ondata 2 (★2): via i fake | tutti |
| **13:00** | **Checkpoint I2**: pagamento Lightning **reale** di Bob dalla UI, AI **reale** sullo scontrino VND | tutti |
| 13:00-19:00 | Ondata 3 (★3): contestazione, copertura, esclusione, prove, errori | tutti |
| **19:00** | **Checkpoint I3**: demo completa da `demo:reset`, passi 1-7 | tutti |
| **22:00** | **Tag `demo-v1`** + video della demo (backup se il palco va male) | PM |
| Sab notte | P1 | chi è libero |
| **Dom 18, 08:00-11:00** | P1 residui, README, `PITCH.md`, due prove complete | tutti |
| **11:00** | **Feature freeze**: solo fix | |
| **12:30** | Submit (scadenza 13:00); cancellare `_legacy/` prima | PM |
| 16:00 | Pitch | |

La **macchina della demo** è quella con più RAM. Da sabato sera tutte le prove si fanno lì.

## 4. Task

★1 = ondata 1 (ven pomeriggio), ★2 = ondata 2 (sab mattina), ★3 = ondata 3 (sab pomeriggio). "Fatto" = criterio di accettazione verificato + `pnpm typecheck && pnpm lint && pnpm test` verdi + file di stato aggiornato + PR mergiata.

### Fase 0 (venerdì mattina)
| ID | Pri | Chi | Task | Fatto quando |
|---|---|---|---|---|
| S0 | P0 | PM | Setup del repo | `docs/SETUP.md` completato, tutti hanno clonato |
| B0 | P0 | B | Spike Lightning RGB | `docs/spike-lightning.md` risponde alle 10 domande di SPEC §19 con richieste funzionanti |
| K0 | P0 | A+C | Sessione contratto | monorepo, schemi, interfacce, fake, CI verde, mergiato su `main` |
| B0b | P0 | B | Spike 2: motore WDK (`prompts/02`), massimo 3 ore | `docs/spike-wdk.md` con il verdetto sul motore, la firma e il backup |
| G2 | P0 | tutti | Gate 2 (15 min) | motore scelto e scritto nel registro decisioni |

### Stream A
| ID | Pri | Onda | Task | Fatto quando |
|---|---|---|---|---|
| A1 | P0 | ★1 | `deriveTrip(events, now)`: stati delle righe (SPEC §7), saldi dovuti e da ricevere, insolvenze, garanzia usata per membro, esclusi | test su ogni transizione, sui confini delle scadenze (prima, esattamente, dopo), sui numeri della cena; proprietà fast-check: Σ righe + quota pagatore = totale |
| A2 | P0 | ★1 | `validateEvent` (SPEC §9.3) con verificatore di firme iniettato | un test per ogni regola: duplicato, replay, debitore escluso, invoice intestato a un altro, importo sbagliato, preimage sbagliata, tipo "Dave" firmato da altri |
| A3 | P0 | ★1 | `decideAutoPay` (SPEC §8) con motivazione | test: sotto e sopra limite, tetto giornaliero, contestata, confermata con e senza `payUpheldDisputes` |
| A4 | P0 | ★1→★2 | AI con QVAC: `extractReceipt`, `proposeSplit`, prompt in file, zod + 2 tentativi, fixture (scontrino VND, taxi EUR, supermercato USD) e `pnpm ai:eval` | i 3 scontrini danno un `Receipt` valido (al massimo 1 correzione manuale ciascuno); la frase della demo dà l'assegnazione corretta; funziona con il Wi-Fi spento |
| A5 | P0 | ★1→★3 | Flussi dell'agente: invio spesa (quote dal ledger → invoice → firma → relay); loop (ricezione, verifica, `LINE_SEEN`, policy, pagamento, `PAYMENT_MADE`, `CHECKPOINT`); decisioni; azioni di Dave (risoluzione contestazione, copertura ed esclusione) | ★1 con `FakeWallet`; ★3 con il wallet reale, passi 2-7 della demo |
| A7 | P0 | ★2 | `liquidityPlan(trip)` (SPEC §10.5): margine per membro e aperture necessarie | test: credito netto di picco, righe aperte, coperture della garanzia, membri esclusi |
| A6 | P1 | | Test anti-injection sulla divisione; verifica hash dei GGUF all'avvio | 5 frasi ostili non producono assegnazioni fuori dai membri o dagli indici |

### Stream B
| ID | Pri | Onda | Task | Fatto quando |
|---|---|---|---|---|
| B1 | P0 | ★1 | Infra nel nuovo repo: bitcoind, electrs, proxy RGB e i 4 nodi RLN (alice, bob, charlie, dave); porte su `127.0.0.1`; script `infra:*`; `.env.example` | `pnpm infra:reset` porta su lo stack; memoria misurata e scritta nello stato |
| B2 | P0 | ★1 | Seed idempotente: un nodo RLN per membro (mnemoniche gitignored), fondi BTC, emissione DUSD e on-ramp 100.00 a viaggiatore con `wdk-wallet-rgb` su Dave, canali da 1,000,000 sat (viaggio 50.00, liquidità 30.00); `pnpm demo:reset` | due esecuzioni di fila senza errori; canali usabili; saldi attesi stampati |
| B3 | P0 | ★2 | `Wallet` reale (SPEC §14.2) con il motore scelto al gate 2, e `LightningRail` | test di integrazione: Alice crea invoice, Bob paga, prova verificata |
| B4 | P0 | ★1 | `crypto.ts`: verifica delle firme ed25519 in TypeScript puro + invoice di legame, SPEC §9.1 | firma valida accettata, alterata rifiutata, firma di un'altra chiave rifiutata, invoice di legame di un altro nodo rifiutato |
| B5 | P1 | ★3 | `OnchainRail` (dal rail del vecchio progetto) per pagare membri esclusi, o come modalità `onchain` | pagamento on-chain con prova `txid` (diventa P0 se il gate sceglie `onchain`) |
| B6 | P0 | ★3 | Backup: `backupNow` dopo ogni cambiamento di stato: lock → backup → unlock, blob cifrato sul relay. Demo del ripristino `pnpm demo:lose-phone bob` = P1 | il backup parte da solo; dopo il ripristino il saldo di Bob è identico e un nuovo pagamento funziona |
| B9 | P0 | ★3 | `Wallet.openLiquidity` e loop dell'agente di Dave che esegue `liquidityPlan` (SPEC §10.5) | con L piccola apposta, un rimborso grande fa aprire un canale di liquidità prima del pagamento |
| B7 | P0 | ★3 | `closeChannelsWith` per l'esclusione; mining automatico su regtest; link esplora | chiusura cooperativa con Charlie confermata e DUSD visibili sul suo nodo |
| B8 | P0 | ★3 | `pnpm e2e:demo`: la demo senza UI, tramite l'API dell'agente, con asserzioni sui numeri di SPEC §16 | verde da `demo:reset`; si lancia prima di ogni merge rischioso |

### Stream C
| ID | Pri | Onda | Task | Fatto quando |
|---|---|---|---|---|
| C1 | P0 | ★1 | Relay: SQLite append-only, `validateEvent` di A, catena di hash, SSE, `GET /events?since=`, blob dei backup | test: evento valido accettato e concatenato; evento alterato rifiutato; nonce duplicato rifiutato |
| C2 | P0 | ★1 | `RelayClient` (append, list, subscribe con riconnessione) | test contro un relay in memoria |
| C3 | P0 | ★1 | Rotte dell'agente (SPEC §14.3), sottili sopra i flussi di A | chiamate dalla UI con i fake |
| C4 | P0 | ★1→★2 | UI viaggiatore: Home (saldo, devo e mi devono), Ho pagato (foto → revisione → frase → invio), Da approvare (conto alla rovescia, approva/contesta), Attività con prove, Impostazioni dell'agente | flusso dei passi 2-4 con i fake, poi reale |
| C5 | P0 | ★3 | UI Dave: membri ed esclusi, contestazioni, insolvenze con "Copri ed escludi", tasso del giorno | passi 5-6 della demo |
| C6 | P0 | ★3 | Pannello Prova (tre controlli espliciti) e "Registro verificato" (catena e firme; confronto checkpoint = P1) | passi 3 e 7 |
| C7 | P0 | ★3 | Ogni attesa dice cosa succede con il tempo trascorso; ogni errore ha un'azione suggerita (`TOPUP_REQUIRED`, nodo non raggiungibile, invoice scaduto, AI non pronta, totale che non torna) | provato spegnendo `rln-dave` durante un pagamento |

### Insieme
| ID | Pri | Quando | Task |
|---|---|---|---|
| T1 | P0 | sab 19:00-22:00 | Prove complete, correzioni, tag `demo-v1`, video |
| T2 | P0 | dom mattina | README (cosa fa, come si avvia, reale e simulato, roadmap), `PITCH.md` definitivo |

## 5. Come lavoriamo con Claude Code in parallelo

1. **Un task = un branch = una sessione.** Branch `a/A1-derive-trip`, `b/B2-seed`, `c/C1-relay`. Tra un task e l'altro, `/clear`.
2. **Avvio di ogni sessione:** incolla il prompt del tuo stream (`docs/prompts/stream-*.md`) seguito da "Task A1". Claude legge `CLAUDE.md` da solo.
3. **Piano prima del codice.** Claude propone file, documenti letti e rischi; tu approvi. Poi implementa, esegue i controlli, fa commit piccoli.
4. **Merge spesso**, almeno ogni 2-3 ore: PR piccole con titolo `[A1] deriveTrip`, CI verde, cinque minuti di lettura da parte di un altro dev, merge. Prima di aprire la PR: `git pull --rebase origin main`.
5. **Lockfile:** le dipendenze si aggiungono in PR dedicate. In caso di conflitto su `pnpm-lock.yaml`, prendere la versione di `main`, rilanciare `pnpm install`, committare.
6. **Fake:** finché il pezzo reale non è mergiato si lavora con `KITTY_FAKES=1`. I fake non entrano mai nella demo (`demo:reset` li rifiuta).
7. **Blocchi:** se Claude fallisce 3 volte sullo stesso errore, si ferma e riassume. Il dev lo scrive in chat e nel file di stato; il PM decide entro 15 minuti (aiuto, taglio o cambio di approccio).

## 6. Come teniamo traccia

- **`docs/status/a.md`, `b.md`, `c.md`**: una casella per task, più "Bloccato da" e "Prossimo passo". Claude li aggiorna alla fine di ogni task; nessuno tocca il file degli altri.
- **PR su GitHub** come registro del lavoro fatto (titolo con l'ID del task).
- **Checkpoint** (I1, I2, I3): 10 minuti in piedi. Ognuno legge il suo file di stato, si prova insieme il criterio del checkpoint, il PM aggiorna la tabella qui sotto e, se serve, applica i tagli del §1.

### Stato ai checkpoint (lo compila il PM)
| Checkpoint | Esito | Note e tagli |
|---|---|---|
| Gate 1 (anticipato, ven 10:50) | ✅ spike verde | modalità rail: **`ln-2ch`** |
| Gate 2 (ven, fine spike WDK) | ✅ opzione A | motore wallet: **`rln-rest`** (RLN `d4762ac`, `ln-2ch`) + `@utexo/wdk-wallet-rgb` solo per emissione e on-ramp dei DUSD di Dave (misto, Node 22); firma: **ed25519 + invoice di legame**; backup: **lock → backup → unlock sul relay** |
| I1 ven 20:30 | | |
| I2 sab 13:00 | | |
| I3 sab 19:00 | | |
| demo-v1 sab 22:00 | | |
