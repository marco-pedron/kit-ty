# Spike 3: kit+ty su LSP (`wdk-rgb-lightning` + LSP Utexo), risultati

Data: martedì 20/10/2026, 10:00–11:00 CEST (circa 1 ora di lavoro effettivo). Branch `spike/wdk-lsp`, cartella `spikes/wdk-lsp/`. Mac arm64, 8 GB di RAM, Docker con 4 GB, Node 22.23.3.
Stack regtest **isolato** da quello del progetto (`spikes/wdk-lsp/docker/compose.yaml`, progetto Docker `kitty-lsp`, porte 28443/50101/3100/29301/29380/8091): lo stack `kitty` della demo non è stato toccato.
Log di ogni passo (senza segreti): `spikes/wdk-lsp/calls.log`; i riferimenti `calls.log:N` sono numeri di riga. Mnemoniche e password in `spikes/wdk-lsp/.secrets*` (gitignored).

## In breve (per chi non è tecnico)

1. Abbiamo provato a far girare kit+ty con il portafoglio Lightning di Tether WDK sul dispositivo di ogni membro e un nodo di servizio (LSP) di Utexo al posto di dave.
2. Il server LSP di Utexo è open source e l'abbiamo fatto girare da soli su regtest: si può ospitare in proprio.
3. Molti difetti dello spike 2 sono corretti nella versione nuova (non ancora pubblicata su npm): il portafoglio sopravvive ai riavvii e, chiudendo un canale d'accordo, i dollari digitali tornano al proprietario.
4. Il pagamento alice → LSP → bob in DUSD funziona (circa 6 secondi, con prova crittografica), ma solo dopo aver aggirato un'impostazione dell'LSP.
5. Però tutto funziona solo con il firmatore in modalità "permissiva", che è una modalità di prova: con quella di produzione i canali non si aprono e i pagamenti si bloccano.
6. Se l'LSP smette di collaborare, il membro non può uscire da solo: la chiusura unilaterale di un canale con DUSD viene rifiutata da Bitcoin e i fondi restano bloccati.
7. Il ripristino da backup VSS riporta saldo e canali, ma al primo pagamento il canale si rompe e i DUSD restano fermi.
8. Se bob è spento, il pagamento di alice fallisce subito (nessuna perdita): i pagamenti "asincroni" esistono solo con i canali virtuali di Utexo, che richiedono fiducia nell'LSP.
9. Firmare gli eventi del registro senza nodo acceso e senza rete si può, partendo dalla seed.
10. **Raccomandazione: per ora restiamo su `rln-rest`; l'LSP va in roadmap**, da riprovare quando Utexo avrà corretto firmatore, chiusura unilaterale e ripristino.

## Versioni usate (solo dentro `spikes/wdk-lsp/`)

| Pacchetto | Versione | Note |
|---|---|---|
| `@utexo/wdk-rgb-lightning` | **`0.2.0-beta.4`** da GitHub (`UTEXO-Protocol/wdk-rgb-lightning#a5d3439`) | **non su npm**: su npm `latest` è ancora `0.1.0-beta.15` |
| `@utexo/rgb-lightning-node-nodejs` | **`0.2.0-beta.4`** (npm, dist-tag `beta`) | RLN `v0.17.0-beta.3` (`ecc69f2`), LDK `79b9eb5`, prebuilt `darwin-arm64` incluso |
| `@utexo/wdk-wallet-rgb` | `2.0.3`, importato **in sola lettura** da `infra/treasury/node_modules` | il binario `@utexo/rgb-lib-darwin-arm64@0.3.0-beta.8` non compila più con l'SDK di macOS 27 (errore del linker su `libSystem.tbd`); non ho reinstallato nulla nel progetto |
| `utexo-lsp` (server LSP) | `main` `b865c88`, immagine costruita in locale | Go, pubblico; l'immagine GHCR `ghcr.io/utexo-protocol/utexo-lsp` risponde `unauthorized` |
| Nodo RLN dell'LSP | UTEXO `rgb-lightning-node` **`v0.13.0-beta.3`** (`af03c7f`), il submodule fissato da `utexo-lsp` | `v0.17.0-beta.3` **non si compila** senza accesso a repository privati (`rgb-consensus-s-bfa`, `rgb-ops-s-bfa`, `rgb-schemas-s-bfa`: 404) |
| VSS | `lightningdevkit/vss-server` `e4c8359` (sigs) + Postgres 16 | stesso commit dello spike 2 e del compose di RLN `v0.13` |

## Domande, esiti e prove

| # | Domanda | Esito | Prove | Note |
|---|---|---|---|---|
| A | Versioni e correzioni pubblicate | ⚠️ | `calls.log:1-4` | `createWithStorage` e RLN ≥ 0.15 (anzi `0.17.0-beta.3`) ci sono, ma solo nel binding `0.2.0-beta.4` (npm `beta`) e in `wdk-rgb-lightning` `0.2.0-beta.4` **solo su GitHub**. Il CHANGELOG di Utexo stesso dichiara aperti: firmatore strict, chiusura forzata RGB, ripristino VSS "non qualificato". |
| B | Persistenza VLS e canali dopo riavvio | ⚠️ ✅ permissivo / ❌ strict | strict: `calls.log:15-18, 41-42, 211`; permissivo: `:20-35, 47-54` | Lo stato del firmatore sta ora in `dataDir/vls-signer` (redb): con policy **permissiva** canale aperto, due riavvii completi del processo, pagamenti in entrambe le direzioni dopo ogni riavvio (260 ms – 2,3 s). Con policy **strict** (quella di default e l'unica ammessa su mainnet) il canale non si apre (`funding_created awaiting signer`) e su un canale già aperto i pagamenti restano `Pending`; si sbloccano solo riavviando in permissivo. |
| C | DUSD dopo la chiusura | ⚠️ coop ✅ / unilaterale ❌ | coop: `calls.log:59-72`; unilaterale: `:73-86` | **Cooperativa:** i DUSD tornano on-chain a entrambi (alice 16.691, bob 3.309) dopo 13-15 blocchi, 36 s: il difetto dello spike 2 è corretto. Durante quei blocchi il saldo in canale "sparisce" dalla vista. **Unilaterale:** Bitcoin Core rifiuta il commitment (`-26 mempool-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)`), l'output di finanziamento resta non speso dopo 161 blocchi con 8.000 DUSD dentro. È il blocco 4 della qualificazione di Utexo. |
| D | Ripristino VSS (seed + VSS) | ❌ | backup: `:167, 173, 190, 193`; ripristino: `:177, 197`; dopo: `:198-209` | Backup a nodo acceso in 59-103 ms. Ripristino su `dataDir` vuota in **2-3 s**: stessa pubkey, stessi DUSD, stessi canali (lo spike 2 si bloccava allo sblocco). Ma al **primo pagamento** dopo il ripristino LDK chiude il canale (`Failed to validate our commitment`), il firmatore del membro non firma il proprio commitment (`Waiting for signature of unsigned onchain transaction`) e, anche dopo che l'LSP ha pubblicato il suo, i 2.720 DUSD del membro restano in un output non speso dopo 151 blocchi. Trappola: dopo un crash il riavvio è rifiutato (`VSS store_id is owned by another rgb-lightning-node instance`); `clearVssFence` prima dello sblocco lo risolve (`:162-164`). |
| E | LSP Utexo su regtest; pagamento alice → LSP → bob | ⚠️ | avvio: `:100, 114`; pagamento fallito: `:126, 133, 212`; riuscito: `:136-141`; ponti: `:148-152` | Il server gira in proprio (Go + nodo RLN `v0.13`), `GET /get_info` risponde. Il **pagamento instradato** alice → LSP → bob in DUSD riesce (6,2 s; bob → alice 4,3 s), con preimage lato pagatore, `sha256(preimage) == payment_hash` e `payee_pubkey` = destinatario, ma **solo** dopo aver fermato il cron di `utexo-lsp` e chiuso i canali che apre lui (vedi F). `receiveAsset`/`sendAsset` **non sono** pagamenti tra membri: sono ponti on-chain ↔ Lightning in cui l'LSP fa da controparte. `receiveAsset` (alice paga on-chain, l'LSP paga l'invoice LN di bob) arriva a `settled`; con `sendAsset` l'invoice pagato da alice è **dell'LSP** (`payeeIsLsp: true`), e i 100 DUSD restano `future` sul wallet di bob dopo 10 blocchi. |
| F | Canali normali con asset RGB via LSP | ✅ (con riserva) | `:115-117`, `:139` | L'LSP apre da solo (cron) un canale **standard**, ancorato on-chain (funding confermato, 3 output), con 3.000 DUSD suoi verso ogni membro; il membro apre il proprio verso l'LSP. Riserva: con `DEFAULT_VIRTUAL_OPEN_MODE` vuoto il cron apre canali `public: true`; il firmatore VLS del membro rifiuta di firmarne l'annuncio, il canale non entra mai nel grafo e, per la regola di LDK, la sua sola presenza toglie **tutti** i route hint dagli invoice del membro: nessuno gli può più pagare. Canali **privati** aperti dal nodo LSP via REST funzionano. |
| G | Pagamento con bob offline | ❌ (nessuna perdita) | `:153-159` | Con canali normali l'LSP rimanda subito indietro l'HTLC: `Failed` in 5 s, il saldo di alice resta intatto, l'LSP non trattiene né prende in custodia nulla. Bob riaccende → un nuovo pagamento passa in 6,1 s. Il pagamento asincrono esiste solo come **APay** (sezione in fondo): richiede `enableVirtualChannelsV0` e canali virtuali `trusted_no_broadcast`, esclusi da questo spike. |
| H | Firma offline dalla seed | ✅ | `:5-14` | `account.sign()` richiede il nodo sbloccato (`Rln(NotInitialized)`), e lo sblocco richiede la rete. Ma (1) `keyPair.publicKey` è disponibile senza sblocco; (2) la chiave del nodo si deriva in **TypeScript puro**: BIP-32 `m/0'` dai primi 32 byte del seed BIP-39 (`02b-derive-node-key.ts`), e la firma nel formato Lightning è verificata dallo stesso `verify.ts` dello spike 2; (3) la chiave ed25519 dell'app (SPEC §9.1) si deriva dalla seed in modo deterministico e firma offline. |
| I | QVAC 0.21: `tools` / `mcp` in `completion()` | ✅ (statico) | `:210` | Il `@qvac/sdk` `0.21.0` installato ha `tools?: Tool[] \| ToolInput[]` e `mcp?: McpClientInput[]` in `completion()` e nel batch; serve un modello caricato con `modelConfig.tools: true`; `responseFormat` non si combina con `tools`/`mcp`. Nessun modello caricato. |

### Interoperabilità osservata (utile per il futuro)
- DUSD emesso da `wdk-wallet-rgb` 2.0.3 (rgb-lib `0.3.0-beta.8`) arriva sia sul nodo WDK (RLN `0.17`) in 4 s (`calls.log:56-58`) sia sul nodo LSP (RLN `0.13`).
- Canali RGB e pagamenti tra client RLN `0.17` (VLS) e LSP RLN `0.13` (senza VLS) funzionano in entrambe le direzioni.
- `sendRgbAsset` in `0.2.0-beta.4` vuole `recipient_groups`, non `invoice` + `amount`; `createRgbInvoice` per `onchain_send` deve avere `assignment_kind: 'Fungible'` e l'importo, altrimenti l'LSP risponde 400.

## Raccomandazione per il Gate 3

**Restiamo su `rln-rest`; `WdkLspWallet` e l'LSP vanno in roadmap.** In base alle domande decisive:

- **B (persistenza):** corretta, ma solo con la policy **permissiva** del firmatore, che Utexo stesso etichetta come diagnostica di regtest e che su mainnet è rifiutata. Con la policy strict non si apre nemmeno un canale. Una demo su policy permissiva non dimostra un portafoglio che si possa portare in produzione.
- **C (recupero DUSD):** la chiusura cooperativa ora restituisce i DUSD (✅), ma quella unilaterale no. Nel modello LSP il membro si fida di non dover mai uscire da solo: se l'LSP smette di collaborare, i suoi DUSD restano bloccati nel canale. Oggi kit+ty dice "Dave può essere fastidioso, ma non può rubare"; con questo stack l'LSP non può rubare, ma può tenere i fondi in ostaggio.
- **E (LSP eseguibile):** sì, in proprio, ma solo nella versione `v0.13` del nodo (la `v0.17` del client richiede repository privati), con un'immagine Docker non pubblica e un cron che, con client WDK, rende i membri irraggiungibili finché non lo si aggira.
- **F (canali normali):** ✅, è la parte che regge: canali standard ancorati on-chain, quindi senza custodia, a parte il problema `public` di E.
- **G (asincrono):** con canali normali non esiste; il pagamento a un membro spento fallisce (senza danni). Per riceverlo da spenti serve APay, cioè canali virtuali con fiducia nell'LSP: è proprio ciò che lo spike doveva evitare.
- In più **D**: il ripristino da VSS rompe il canale al primo pagamento, quindi la storia "telefono perso" oggi è più debole del nostro lock → backup → unlock su `rln-rest`, che è verificato.

Cosa si può prendere subito, senza cambiare motore: la derivazione offline della chiave del nodo (H) se un giorno vorremo firmare gli eventi con l'identità del nodo; il fatto che `utexo-lsp` sia ospitabile in proprio (se l'LSP lo gestisce l'operatore, Utexo non è un requisito).

**Condizioni per riaprire il gate** (nuovo spike di mezza giornata, stessi script):
1. `wdk-rgb-lightning` ≥ `0.2.0-beta.4` su npm, con pagamenti e aperture che funzionano con la policy **strict**;
2. chiusura unilaterale di un canale RGB accettata da Bitcoin Core, con sweep dei DUSD;
3. ripristino da VSS seguito da almeno un pagamento riuscito sullo stesso canale;
4. in `utexo-lsp`, un'opzione per aprire canali standard **privati** (o un client che annunci i canali).

## Proposta per il registro decisioni (SPEC §20), da approvare dal PM

> Non scritta in SPEC. Testo proposto per una nuova riga:

| Data | Decisione | Perché |
|---|---|---|
| 20/10 | **Gate 3: resta il motore `rln-rest`.** `WdkLspWallet` (nodo `@utexo/wdk-rgb-lightning` sul dispositivo del membro + LSP Utexo al posto di dave come hub) va in roadmap (§18), da rivalutare con lo stesso spike (`docs/spike-wdk-lsp.md`) quando le quattro condizioni lì elencate saranno vere. L'LSP, se adottato, potrà essere ospitato dall'operatore (`utexo-lsp` è open source). | Spike 3 con `wdk-rgb-lightning` `0.2.0-beta.4` (GitHub) e binding `0.2.0-beta.4`: persistenza VLS e sweep dopo chiusura cooperativa corretti, pagamento alice → LSP → bob in DUSD riuscito (6 s, preimage, payee verificati); ma solo con la policy permissiva del firmatore (con quella strict i canali non si aprono), chiusura unilaterale RGB rifiutata da Bitcoin Core (fondi bloccati se l'LSP non collabora), ripristino VSS che rompe il canale al primo pagamento, nessun pagamento asincrono senza canali virtuali fidati. |

## Domande per Utexo (aggiornate)

Non esisteva un elenco scritto: sotto, prima ciò a cui lo spike ha già risposto (da non chiedere), poi le domande aperte, nuove.

**Già risposte dallo spike (non chiedere):**
- Le correzioni (`createWithStorage`, RLN ≥ 0.15) esistono? Sì, `0.2.0-beta.4`: binding su npm, modulo WDK solo su GitHub.
- Lo stato VLS sopravvive al riavvio? Sì (policy permissiva).
- La chiusura cooperativa restituisce i DUSD? Sì, in 13-15 blocchi.
- Il server LSP è pubblico ed eseguibile in proprio? Sì (`UTEXO-Protocol/utexo-lsp`, Go), con il nodo RLN `v0.13`.
- I canali con l'LSP possono essere standard, non virtuali? Sì, se `DEFAULT_VIRTUAL_OPEN_MODE` è vuoto.
- Un client RLN `0.17` interopera con un LSP RLN `0.13` e con asset emessi da rgb-lib `0.3.0-beta.8`? Sì, su regtest.

**Domande aperte:**
1. Quando sarà su npm `@utexo/wdk-rgb-lightning` `0.2.0-beta.4` (o successiva)? Con quale data per la correzione del firmatore **strict** (aperture `signer_pending_funding`, pagamenti in uscita bloccati)?
2. Chiusura forzata di un canale RGB: Bitcoin Core risponde `-26 … Signature must be zero for failed CHECK(MULTI)SIG operation` (è il vostro blocco 4 in `tests/regtest/QUALIFICATION.md`). C'è una data per la correzione? Senza, un membro non può uscire se l'LSP non collabora.
3. Dopo un ripristino da VSS il primo HTLC dà `Failed to validate our commitment` e il canale si chiude. Lo stato del firmatore VLS (`vls-signer/`) fa parte del backup VSS? Qual è il percorso di ripristino supportato?
4. Dopo la chiusura forzata da parte dell'LSP, l'output `to_remote` del membro (con i suoi DUSD) non viene spazzato dopo 151 blocchi. È atteso? Come si recuperano quei DUSD?
5. RLN `v0.17.0-beta.3` dipende da `rgb-consensus-s-bfa`, `rgb-ops-s-bfa`, `rgb-schemas-s-bfa`, non pubblici. Pubblicherete il codice o un'immagine del daemon per chi vuole ospitare l'LSP con la stessa versione del client? L'immagine `ghcr.io/utexo-protocol/utexo-lsp` diventerà pubblica?
6. In `utexo-lsp`, si può avere un'opzione per aprire canali standard **privati**? Con client VLS i canali `public` non vengono mai annunciati e tolgono i route hint dagli invoice.
7. Il firmatore VLS rifiuta `channel_announcement` di proposito? È previsto che lo firmi?
8. Che versione del nodo e di `utexo-lsp` gira sull'LSP pubblico (signet)? Che garanzie di compatibilità ci sono tra versioni del client e del nodo LSP?
9. Cosa disattiva esattamente `permissiveSignerPolicy`? È accettabile su signet per una demo?
10. Pagamenti asincroni senza canali virtuali: prevedete HTLC trattenuti dall'LSP con canali standard (come gli *async payments* di LDK) o la consegna APay su un canale standard?
11. Con APay l'invoice pagato è intestato all'LSP: come può il pagatore verificare il destinatario finale (attestazione dell'indirizzo, formato della prova)? Per kit+ty è la difesa 1 di SPEC §13.
12. Per l'LSP pubblico: come si ottiene il bearer token (`lspBearerToken` / `APAY_BEARER_TOKEN`)?
13. Dopo un crash, `clearVssFence` è il modo raccomandato per riprendere? Come si distingue in modo sicuro "proprietario morto" da "due dispositivi vivi"?
14. `@utexo/rgb-lib-darwin-arm64` `0.3.0-beta.8` (usato da `wdk-wallet-rgb` 2.0.3) non compila con l'SDK di macOS 27: ci sarà un binario precompilato o una nuova `wdk-wallet-rgb`?

## Spike futuro: APay e canali virtuali

**Perché è stato escluso.** APay (pagamenti asincroni) è il modo di Utexo per ricevere da spenti: il destinatario carica sull'LSP un lotto di payment hash pre-generati, l'LSP emette invoice (HODL) **a proprio nome**, accetta l'HTLC del pagatore e, quando il destinatario torna online, gli chiede un invoice con lo stesso hash, lo paga e incassa l'HTLC in ingresso con la preimage. Secondo la guida LSP/APay del modulo WDK (README di `wdk-rgb-lightning`, sezioni "Manager configuration" e "Async payments (APay)"), contro un LSP di produzione servono `enableVirtualChannelsV0: true` e il node_id dell'LSP in `virtualPeerPubkeys`, cioè canali virtuali `trusted_no_broadcast`: canali che non vengono mai pubblicati on-chain, quindi il saldo del membro dipende dalla collaborazione dell'LSP. È esattamente la fiducia che la decisione "l'LSP non custodisce" esclude. In più l'invoice pagato è dell'LSP: il controllo "invoice intestato al creditore" (SPEC §13, attacco 1) andrebbe sostituito da un'attestazione firmata dal destinatario.

**Cosa andrebbe misurato:**
1. **Recupero del saldo se l'LSP smette di collaborare:** con un canale `trusted_no_broadcast` aperto e saldo a favore del membro, spegnere l'LSP o fargli rifiutare la chiusura. Esiste una transazione che il membro può pubblicare da solo? Quanto recupera, dopo quanti blocchi?
2. **Atomicità lato pagatore:** se il destinatario non torna entro `APAY_*_MIN_FINAL_CLTV_EXPIRY_DELTA` / claim deadline, l'HTLC torna al pagatore senza che lui sia online? L'LSP può incassare senza preimage? (In teoria no, l'hash è del destinatario: va provato.)
3. **Ricezione offline:** bob spento per 1 h, 12 h, 24 h (blocchi simulati); quanti pagamenti in coda, con DUSD e non solo BTC; cosa vede alice nel frattempo.
4. **Verifica del destinatario:** formato dell'attestazione dell'indirizzo e della prova APay, verificabile in TypeScript puro come in `verify.ts`.
5. **Peso sul dispositivo:** memoria, CPU e dimensione dello stato di un nodo WDK con canali virtuali su un telefono reale (Bare/React Native), batteria con l'app in background, tempo di riattivazione quando arriva un pagamento.

**Quando avrebbe senso provarlo:** solo dopo che le quattro condizioni del Gate 3 sono vere (firmatore strict, chiusura unilaterale RGB, ripristino VSS, canali standard privati), e se il caso d'uso lo richiede davvero: oggi in kit+ty il silenzio-assenso dura ore e almeno un membro è online, quindi "riprovare quando bob torna" (G) è sufficiente. APay diventa interessante con un'app mobile vera, dove i telefoni sono spesso spenti.

## Come rieseguire

```sh
cd spikes/wdk-lsp
npm install                                   # Node 22; wdk-wallet-rgb si importa da infra/treasury
docker build -f docker/rln-utexo.Dockerfile -t kitty-spike/rln-utexo:v0.13.0-beta.3 <checkout di UTEXO-Protocol/rgb-lightning-node@af03c7f con submodule>
docker build -f docker/utexo-lsp.Dockerfile -t kitty-spike/utexo-lsp:b865c88 <checkout di UTEXO-Protocol/utexo-lsp@b865c88>
cp .env.lsp.example .env.lsp
docker compose -f docker/compose.yaml up -d && node -e "import('./lib.ts').then(m=>m.mine(150))"
node 01-versions.ts                                       # A
node 02-offline-sign.ts && node 02b-derive-node-key.ts    # H
node 03-persist.ts setup && node 03-persist.ts check      # B strict (si blocca); poi con KITTY_PERMISSIVE=1
export KITTY_PERMISSIVE=1
node 04-issue.ts issue && node 04-issue.ts send alice 20000
node 05-close.ts open && node 05-close.ts coop && node 05-close.ts force   # C
docker compose -f docker/compose.yaml --profile lsp up -d lsp-rln lsp-loopback && node 06-lsp-up.ts   # E (setup)
node 07-lsp.ts channels                                   # F
node 07b-private-liquidity.ts && node 07c-close-public.ts && node 07-lsp.ts pay   # E
docker compose -f docker/compose.yaml --profile lsp start lsp && node 07-lsp.ts bridges
node 08-async.ts invoice && node 08-async.ts pay && node 08-async.ts bobup && node 08-async.ts retry   # G
docker compose -f docker/compose.yaml --profile vss up -d
KITTY_VSS_NODE=dave node 09d-vss-fresh.ts && KITTY_VSS_NODE=dave node 09-vss.ts snap && KITTY_VSS_NODE=dave node 09-vss.ts restore   # D
node 09e-after-close.ts dave 7
node 10-qvac-tools.ts                                     # I
```

## Sorprese e trappole

1. **Policy del firmatore.** `permissiveSignerPolicy` è `false` di default; con `false` niente aperture né pagamenti in uscita. Gli script la attivano solo con `KITTY_PERMISSIVE=1`.
2. **Canali `public` mai annunciati.** Il firmatore VLS logga `Signer rejected channel_announcement signing`; un canale `public` non annunciato fa scrivere a LDK `Not including channels in invoice route hints on account of public channel …` e nessuno può più pagare quel membro. Con client WDK, tutti i canali devono essere privati.
3. **Il cron di `utexo-lsp`** apre un canale verso ogni peer connesso che non ne ha uno per l'asset: con client WDK va fermato o preceduto da un canale privato.
4. **`mine` troppo presto:** le tx di apertura arrivano in mempool qualche secondo dopo `openChannel`; minare subito lascia il canale non confermato.
5. **Trasferimenti blinded verso un nodo REST:** il mittente (`wdk-wallet-rgb`) deve rifare `refreshWallet` *dopo* l'ACK del ricevente, altrimenti la tx non parte e il resto resta bloccato (`InsufficientAssignments` al trasferimento successivo).
6. **Fence VSS dopo un crash:** `VSS store_id is owned by another rgb-lightning-node instance`; `clearVssFence` prima dello sblocco lo risolve.
7. **Durante la chiusura cooperativa** il saldo del canale sparisce dalla vista per 13-15 blocchi prima di riapparire on-chain: la UI dovrebbe dirlo.
8. **`rgb-lib` per macOS** non compila più con l'SDK di macOS 27 (Command Line Tools aggiornati): `infra/treasury` funziona solo perché il binario era già compilato.
9. La versione `v0.17` del nodo, quella del client, non si può compilare senza accesso ai repository privati `*-s-bfa` di Utexo.
