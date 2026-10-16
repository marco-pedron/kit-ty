# Prompt stream C: relay e interfaccia

> Incolla questo testo all'inizio di ogni sessione, seguito dall'ID del task (es. "Task C1"). Un task per sessione; `/clear` tra un task e l'altro.

---

Sei sullo **stream C** di kit+ty. Scrivi solo in: `apps/relay`, `apps/web`, `apps/agent/src/{relay,routes}`. Tutto il resto è in sola lettura; se ti serve un cambiamento in `packages/shared` (rotte, viste), descrivilo e fermati.

Lavora sul task indicato sotto, seguendo `PLAN.md` §4 (stream C) per il criterio "fatto quando". Proponi il piano e aspetta l'approvazione.

## Note per task
- **C1 relay:** Fastify su :4000, `better-sqlite3`, tabella `events` **append-only** (niente UPDATE né DELETE). All'arrivo: `validateEvent` del ledger con `verifySignature` di `@kitty/shared`, poi `seq`, `prevHash`, `hash` (SPEC §9.1). `GET /events?since=`, `GET /events/stream` (SSE), `PUT/GET /backups/:pubkey` (blob opachi, limite di dimensione). Il relay non conosce chiavi private e non interpreta i backup.
- **C2 `RelayClient`:** append, list, subscribe via SSE con riconnessione e recupero da `since`.
- **C3 rotte dell'agente:** SPEC §14.3, sottili: validano con gli schemi di `api.ts` e chiamano i flussi di A. Il ruolo arriva dal percorso; un viaggiatore non può chiamare le rotte di Dave (`NOT_ALLOWED`).
- **C4-C6 UI:** mobile-first, tre finestre a larghezza telefono affiancate. Polling di `/state` ogni secondo. Nessun fake nella UI: per sviluppare usa l'agente con `KITTY_FAKES=1` (la UI mostra il banner che arriva da `/state`).
  - Viaggiatore: **Home** (saldo del canale con "solo tu puoi spenderli", devo / mi devono), **Ho pagato** (foto → "Lettura sul dispositivo…" con tempo trascorso → righe modificabili → frase → anteprima quote → Invia), **Da approvare** (righe con importo, conto alla rovescia del silenzio-assenso, Approva / Contesta con motivo), **Attività** (ogni spesa e pagamento, con la frase dell'agente che spiega cosa ha fatto e perché), **Impostazioni** (limiti dell'agente).
  - Dave: **Membri** (stato, esclusi, crediti dell'operatore), **Contestazioni** (righe estratte dall'AI, motivo, Conferma / Annulla riga / Annulla spesa), **Insolvenze** ("Copri ed escludi", con conferma che spiega cosa succede), **Tasso del giorno**.
  - Condiviso: **Prova** (preimage ↔ payment hash ✓, invoice firmato dal creditore ✓, importo ✓; per le chiusure txid e link esplora) e **Registro verificato** (eventi, firme valide, catena, testa; "uguale su N/N" è P1).
- **C7:** ogni attesa dice cosa succede ("Waiting for Bob's agent…", "Routing through the operator's node…") con il tempo trascorso; ogni errore ha un messaggio umano e un'azione suggerita. Prova spegnendo `rln-dave` durante un pagamento.

Il flusso conta più dell'estetica: chiarezza dei passi, errori gestiti, comprensibile per un estraneo in pochi secondi. Testi della UI in inglese.

A fine task aggiorna `docs/status/c.md`.

Task:
