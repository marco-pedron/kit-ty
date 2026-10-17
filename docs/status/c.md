# Stato stream C: relay e interfaccia

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream C scrive qui.

## Task
- [x] K0 Sessione contratto (revisione): `api.ts` e `views.ts` approvati dal PM; registro in `a.md`
- [x] C1 Relay (branch `c/C1-relay`)
- [x] C1b `decodeInvoice` reale nel relay (branch `c/C1b-decode-invoice`; decisione del PM: lo fa C)
- [ ] C2 RelayClient
- [ ] C3 Rotte dell'agente
- [ ] C4 UI viaggiatore
- [ ] C5 UI Dave
- [ ] C6 Prova e Registro verificato
- [ ] C7 Attese ed errori

## Bloccato da
- niente

## TODO
- C1b: confermare con un /decodelninvoice reale quando lo stack di B1 è su (opzione A): un invoice per un asset il cui id contiene `_` o `~`, decodificato dal nodo e da `decodeBolt11`, campi identici.
  - **Lo fa Marco (B), dopo B2** (serve un nodo sbloccato con UTXO colorabili, es. dave): `pnpm --filter @kitty/relay exec tsx src/tools/check-bolt11.ts http://127.0.0.1:3004`. Lo script usa un asset NIA del nodo con `_` o `~` nell'id, oppure ne emette di usa e getta ("Baid64 check", `CHK`, al massimo 8). Poi crea un `/lninvoice`, lo confronta campo per campo tra `/decodelninvoice` e `decodeBolt11` e stampa `PASS`/`FAIL` (exit 1 se fallisce), più l'invoice e il JSON del nodo. Va incollato a C, che ne fa un vettore dorato nei test.

## Prossimo passo
- C2 `RelayClient` (`apps/agent/src/relay`): append su `POST /events`, list su `GET /events?since=`, subscribe su `GET /events/stream` con riconnessione da `Last-Event-ID`; backup su `PUT/GET /backups/:pubkey` (`application/octet-stream`).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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
