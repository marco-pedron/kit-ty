# Stato stream C: relay e interfaccia

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream C scrive qui.

## Task
- [x] K0 Sessione contratto (revisione): `api.ts` e `views.ts` approvati dal PM; registro in `a.md`
- [x] C1 Relay (branch `c/C1-relay`)
- [x] C1b `decodeInvoice` reale nel relay (branch `c/C1b-decode-invoice`; decisione del PM: lo fa C)
- [x] C2 RelayClient (branch `c/C2-relay-client`)
- [x] C3 Rotte dell'agente (branch `c/C3-agent-routes`)
- [ ] C4 UI viaggiatore
- [ ] C5 UI Dave
- [ ] C6 Prova e Registro verificato
- [ ] C7 Attese ed errori

## Bloccato da
- niente

## Prossimo passo
- C4 UI viaggiatore.

## Richieste ad A (Paolo)
1. **`index.ts`:** dopo il merge di C3, `buildAgentServer(config, { runtime: () => runtime })`, con un getter come preferito da Paolo: il server si crea per primo, poi il runtime con `app.log`, poi `listen`. Il parametro è opzionale: senza, le rotte degli agenti rispondono 503 e `/state` dà un viaggio vuoto. Il vecchio secondo argomento `now` ora è `{ now }`.
2. **`MemberAgent.balances()`** (PR #19 di Paolo): appena è su `main`, `/state` lo usa per `me.balance`. Fino ad allora `balance` è `null` e la UI mostra "balance not available".
3. **`now?` in `startAgents`** (già nella #19): per ora il test di collegamento usa l'orologio vero, e i flussi temporizzati usano `demo()`.
4. **Codice `AGENT_NOT_READY` in `ErrorCodeSchema`** (`packages/shared/src/errors.ts`), con un'azione. Paolo propone 503 `AGENT_NOT_READY` quando il runtime non c'è, ma il codice non esiste: per ora C3 usa `NODE_UNREACHABLE` con il messaggio "… not running yet" e l'azione "Start the agents (pnpm dev, or pnpm dev:fakes) and retry.". Quando esiste, è una riga in `routes/index.ts` (`notRunning`).
- `apps/agent/src/agent.ts` cancellato in C3, con l'ok di Paolo: non lo importava più nessuno.

## Decisioni del PM
- Rotta "paga a mano una riga scaduta" (segnalata da A in A5a: `decideAutoPay` suggerisce "Pay it yourself", ma manca la rotta in `api.ts`): **fuori da C3, rimandata a P1** (sab 17/10). In demo non serve: Charlie non paga e va in insolvenza.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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
