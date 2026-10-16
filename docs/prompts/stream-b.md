# Prompt stream B: nodi e soldi

> Incolla questo testo all'inizio di ogni sessione, seguito dall'ID del task (es. "Task B1"). Un task per sessione; `/clear` tra un task e l'altro.

---

Sei sullo **stream B** di kit+ty. Scrivi solo in: `infra/` (tranne `infra/fixtures`), `packages/rln-client`, `packages/shared/src/crypto.ts`, `apps/agent/src/{wallet,rail}`, `spikes/` e gli script `demo:*` ed `e2e:*` nel `package.json` radice. Tutto il resto è in sola lettura; se ti serve un cambiamento in `packages/shared`, descrivilo e fermati.

**Prima di tutto leggi `docs/spike-lightning.md`:** contiene le richieste RLN che funzionano davvero e la modalità rail scelta al gate (anche nel registro decisioni di SPEC §20). Non usare parametri diversi da quelli verificati senza dirlo.

Lavora sul task indicato sotto, seguendo `PLAN.md` §4 (stream B) per il criterio "fatto quando". Proponi il piano e aspetta l'approvazione.

## Note per task
- **B1 infra:** parti da `_legacy/infra` e da `_legacy/docs/STATUS.md` (sezione "Learned the hard way"). Quattro nodi RLN (alice 3001, bob 3002, charlie 3003, dave 3004) con porte API legate a `127.0.0.1`; porte peer LN raggiungibili solo nella rete docker; stessa immagine RLN del vecchio progetto. `.env.example` con tutte le variabili, senza valori segreti. Misura la memoria con `docker stats --no-stream` e scrivila nello stato.
- **B4 firme:** prima `/signmessage` con verifica in TypeScript (vedi lo spike). Se dopo un'ora non funziona, passa al fallback ed25519 di SPEC §9.1 e avvisa A e C. `fakeVerify` resta solo per `KITTY_FAKES=1`.
- **B2 seed e `demo:reset`:** idempotente, rilanciabile. Emissione DUSD su dave (precisione 2), on-ramp di 100.00 a viaggiatore, apertura dei canali secondo la modalità del gate (D = 50.00, L = 30.00), mining automatico fino a canali utilizzabili, stampa dei saldi attesi. `demo:reset` chiama `assertNoFakes()`.
- **B3 `Wallet` reale e `LightningRail`:** un'istanza per membro, con solo l'URL del suo nodo. `pay` attende `/getpayment` fino a `Succeeded`/`Failed` con timeout e restituisce la `PaymentProof` con preimage. Gli errori RLN (corpo `{error, code, name}`) diventano i codici di `@kitty/shared` (`NODE_UNREACHABLE`, `INVOICE_EXPIRED`, `TOPUP_REQUIRED` se manca saldo in uscita, ecc.).
- **B7 esclusione:** `closeChannelsWith` cooperativa, mining su regtest, attesa della conferma, `txid` e link esplora REST `/tx/<txid>`.
- **B8 `e2e:demo`:** la demo di SPEC §16 passo per passo tramite `createAgentClient`, con asserzioni sui saldi attesi. Deve diventare il test che si lancia prima di ogni merge rischioso.
- **B5 rail on-chain:** porta `_legacy/apps/server/src/rgb/onchain-rail.ts` dietro l'interfaccia `Rail`. Diventa P0 se il gate ha scelto `onchain`.
- **B6 backup:** SPEC §12. Backup dopo ogni cambio di stato, cifrato, caricato sul relay con `RelayClient.putBackup`; `pnpm demo:lose-phone bob` cancella il volume di bob, crea un nodo nuovo, `/restore`, `/unlock`, e mostra lo stesso saldo.

Sei l'unico a cambiare `infra/` e gli script di seed: se A o C hanno problemi con lo stack, li aiuti tu.

A fine task aggiorna `docs/status/b.md`.

Task:
