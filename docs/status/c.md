# Stato stream C: relay e interfaccia

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream C scrive qui.

## Task
- [x] K0 Sessione contratto (revisione): `api.ts` e `views.ts` approvati dal PM; registro in `a.md`
- [x] C1 Relay (branch `c/C1-relay`)
- [x] C1b `decodeInvoice` reale nel relay (branch `c/C1b-decode-invoice`; decisione del PM: lo fa C)
- [x] C2 RelayClient (branch `c/C2-relay-client`)
- [x] C3 Rotte dell'agente (branch `c/C3-agent-routes`)
- [ ] C4 UI viaggiatore (piano ridotto, 4 PR)
  - [x] C4a shell, polling, navigazione, QR, Profile (branch `c/C4a-shell`)
  - [ ] C4b Home con Approve/Dispute
  - [ ] C4c New expense
  - [ ] C4d Groups e Group settings
- [ ] C5 UI Dave
- [ ] C6 Prova e Registro verificato
- [ ] C7 Attese ed errori

## Bloccato da
- niente

## TODO
- niente. Il TODO di C1b è chiuso: Marco ha confermato con l'invoice DUSD reale di dave (id con `_`), vedi registro.

## Prossimo passo
- C4b Home con le card Approve/Dispute.

## Richieste ad A (Paolo)
1. **`index.ts`:** dopo il merge di C3, `buildAgentServer(config, { runtime: () => runtime })`, con un getter come preferito da Paolo: il server si crea per primo, poi il runtime con `app.log`, poi `listen`. Il parametro è opzionale: senza, le rotte degli agenti rispondono 503 e `/state` dà un viaggio vuoto. Il vecchio secondo argomento `now` ora è `{ now }`.
2. ~~**`MemberAgent.balances()`**~~ fatto in B8 (sab 17/10): `/state` riempie `me.balance` dal nodo del viaggiatore; `null` solo se il nodo non risponde.
3. **`now?` in `startAgents`** (già nella #19): per ora il test di collegamento usa l'orologio vero, e i flussi temporizzati usano `demo()`.
4. ~~**Codice `AGENT_NOT_READY` in `ErrorCodeSchema`**~~ fatto (sab 17/10, PR #27 `[A-contract]`); le rotte rispondono 503 `AGENT_NOT_READY` quando gli agenti non sono partiti (`notRunning` in `routes/index.ts`). Paolo propone 503 `AGENT_NOT_READY` quando il runtime non c'è, ma il codice non esiste: per ora C3 usa `NODE_UNREACHABLE` con il messaggio "… not running yet" e l'azione "Start the agents (pnpm dev, or pnpm dev:fakes) and retry.". Quando esiste, è una riga in `routes/index.ts` (`notRunning`).
- `apps/agent/src/agent.ts` cancellato in C3, con l'ok di Paolo: non lo importava più nessuno.

## Richieste a Marco (C4, sab 17/10; dettagli in `docs/FLOWS.md`)
1. ~~**R1** anteprima delle parti per un'assegnazione manuale~~ **chiusa senza backend** (PM, sab 17/10, P1): la UI usa `expenseShares` di `@kitty/ledger`, pura e senza moduli di Node, con le pubkey dei membri come id (FLOWS.md C2). Serve solo aggiungere `@kitty/ledger` come dipendenza workspace di `apps/web`.
2. **R2, non bloccante:** elenco degli eventi del registro per la schermata Registro (`seq`, `type`, autore come `memberId`, `hash`, `prevHash`, firma valida), es. `GET /api/:as/ledger`. File: `packages/shared/src/{api,views}.ts`, `apps/agent/src/routes/`. SPEC §9.5 è già coperta dal riepilogo `ledger` di `/state`.
3. ~~MAX del "Pagamento automatico"~~ deciso dal PM: slider da 0 alla capacità del canale di viaggio (D). Nessuna modifica a `decideAutoPay`. Resta aperto solo il tetto giornaliero (FLOWS.md §E2).
4. **R4, approvata dal PM (sab 17/10), la implementa Marco con l'override nel seed, opzione (b):** finestra di contestazione **45 s** e scadenza di approvazione **120 s** da `LINE_SEEN`. Il PM pensava bastasse il seed, ma **i tempi non sono configurabili**: `seedTrip` (`apps/agent/src/flows/runtime.ts:95`) scrive in `TRIP_CREATED` la costante `DEMO_TRIP_PARAMS` (`packages/shared/src/domain.ts:145`, 20/30). Opzioni: (a) cambiare i due valori in `DEMO_TRIP_PARAMS`, da verificare contro i test di ledger, agent e relay che la importano e contro le attese di `e2e:demo`; (b) un override nel seed (es. `params` facoltativo in `seedTrip`, oppure variabili d'ambiente lette da `index.ts`), che lascia i test su 20/30. Raccomando (b). Dopo serve `demo:reset`: i parametri restano fissi per tutto il viaggio. Effetto collaterale: dopo una contestazione confermata la scadenza è risoluzione + 120 s (`packages/ledger/src/kitty.ts:315`), quindi la storia 2 si allunga (FLOWS.md §E12).
- R3 (contestare una parte sopra limite dopo la finestra) **non serve**: è già permesso finché la parte non scade (`packages/ledger/src/validate.ts:285-291`, `kitty.ts:266-283`).

## Decisioni del PM
- Rotta "paga a mano una riga scaduta" (segnalata da A in A5a: `decideAutoPay` suggerisce "Pay it yourself", ma manca la rotta in `api.ts`): **fuori da C3, rimandata a P1** (sab 17/10). In demo non serve: Charlie non paga e va in insolvenza.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### C4a, sab 17/10 19:10
- Funziona: app a larghezza telefono (max 420 px, centrata), `?as=alice|bob|charlie`, polling di `/state` ogni secondo (`apps/web/src/state.ts`, con lo scarto tra orologio del server e del browser per i conti alla rovescia). Barra in basso flottante Groups · 📷 · QR; swipe da Home (sinistra → New expense, destra → QR) e ritorno; schermata nell'hash dell'URL (`#/qr`). Home con barra in alto (saldo del canale di viaggio, occhio per nasconderlo, modalità di pagamento, logo → Profile). QR della pubkey del membro ("Your kit+ty ID", libreria `uqr` 0.1.3). Profile con nome e modalità. New expense, Groups e Group settings sono gusci navigabili. Costante `SHOW_DEMO_SECOND_GROUP` in `apps/web/src/config.ts` (usata da C4b e C4d).
- Come si prova: `pnpm dev:fakes`, poi `http://127.0.0.1:5173/?as=bob`. Test: `nav.test.ts` (hash, swipe), `mode.test.ts` (etichetta dello slider).
- Problemi noti: layout non verificato con screenshot automatici (Chrome assente sulla macchina); dave vede solo un avviso (C5). Dopo `pnpm dev:fakes` il database del relay contiene il viaggio finto: prima di `pnpm dev` reale serve `pnpm demo:reset`.
### C3, sab 17/10 15:00 (completa C3a, sotto)
- `buildAgentServer(config, { runtime?, ai?, now?, onchainFound? })`: `runtime` è un getter dell'`AgentRuntime` di `startAgents`. Il server non crea agenti, wallet o reti finte; senza runtime le rotte degli agenti rispondono 503 con un'azione (vedi richiesta 4).
- Rotte di Dave su `CoordinatorAgent` (A5b): `POST /dave/disputes/:expenseId/:member`, `POST /dave/defaults/:expenseId/:member/cover-and-exclude`, `PUT /dave/rates`. Rifiuti dei flussi con il loro codice (es. riga non contestata → 403 `NOT_ALLOWED` con il motivo).
- `me.balance` è `null` finché non c'è `MemberAgent.balances()` (richiesta 2).
- Come si prova: `pnpm test`, `apps/agent/src/routes/routes.test.ts` (11 test). In più rispetto a C3a: contestazione → Dave conferma dalla rotta → charlie non paga → insolvenza → "Copri ed escludi" dalla rotta (garanzia 3.50, canali chiusi, charlie escluso, prova `paidBy: guarantee` verificata); tasso del giorno; **collegamento con il runtime vero**: `startAgents` in modalità fake più `seedFakeTrip` su un relay in memoria, e `/state` di bob mostra il viaggio seminato con 3 membri attivi.
### C3a, sab 17/10 14:00
- Funziona: `registerRoutes` (`apps/agent/src/routes/index.ts`) per le 11 rotte di SPEC §14.3, sopra `MemberAgent` (A5a).
  - Ogni rotta: parametri e body validati con `routes` di `api.ts` (400 `VALIDATION_ERROR`, oppure 404 `NOT_FOUND` per un membro sconosciuto), ruolo dal percorso (`dave` su una rotta da viaggiatore → 403 `NOT_ALLOWED`, con un'azione), risposta con `z.encode` dello schema della rotta.
  - Errori: `FlowError`/`WalletError`/`RelayError` → il loro `toApiError()`; `LedgerError` con il suo codice; zod → 400; `NotImplementedError` → 501; altro → 500 `INTERNAL`. Stato HTTP per codice (`AI_NOT_READY`/`*_UNREACHABLE` → 503, `TOPUP_REQUIRED` → 409…). Nel log finiscono solo i 500.
  - `/state` (`routes/state.ts`, `buildTripView`): tutto il `TripView` dalla copia verificata dell'agente. Membri e stati; spese con righe e chi condivide ogni articolo; righe con conto alla rovescia, frase dell'agente (`decisionFor`), prova, scadenza dell'invoice dal nodo; `me` con saldo dal proprio nodo (`null` se il nodo non risponde, non un errore), devo e mi devono, pagato in automatico nelle 24 h. Vista di Dave: margini di `liquidityPlan`, garanzia usata e residua, contestazioni con gli articoli del debitore, insolvenze con `coverable`. Attività: decisioni dell'agente più una riga per evento del registro. Senza agente → viaggio vuoto, così la UI può dire cosa manca.
  - `/proof/:paymentHash` (`routes/proof.ts`): sha256(preimage) = hash, payee dell'invoice = nodo del creditore, importo e asset = riga; per l'on-chain txid e link esplora.
  - `extract` e `split` con l'`AiService` (`AI_NOT_READY` se non è pronto); l'anteprima delle quote la calcola il ledger (`previewSplit`), mai l'AI.
  - `server.ts`: `buildAgentServer(config, { agents?, wallets?, ai?, now?, onchainFound? })` riceve gli agenti dal runtime invece di costruirne di suoi; `index.ts` (di A) non cambia finché non passa il runtime.
- Come si prova: `pnpm test`, `apps/agent/src/routes/routes.test.ts` con il `demo()` di A (4 `MemberAgent`, relay in memoria con il vero `validateEvent`). Coperto: viste di ogni finestra; demo **dalle rotte**: split con quote 3.09/3.09/3.50, invio, charlie contesta, Dave vede la contestazione con gli articoli, bob paga da solo a 20 s, alice vede i crediti, prova verificata con i tre controlli verdi; policy, annullamento, estrazione; ruoli, validazione, 501 per Dave, agente o AI assenti, nodo che non risponde.
- Problemi noti: `/state` mostra la copia dell'agente all'ultimo `tick()` (entro 1 s nel server). `liquidityMarginCents` non conta la liquidità aperta dopo il primo canale (`extraLiquidity` di A7, la conosce solo il nodo di Dave, B9).
### C1b, verifica sul nodo reale, sab 17/10 13:30
- Invoice di dave su DUSD dello stack B1/B2 (`rgb:16sDAWsj-ep2RC7o-g5r2e81-LslCiVR-bK_ZRhg-ohfPz7w`, contiene `_`), con 3,000,000 msat, 309, 3600 s. `decodeBolt11` dà esattamente i campi del `/decodelninvoice` del nodo, e l'id fa andata e ritorno. Con `_` = 62 confermato, anche `~` = 63 è fissato (l'alfabeto ha solo quei due caratteri oltre a `A-Za-z0-9`). Nessun asset di test emesso. Diventato vettore dorato in `apps/relay/src/bolt11.test.ts`.
- `apps/relay/src/tools/check-bolt11.ts` resta per ripetere il controllo su un nodo vivo.
### C2, sab 17/10 12:45
- Funziona: `createRelayClient({ baseUrl, fetch?, timeoutMs?, backoff?, idleTimeoutMs? })` (`apps/agent/src/relay/http-client.ts`), che implementa `RelayClient`.
  - `append`, `list(since)`, `putBackup`, `getBackup` (404 → `null`). Timeout di 10 s per richiesta. Se il relay non risponde → `RelayError` `RELAY_UNREACHABLE`; se rifiuta → il suo `ApiError` (es. `INVALID_EVENT` con il motivo del ledger) con `httpStatus`.
  - `subscribe` (`sse.ts`): SSE letto con `fetch`, perché Node 22 non ha `EventSource` senza flag. Ogni evento arriva una volta sola, in ordine di `seq`. Riconnessione con backoff da 250 ms a 5 s, ripartendo da `?since=<ultimo seq>`. Un buco nella sequenza viene riempito con `list(ultimo)`. Un evento malformato non viene mai saltato: è un guasto del relay, lo stream si riconnette e lo segnala. Se per 45 s non arriva nulla (il relay manda un heartbeat ogni 15 s), il client si riconnette. Un errore nell'handler viene registrato in console e la consegna continua.
  - Il client controlla solo la forma (zod); firme, catena e regole le verifica l'agente con `validateEvent` (SPEC §9.3).
- **Modifica al contratto (approvata dal PM):** `subscribe(onEvent, opts?: { sinceSeq?, onStatus? })` in `apps/agent/src/relay/types.ts`. Il secondo argomento è opzionale, quindi resta compatibile con SPEC §14.2; nuovi tipi `RelayStatus` e `SubscribeOptions`.
- Correzione al relay di C1 (commit separato): `forceCloseConnections: true`. Dopo l'interruzione di uno stream SSE, undici apre una connessione keep-alive senza richieste, che la politica `idle` non chiude: `close()` aspettava circa 4 s.
- Come si prova: `pnpm test`.
  - `apps/agent/src/relay/http-client.test.ts`, contro il **relay vero** in memoria (importato con percorso relativo, solo nei test): append/list, rifiuto con codice e motivo, `RELAY_UNREACHABLE`, backup e limite di dimensione, arretrati + diretta con `sinceSeq`, riavvio del relay con eventi aggiunti nel frattempo (né buchi né duplicati), relay spento all'avvio, `unsubscribe`.
  - `sse.test.ts`, con un `fetch` finto: parser, buco riempito, duplicati, evento malformato, stream muto, backoff, handler che lancia.
- Problemi noti: nessuno. Il collegamento in `index.ts` spetta ad A (vedi Prossimo passo).
### C1b, sab 17/10 12:15
- Funziona: `decodeBolt11` (`apps/relay/src/bolt11.ts`) è il `decodeInvoice` dei `defaultDeps` del relay. Senza fake il relay ora valida tutto: `validateEvent` di A2, ed25519 di B4, invoice decodificati in JS. Nessuna libreria BOLT11: bech32 scritto a mano, firma con `@noble/curves` secp256k1 (stesse versioni già nel lockfile tramite B4, aggiunte a `apps/relay/package.json` in un commit separato).
- Formato RGB, verificato sull'unico invoice reale che abbiamo (`spikes/wdk/calls.log:78`) contro il `/decodelninvoice` del nodo (riga 79): tag 30 = `asset_amount`, tag 31 = `asset_id` (32 byte). L'id si mostra come `rgb:` + baid64 senza padding, a gruppi 8-7-7-7-7-7. Alfabeto del crate `baid64`: `…0123456789_~` (`_` = 62, `~` = 63). RLN `d4762ac` usa `baid64` **0.4.1** (Cargo.lock), il PM aveva indicato 0.4.2: confrontati i sorgenti dei due crate, alfabeto, gruppi e decodifica sono identici (cambia solo un `debug_assert`).
- Sicurezza: la firma dell'invoice è sempre verificata contro il `payee` (tag `n`; se manca, pubkey recuperata dalla firma), altrimenti il controllo del creditore di SPEC §13 #1 non varrebbe nulla. Solo `lnbcrt` (regola 9). Campi ripetuti rifiutati (il nodo e noi non devono poter leggere valori diversi dallo stesso invoice); `p`/`s`/`n` di lunghezza sbagliata ignorati come vuole BOLT11.
- Nessuna modifica a `validateEvent`: asset e importo si leggono dall'invoice.
- Come si prova: `pnpm test`. `apps/relay/src/bolt11.test.ts`: vettore dorato reale, andata e ritorno di id con `_` e `~`, firma di un altro nodo, hrp non regtest, unità di importo. `apps/relay/src/validate-real.test.ts`: relay con `defaultDeps` e chiavi vere; invoice di legame dal proprio nodo accettato, da un altro nodo o falsificato rifiutato; spesa accettata; asset, importo, payee, descrizione, mainnet o invoice scaduto rifiutati.
- Problemi noti: l'alfabeto non è ancora provato su un id reale con `_` o `~` (vedi TODO). `amtMsat` ≥ `rgb_htlc_min_msat` non è controllato dal ledger (non necessario).
### C1, sab 17/10 10:50
- Funziona: relay Fastify (`apps/relay`) su `node:sqlite` (nessuna dipendenza nuova). Un database = un viaggio = una catena.
  - `POST /events` (validato dal `validateEvent` reale di A2, mergiato su `main`; test di integrazione in `log.test.ts` e `server.test.ts`): parse zod di `SignedEvent` → `StoredEvent` candidato (`seq`, `prevHash`, `receivedAt`, `hash = storedEventHash`) → `validateEvent(candidato, deriveTrip(precedenti, receivedAt), deps)` → INSERT. Risposte: 201 `StoredEvent`; 400 `VALIDATION_ERROR`; 409 `INVALID_EVENT` (rifiuto del ledger, nonce già usato, `tripId` diverso); 501 `NOT_IMPLEMENTED` solo se un validatore lancia `NOT_IMPLEMENTED` (oggi non succede: A2 non lancia mai). Sempre `ApiErrorBody`. L'append è sincrono (nessun `await` tra lettura della testa e INSERT), quindi niente `seq` doppi.
  - `GET /events?since=N`; `GET /events/stream?since=N` (SSE, `id:` = seq, prima gli arretrati e poi la diretta, `Last-Event-ID`, heartbeat ogni 15 s).
  - `PUT /backups/:pubkey` (blob opaco, `application/octet-stream`, massimo 2 MB, 413 oltre) e `GET /backups/:pubkey` (ultima versione, header `x-backup-version`, 404 se manca).
  - Append-only anche nello schema: trigger SQLite che bloccano UPDATE e DELETE su `events` e `backups`; `nonce` e `hash` UNIQUE. I backup sono versionati, mai sovrascritti.
  - `decodeInvoice` iniettato in `ValidationDeps`; il default (`defaultDeps` in `server.ts`) lancia `NotImplementedError` finché B non scrive il decoder.
  - Modalità fake (`KITTY_FAKES=1`, per I1): `fakeModeValidate` (`apps/relay/src/fake-validate.ts`) al posto di `validateEvent`. Controlla forma, catena di hash, `TRIP_CREATED` per primo e una volta sola, `tripId`, nonce duplicato; **salta firme e invoice**. All'avvio il log dice `relay in FAKE mode: signatures and invoices are not verified`.
- Come si prova: `pnpm test` (`apps/relay/src/log.test.ts`, `server.test.ts`: 20 test con un `validateEvent` finto iniettato che controlla firma, catena e nonce); a mano: `pnpm --filter @kitty/relay dev` (porta 4000, DB in `apps/relay/data/relay.sqlite`, gitignored; `RELAY_DB`, `RELAY_PORT`, `RELAY_HOST`).
- Problemi noti: `deriveTrip` viene ricalcolato su tutto il log a ogni append (O(n), basta per la demo). `node:sqlite` stampa un `ExperimentalWarning` all'avvio. I backup crescono senza potatura (≈440 KB a versione).
