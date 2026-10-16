# Prompt stream B: nodi e soldi

> Incolla questo testo all'inizio di ogni sessione, seguito dall'ID del task (es. "Task B1"). Un task per sessione; `/clear` tra un task e l'altro.

---

Sei sullo **stream B** di kit+ty. Scrivi solo in: `infra/` (tranne `infra/fixtures`), `packages/rln-client`, `packages/shared/src/crypto.ts`, `apps/agent/src/{wallet,rail}`, `spikes/` e gli script `demo:*` ed `e2e:*` nel `package.json` radice. Tutto il resto è in sola lettura; se ti serve un cambiamento in `packages/shared`, descrivilo e fermati.

**Prima di tutto leggi `docs/spike-wdk.md` e `docs/spike-lightning.md`** e il registro decisioni di SPEC §20: dicono quali chiamate funzionano davvero. Il gate 2 ha scelto il motore `rln-rest` (SPEC §20) per i nodi Lightning, più `wdk-wallet-rgb` per la tesoreria di dave (emissione e on-ramp dei DUSD). Le API sono in `docs/vendor/rln-openapi.yaml` per i nodi e in `docs/vendor/wdk-wallet-rgb.md` per la tesoreria. Non usare parametri diversi da quelli verificati senza dirlo.

Lavora sul task indicato sotto, seguendo `PLAN.md` §4 (stream B) per il criterio "fatto quando". Proponi il piano e aspetta l'approvazione.

## Note per task
- **B1 infra:** parti da `_legacy/infra` e da `_legacy/docs/STATUS.md` (sezione "Learned the hard way"). bitcoind, electrs, proxy RGB e i quattro nodi RLN (alice 3001, bob 3002, charlie 3003, dave 3004, stessa immagine del vecchio progetto), sempre attivi. Porte legate a `127.0.0.1`. `.env.example` con tutte le variabili, senza valori segreti. Misura la memoria con `docker stats --no-stream` e scrivila nello stato.
- **B4 firme:** `SignatureVerifier` in TypeScript puro (il relay non ha un nodo): ed25519 dell'app + invoice di legame (SPEC §9.1); **mai `/signmessage` REST**, che in `d4762ac` firma la stringa vuota. `fakeVerify` resta solo per `KITTY_FAKES=1`.
- **B2 seed e `demo:reset`:** idempotente, rilanciabile. Un seed BIP-39 per membro in un file gitignored; emissione DUSD su dave (precisione 2) con `wdk-wallet-rgb`; on-ramp di 100.00 a viaggiatore; canali da 1,000,000 sat (viaggio D = 50.00 aperto dal viaggiatore, liquidità L = 30.00 aperta da dave); mining automatico fino a canali utilizzabili; stampa dei saldi attesi. `demo:reset` chiama `assertNoFakes()`.
- **B3 `Wallet` reale e `LightningRail`:** un'istanza per membro, con solo il suo seed o l'URL del suo nodo, secondo il motore. `pay` attende `/getpayment` fino a `Succeeded`/`Failed` con timeout e restituisce la `PaymentProof` con preimage. Gli errori RLN (corpo `{error, code, name}`) diventano i codici di `@kitty/shared` (`NODE_UNREACHABLE`, `INVOICE_EXPIRED`, `TOPUP_REQUIRED` se manca saldo in uscita, ecc.).
- **B7 esclusione:** `closeChannelsWith` cooperativa, mining su regtest, attesa della conferma, `txid` e link esplora REST `/tx/<txid>`.
- **B8 `e2e:demo`:** la demo di SPEC §16 passo per passo tramite `createAgentClient`, con asserzioni sui saldi attesi. Deve diventare il test che si lancia prima di ogni merge rischioso.
- **B5 rail on-chain:** porta `_legacy/apps/server/src/rgb/onchain-rail.ts` dietro l'interfaccia `Rail`. Diventa P0 se il gate ha scelto `onchain`.
- **B6 backup:** SPEC §12. `backupNow` dopo ogni cambio di stato: lock → backup → unlock e caricamento del blob cifrato sul relay. P1: `pnpm demo:lose-phone bob` cancella lo stato di bob, ripristina e mostra lo stesso saldo.
- **B9 liquidità di Dave:** `Wallet.openLiquidity` e un loop nell'agente di Dave che esegue `liquidityPlan` di A (SPEC §10.5) a ogni evento, aprendo canali di liquidità prima che servano.

Sei l'unico a cambiare `infra/` e gli script di seed: se A o C hanno problemi con lo stack, li aiuti tu.

A fine task aggiorna `docs/status/b.md`.

Task:
