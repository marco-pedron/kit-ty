# Stato stream C: relay e interfaccia

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream C scrive qui.

## Task
- [x] K0 Sessione contratto (revisione): `api.ts` e `views.ts` approvati dal PM; registro in `a.md`
- [x] C1 Relay (branch `c/C1-relay`)
- [ ] C2 RelayClient
- [ ] C3 Rotte dell'agente
- [ ] C4 UI viaggiatore
- [ ] C5 UI Dave
- [ ] C6 Prova e Registro verificato
- [ ] C7 Attese ed errori

## Bloccato da
- EXPENSE_SUBMITTED reali non passano dal relay finché non c'è decodeInvoice (B)
- Senza fake, finché il verificatore di B4 è uno stub ogni `POST /events` risponde 409 `INVALID_EVENT` ("rule check failed: NotImplementedError…"): il `validateEvent` di A2 (mergiato) non lancia mai e trasforma l'errore dello stub in un rifiuto. Con `KITTY_FAKES=1` il relay funziona (validatore permissivo)

## Prossimo passo
- C2 `RelayClient` (`apps/agent/src/relay`): append su `POST /events`, list su `GET /events?since=`, subscribe su `GET /events/stream` con riconnessione da `Last-Event-ID`; backup su `PUT/GET /backups/:pubkey` (`application/octet-stream`).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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
