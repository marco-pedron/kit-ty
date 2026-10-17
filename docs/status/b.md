# Stato stream B: nodi e soldi

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream B scrive qui.

## Task
- [x] B0 Spike Lightning → docs/spike-lightning.md (ven 10:35, modalità ln-2ch)
- [x] B0b Spike 2: motore WDK → docs/spike-wdk.md (ven 16:35, consigliato `rln-rest` + `wdk-wallet-rgb` per i DUSD di dave; decide il gate 2)
- [x] B1 Infra: bitcoind, electrs, esplora, proxy RGB, 4 nodi RLN (niente VSS) (sab 17/10 12:00)
- [x] B4 Verifica firme ed25519 in TS puro + invoice di legame (crypto.ts, sab 17/10 11:10)
- [x] B2 Seed e demo:reset (sab 17/10 12:45)
- [x] B3 Wallet reale e LightningRail (sab 17/10 13:40)
- [x] B7 Chiusura canali per l'esclusione (sab 17/10 15:55; PR aperta, merge dopo la conferma del PM)
- [ ] B8 e2e:demo
- [ ] B5 (P1) Rail on-chain
- [ ] B6 Backup automatico (lock → backup → unlock); demo:lose-phone = P1
- [ ] B9 Liquidità just-in-time di Dave (openLiquidity + liquidityPlan)

## Bloccato da
- niente

## Prossimo passo
- **Per chi gestisce `server.ts`/`config.ts` (A o C), collegare il wallet reale** quando `KITTY_FAKES=0`:
  ```ts
  import { RlnWallet } from './wallet/rln-wallet.js';
  import { loadMemberWalletOptions } from './wallet/secrets.js';
  const url = nodeUrls(config)[actor];
  const wallet = new RlnWallet(loadMemberWalletOptions(actor, { nodeUrl: url }));
  ```
  Ogni agente riceve solo il proprio wallet. Variabile opzionale `KITTY_SECRETS_FILE` (default `infra/.secrets/nodes.json`); l'asset id viene da `infra/.out/seed-state.json`. Se serve un rail: `new LightningRail(wallet)` (`apps/agent/src/rail/lightning-rail.ts`).
- Dopo B7: `pnpm demo:reset` (charlie è senza canali dopo `e2e:close`) e secondo giro di `pnpm e2e:close` per confermare i 7 blocchi; poi B8 (`e2e:demo`).
- Per chi collega dave in `server.ts`: `loadMemberWalletOptions('dave', { nodeUrl })` aggiunge già `coordinator` (esplora da `ESPLORA_URL` + miner). Gli altri membri non lo ricevono, e `closeChannelsWith` su di loro risponde `NOT_ALLOWED`.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### B7, sab 17/10 15:55
- Funziona: `RlnWallet.closeChannelsWith(peerPubkey)` (`apps/agent/src/wallet/rln-wallet.ts`), solo sul wallet di dave (opzione `coordinator`, data dal loader solo a dave; sugli altri `NOT_ALLOWED` senza nessuna chiamata al nodo). Restituisce `{ txids, explorerUrls, swept, blocksMined }`, compatibile con `{ txids }` dell'interfaccia: `flows/dave.ts` e FakeWallet non cambiano.
  1. Controlli prima di chiudere: canali con il membro (`/listchannels`, altrimenti `NOT_FOUND`), membro connesso (`/listpeers`, altrimenti `RECEIVER_UNREACHABLE` "Not forcing a close…"), tutti `Opened`, output di finanziamento trovato su esplora (valore = `capacity_sat`, p2wsh). Se uno fallisce, non si chiude niente.
  2. `/closechannel` con **`force: false` sempre** (c'è un test che lo controlla), un canale alla volta. Un rifiuto dice quali canali sono già in chiusura.
  3. `/closechannel` risponde `{}` senza txid: **il txid di chiusura è lo spend dell'output di finanziamento** (`GET /tx/<funding>/outspends` di esplora). Attesa in mempool di 60 s, poi errore chiaro.
  4. Mining (stesso `bitcoin-cli -generate` di `infra/scripts/mine.sh`, `wallet/chain.ts`): 1 blocco alla volta fino alla conferma, poi 5 blocchi, poi **attesa (fino a 45 s) che i nodi trasmettano gli sweep** e un blocco per confermarli. Budget di 12 blocchi in tutto; se lo sweep non arriva, `swept: false` (la chiusura resta valida). Infine `/refreshtransfers` di dave.
  - `balances()` di ogni membro fa `/refreshtransfers` (body dello spike) al massimo ogni 15 s, prima di `/assetbalance`: è così che charlie vede i DUSD dello sweep in `onchainCents`. Se il refresh fallisce, il saldo viene restituito comunque.
- Come si prova: `pnpm test` (11 test nuovi con nodo, esplora e catena finti, più 1 del loader). Sullo stack: **`pnpm e2e:close`**, **IRREVERSIBILE** (chiude i canali di charlie; dopo serve `pnpm demo:reset`), con configurazione e suffisso `.destructive.ts` suoi, fuori da `pnpm test`, `e2e:wallet` e CI. Controlla: rifiuto sul wallet di bob; 2 txid confermati, link `/tx/` 200; nessun canale dave↔charlie; charlie `onchainCents` +50.00, uscita e ingresso a 0; dave +30.00; secondo tentativo → `NOT_FOUND`. Riepilogo in `infra/.out/e2e-close.json`.
- **Primo giro reale (15:45, verde, 69 s):** chiusure confermate a h125, ma sweep a **h135**: 11 blocchi su 12, contro i 6 dopo la conferma dello spike. Ipotesi: minando un blocco ogni 1,5 s i nodi restano indietro e lo sweep parte tardi. Saldi dopo: charlie 100.00 `settled`, 0 canali; dave 230.00 `settled` (+30.00). Correzione (attesa degli sweep invece di minare alla cieca) fatta dopo, coperta dai test unitari: **da confermare con un secondo `e2e:close` dopo `demo:reset`** (attesi 7 blocchi).
- Problemi noti: la chiamata dura decine di secondi dentro "Copri ed escludi" (l'op `closing_channels` lo mostra). Esplora REST (`/tx`, `/outspends`, `/blocks/tip/height`) non è in `docs/vendor`, ma è lo stesso server delle prove. L'agente usa `docker` per minare: solo regtest.
### B3, sab 17/10 13:40
- Funziona: `RlnWallet` (`apps/agent/src/wallet/rln-wallet.ts`), motore `rln-rest`, un'istanza per membro con **solo** `{ nodeUrl, appSecretHex, assetId }` del proprio membro (`loadMemberWalletOptions` in `wallet/secrets.ts` legge i file del seed e restituisce solo quei tre campi). `LightningRail` in `rail/lightning-rail.ts` (modalità `ln-2ch`, rifiuta richieste on-chain).
  - `nodePubkey`: `/nodeinfo` (in cache; dopo un errore riprova). `authorPubkey`/`sign`: ed25519 con `ed25519PublicKeyHex`/`ed25519Sign`, nuove in `crypto.ts`, formato B4. Mai `/signmessage`.
  - **Chiave dell'app (opzione A):** `HKDF-SHA256(mnemonica normalizzata, salt "kitty-app-key-v1", info "ed25519", 32 byte)`. Normalizzazione: NFKD, trim, spazi singoli, minuscole. Test con la mnemonica BIP-39 di prova (`abandon … about`) e `appPubkey` attesa scritta nel test (segreto verificato con un HKDF indipendente in Python).
  - `bindInvoice`: invoice da 1 centesimo con `kitty-bind:<sha256Hex(appPubkey)>` (come il FakeWallet), 3600 s; passa `checkBindInvoice` anche decodificato dal nodo di un altro membro.
  - `createInvoice`: `/lninvoice` con `amt_msat` = `rgb_htlc_min_msat` di `/nodeinfo`; controlla con `/decodelninvoice` che payee e importo tornino. `decodeInvoice`: `expiresAt = timestamp + expiry_sec`. `balances`: `/assetbalance` (`offchain_outbound`, `offchain_inbound`, `settled`).
  - `pay`: un pagamento alla volta per wallet; prima di inviare controlla scadenza (margine 5 s) → `INVOICE_EXPIRED`, asset e importo → `VALIDATION_ERROR`, `offchain_outbound` → `TOPUP_REQUIRED`; poi `/sendpayment` e `/getpayment` ogni 250 ms, timeout 30 s. `Failed` → `PAYMENT_FAILED`; timeout ancora `Pending` → `PAYMENT_FAILED` con l'azione "potrebbe ancora completarsi, non pagare di nuovo". Una risposta ambigua di `/sendpayment` (rete, 5xx, corpo illeggibile) o `DuplicatePayment` si risolve con `/getpayment` (`PaymentNotFound` = non partito): **ripagare lo stesso invoice restituisce la stessa prova**, verificato su regtest. Su `Succeeded` verifica hash, `sha256(preimage)`, asset, importo, payee e verso; se qualcosa non torna → `INTERNAL`, mai un successo.
  - Errori RLN (`{error, code, name}`, nomi di `error.rs` a `d4762ac`): rete/`LockedNode`/`NotInitialized` → `NODE_UNREACHABLE`; `InsufficientAssets`/`InsufficientCapacity` → `TOPUP_REQUIRED`; `InvalidInvoice`/`InvalidAmount`/`InvalidAssetID`/`IncompleteRGBInfo` → `VALIDATION_ERROR`; `NoAvailableUtxos` → `NO_AVAILABLE_UTXOS`; qualunque altro nome o corpo di forma diversa → `PAYMENT_FAILED` durante un pagamento, `INTERNAL` altrove. Mai un'eccezione grezza.
  - `openLiquidity`, `closeChannelsWith`, `backupNow`: `WalletError('NOT_IMPLEMENTED', '… not implemented in B3')`.
- `@kitty/rln-client`: `createRlnClient(url, { fetch })` con fetch iniettabile; `RlnError`/`toRlnError` (corpo non conforme → nome `Unknown`).
- Come si prova: `pnpm test` (46 test del wallet con un nodo RLN finto, 8 del client, 3 nuovi in `crypto.test.ts`, 2 del loader). Con lo stack acceso e sbloccato: **`pnpm e2e:wallet`** (fuori da `pnpm test`; prima controlla che alice e bob rispondano e abbiano 2 canali usabili, altrimenti dice di lanciare `pnpm infra:up && pnpm demo:unlock`): identità e invoice di legame; alice chiede 0.01, bob paga via dave, prova verificata (schema, `sha256(preimage)`, payee = nodo di alice); stesso invoice ripagato = stessa prova; invoice scaduto e importo oltre il saldo rifiutati senza inviare. **Ogni pagamento viene restituito**: dopo il test i saldi DUSD dei 4 nodi sono identici a quelli del seed (verificato). Verde in 14 s.
- Problemi noti: ogni esecuzione di `e2e:wallet` fa 6 pagamenti alice ⇄ bob da 3000 sat per hop (DUSD invariati, sat che si spostano; capacità ≈ 330 pagamenti per canale). Il wallet non è ancora collegato in `server.ts` (fuori dalle cartelle di B, istruzioni sopra). Le chiavi dell'app dipendono dalla mnemonica: dopo un `demo:reset` cambiano, come le pubkey dei nodi.

### B2, sab 17/10 12:45
- Funziona: `pnpm demo:reset` = `assertNoFakes()` (quello vero di `apps/agent/src/dev-fakes/guard.ts`, importato da Node 22 con type stripping) → `infra:reset` (cancella i volumi) → cancella `infra/data/treasury` → seed. **Tre esecuzioni di fila verdi**, 68-70 s di seed (circa 80 s in tutto), nessun tentativo ripetuto nelle ultime due. Con `KITTY_FAKES=1` si ferma prima di toccare lo stack.
- Seed (`infra/treasury/seed.ts`): `/init` + `/unlock` dei 4 nodi; 1 BTC a ciascun nodo e alla tesoreria; `/createutxos`; emissione di 10,000.00 DUSD (NIA, precisione 2) con `wdk-wallet-rgb` sulla tesoreria di dave; on-ramp uno alla volta: 100.00 ad alice, bob e charlie, e al nodo RLN di dave **4 allocazioni separate** (3 × 30.00 per i canali di liquidità + 200.00 di riserva per le aperture just-in-time di B9); 6 canali da 1,000,000 sat pubblici con anchor (viaggio 50.00 aperto dal viaggiatore, liquidità 30.00 aperta da dave); mining fino a 6/6 `ready && is_usable`; stampa dei saldi e controllo dei valori attesi (esce con errore se non tornano).
- Saldi attesi dopo il seed: ogni viaggiatore 50.00 on-chain, canale di viaggio 50.00/0 (sat 999,013 locali), liquidità 0/30.00; dave 200.00 on-chain, 90.00 in uscita, 150.00 in ingresso.
- `pnpm demo:unlock`: sblocca i 4 nodi con le password salvate, ricollega a dave i viaggiatori che non l'hanno tra i peer, aspetta che tutti i canali siano usabili (60 s). Provato dopo `docker compose restart` dei 4 nodi: charlie **non si ricollega da solo**, con lo script 6/6 usabili.
- File prodotti (gitignored, mai committati): `infra/.secrets/nodes.json` (0600: password e mnemoniche dei nodi, mnemonica della tesoreria; mai stampati, verificato sul log), `infra/.out/seed-state.json` (asset id, pubkey, txid dell'on-ramp, canali: non segreto, per B3), `infra/.out/decode-vector.json` (vettore per il decoder del relay di C: invoice di alice da 3.09, `amt_msat` 3,000,000, `expiry_sec` 3600, decodificato dal nodo di dave; `payee_pubkey` = pubkey di alice).
- Tesoreria: progetto npm separato `infra/treasury` (fuori dai glob di `pnpm-workspace.yaml`, lockfile suo), Node 22.23.3 via fnm (`infra/scripts/node22.sh`, che installa con `npm ci` e **si ferma se le versioni non sono esatte**: `@utexo/wdk-wallet-rgb` 2.0.3, `@utexo/rgb-lib` e `-darwin-arm64` 0.3.0-beta.8). Root `pnpm-lock.yaml` e versione di Node della radice non toccati. `pnpm lint` controlla anche `infra/treasury` (ESLint accetta i file senza tsconfig).
- **Scelte e deviazioni dai parametri verificati (approvate dal PM):**
  1. **Mnemonica della tesoreria separata** (`WalletManagerRgb.getRandomSeedPhrase(12)`), mai quella del nodo RLN di dave: RLN e `wdk-wallet-rgb` usano entrambi rgb-lib, e la stessa mnemonica potrebbe derivare lo stesso wallet e spendere due volte gli stessi UTXO. Lo "stesso seed va bene" dello spike 2 vale solo verso nodi `wdk`.
  2. **Endpoint del proxy riscritto lato mittente:** l'invoice RGB del nodo RLN contiene `rpc://proxy:3000/json-rpc` (indirizzo nella rete docker), che dall'host non si risolve; la tesoreria invia allo stesso proxy via `rpc://127.0.0.1:3000/json-rpc`. Il nodo ricevente resta su `proxy:3000`. On-ramp verso RLN REST (mai provato prima): **verde al primo tentativo**.
  3. **`/createutxos` con `size` esplicito:** RLN finanzia i canali dal wallet colorato; con soli UTXO da 32,000 sat `/openchannel` dà `403 InsufficientFunds: missing 680000 sats`. Oltre alla chiamata verificata (`up_to: true, num: 10, size: null`), il seed crea `up_to: false, size: 1,100,000` (2 per viaggiatore, 4 per dave).
- Problemi trovati e risolti: (a) tre `/openchannel` di dave di seguito spendono gli stessi input (`FailedBroadcast … bad-txns-inputs-missingorspent`, 2 canali bloccati in `Opening`); (b) dave ha rifiutato una volta il canale di bob durante l'apertura per un errore temporaneo dell'indexer (`Failed to connect to indexer … transaction can't be located`, tx già confermata). Soluzione: aperture **una alla volta**; dopo ognuna si aspetta la tx di finanziamento su esplora, si mina 1 blocco e si aspetta che esplora sia in pari; se il canale sparisce si riapre (al massimo 3 tentativi). Nessun parametro cambiato.
- Memoria (`docker stats --no-stream`, dopo il seed, 6 canali aperti, nodi sbloccati): **≈ 408 MiB** su 3,8 GiB (esplora 116, bitcoind 78, proxy 46, electrs 22, rln-dave 41, rln-bob 37, rln-charlie 37, rln-alice 31).
- Come si prova: `pnpm demo:reset` (due volte di fila); `docker compose -f infra/docker-compose.yml restart rln-alice rln-bob rln-charlie rln-dave && pnpm demo:unlock`.
- Problemi noti: nella stampa, "sat remote" del canale è `capacity − local` (include commissione di impegno e anchor), non il saldo spendibile del peer. Lo script di prova dello step 0 (`onramp-check.ts`) è stato tolto: lo copre il seed, e su uno stack già inizializzato avrebbe sovrascritto le password. Nessun test Docker o Node 22 in `pnpm test`. Solo Mac arm64 (binario `rgb-lib-darwin-arm64`).

### B1, sab 17/10 12:00
- Funziona: stack regtest in `infra/docker-compose.yml`, progetto compose `kitty` (volumi `kitty_*`, separati da quelli `settleup` del vecchio progetto): bitcoind (18443), electrs (50001), esplora REST (3010), rgb-proxy-server 0.3.0 (3000), 4 nodi RLN con l'immagine `settleup/rln:d4762ac`: alice 3001/9735, bob 3002/9736, charlie 3003/9737, dave 3004/9738. **Tutte le porte pubblicate sono legate a `127.0.0.1`** (verificato con `docker port` e `lsof`). Niente server VSS (gate 2: lock → backup → unlock).
- Script in `infra/scripts/`: `up.sh` (controllo dell'immagine e delle porte libere, 103 blocchi iniziali, attesa dei servizi), `down.sh`, `reset.sh` (cancella i volumi), `check.sh`, `mine.sh <n>`, `fund.sh <addr> <btc>`, `build-rln.sh` (ricostruisce la stessa immagine dal commit fissato, 15-40 min). `infra/.env.example` elenca tutte le variabili, password e mnemoniche vuote.
- Come si prova: `pnpm infra:reset && pnpm infra:check` → `all checks passed` (container attivi, altezza ≥ 103, esplora allineato, 4 RLN rispondono a `/nodeinfo`, proxy `server.info`, un blocco minato arriva a esplora, porte solo su 127.0.0.1). `pnpm infra:up` riavvia senza perdere dati, `pnpm infra:down` ferma.
- Memoria (`docker stats --no-stream`, nodi appena avviati e ancora bloccati): **≈ 486 MiB in totale** su 3,8 GiB di Docker Desktop (esplora 139, proxy 132, bitcoind 98, electrs 37, rln-dave 56, altri RLN ≈ 8 ciascuno). Crescerà dopo `/unlock` e con i canali: da rimisurare dopo B2.
- Problemi noti: i nodi rispondono 403 `LockedNode` finché il seed (B2) non fa `/init` + `/unlock`; è la risposta attesa. Nessun test Docker in `pnpm test`.

### B4, sab 17/10 11:10
- Funziona: `signatureVerifier.verify` in `packages/shared/src/crypto.ts` con `@noble/curves` (niente `node:crypto` né `Buffer`, gira anche nel browser). Non lancia mai eccezioni: con un input malformato restituisce `false`. `checkBindInvoice(decoded, appPubkey, nodePubkey)` controlla l'invoice di legame già decodificato (non decodifica il bolt11). I fake restano invariati.
- **Formato per B3 (`Wallet.sign`):** `authorPubkey` = chiave pubblica ed25519 di 32 byte, `sig` = 64 byte, entrambe in hex minuscolo; si firmano i byte UTF-8 di `message` (`canonical(inner)`). Verifica RFC 8032 rigorosa (`zip215: false`): una `s` non canonica viene rifiutata. Con `@noble/curves`: `bytesToHex(ed25519.sign(utf8ToBytes(msg), secret))`.
- Invoice di legame: `description` deve essere esattamente `kitty-bind:${sha256Hex(appPubkey)}` (sha256 dell'hex come stringa UTF-8, come nel FakeWallet) e `payeePubkey === nodePubkey`; `appPubkey` deve avere 64 caratteri hex minuscoli.
- Come si prova: `pnpm vitest run packages/shared/src/crypto.test.ts` (vettore RFC 8032 n. 1, firma alterata, chiave altrui, s + L, 16 input malformati, legame verso un altro nodo o per un'altra chiave).
- Problemi noti: nessuno.

### B0b, ven 16/10 16:35
- Funziona con `wdk` `0.1.0-beta.15`/`0.1.0-beta.11`: 4 nodi in un processo; emissione DUSD con `wdk-wallet-rgb@2.0.3` (solo Node 22) e invio ai nodi LN; pagamento instradato alice → dave → bob in 4,4 s con preimage, **solo** con canali privati aperti da dave (forma `ln-lsp`); firma nativa del nodo verificata in TS puro (`spikes/wdk/verify.ts`); `vssBackup` a nodo acceso.
- Non funziona: annuncio dei canali (il firmatore VLS lo rifiuta), canali in ingresso verso dave quando inoltra a canali privati, riavvio di un nodo con canali, sweep dei DUSD dopo la chiusura cooperativa, ripristino da VSS (lo sblocco si blocca).
- Come si prova: stack `settleup` senza RLN; `cd spikes/wdk && npm ci && fnm exec --using=22.23.3 node 08-full-single.ts` (spostare prima `data/` e `.secrets`); `node verify.ts`; VSS: `docker compose -f spikes/wdk/vss/compose.yaml up -d`, poi `09-vss.ts`.
- Lasciati accesi: container `kitty-vss-*` (porta 127.0.0.1:8081) e lo stack `settleup` senza RLN. Dati delle prove in `spikes/wdk/data-run*` (gitignored). Node 22.23.3 installato con fnm.
