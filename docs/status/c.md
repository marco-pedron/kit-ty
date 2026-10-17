# Stato stream C: relay e interfaccia

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream C scrive qui.

## Task
- [x] K0 Sessione contratto (revisione): `api.ts` e `views.ts` approvati dal PM; registro in `a.md`
- [x] C1 Relay (branch `c/C1-relay`)
- [x] C1b `decodeInvoice` reale nel relay (branch `c/C1b-decode-invoice`; decisione del PM: lo fa C)
- [x] C2 RelayClient (branch `c/C2-relay-client`)
- [ ] C3 Rotte dell'agente
- [ ] C4 UI viaggiatore
- [ ] C5 UI Dave
- [ ] C6 Prova e Registro verificato
- [ ] C7 Attese ed errori

## Bloccato da
- niente

## TODO
- niente. Il TODO di C1b è chiuso: Marco ha confermato con l'invoice DUSD reale di dave (id con `_`), vedi registro.

## Prossimo passo
- **Per A (`apps/agent/src/index.ts`, non è mio):** creare il client una volta sola, `createRelayClient({ baseUrl: config.RELAY_URL })` da `./relay/http-client.js`, e passarlo ai flussi. Uso tipico: `const log = await relay.list()`, poi `relay.subscribe(onEvent, { sinceSeq: log.at(-1)?.seq ?? 0, onStatus })`. Gli errori sono `RelayError` (`./relay/errors.js`) con `toApiError()`, come `WalletError`. `onStatus` dà `connected` / `reconnecting` (con tentativo, attesa ed errore): serve a C7.
- C3 rotte dell'agente.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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
