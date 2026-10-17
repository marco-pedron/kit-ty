# Stato stream B: nodi e soldi

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream B scrive qui.

## Task
- [x] B0 Spike Lightning → docs/spike-lightning.md (ven 10:35, modalità ln-2ch)
- [x] B0b Spike 2: motore WDK → docs/spike-wdk.md (ven 16:35, consigliato `rln-rest` + `wdk-wallet-rgb` per i DUSD di dave; decide il gate 2)
- [x] B1 Infra: bitcoind, electrs, esplora, proxy RGB, 4 nodi RLN (niente VSS) (sab 17/10 12:00)
- [x] B4 Verifica firme ed25519 in TS puro + invoice di legame (crypto.ts, sab 17/10 11:10)
- [ ] B2 Seed e demo:reset
- [ ] B3 Wallet reale e LightningRail
- [ ] B7 Chiusura canali per l'esclusione
- [ ] B8 e2e:demo
- [ ] B5 (P1) Rail on-chain
- [ ] B6 Backup automatico (lock → backup → unlock); demo:lose-phone = P1
- [ ] B9 Liquidità just-in-time di Dave (openLiquidity + liquidityPlan)

## Bloccato da
- niente

## Prossimo passo
- B2 (seed e `demo:reset`). In B3 `Wallet.sign` deve produrre il formato di B4 (sotto).

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
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
