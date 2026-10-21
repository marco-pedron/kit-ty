# Migrazione a WDK + UTEXO (nodo sul telefono, LSP, relay): analisi e piano

> Data: martedì 20/10/2026. Solo analisi e piano: nessun file di codice è stato toccato.
> Convenzioni: **[V]** = verificato su una fonte (link, file del repo, chiamata HTTP fatta oggi o spike già eseguito); **[I]** = ipotesi o deduzione nostra, da verificare.
> Questo documento non modifica `docs/SPEC.md`: le decisioni proposte vanno approvate dal PM e scritte nel registro (§20).

## 0. Sintesi

1. Oggi kit+ty **non ha un'app mobile**: c'è una web app React/Vite, un processo Node (agent) con i quattro agenti e la AI QVAC, un relay di eventi e quattro nodi `rgb-lightning-node` in Docker su regtest. [V]
2. Nel nostro prodotto l'"LSP" dello schema c'è già: è **il nodo di Dave (l'operatore)**, hub di tutti i canali. Sostituire l'LSP UTEXO con un nostro nodo non è un ripiego, è il modello attuale. [V]
3. Un nodo RGB Lightning **dentro un'app** esiste (`@utexo/wdk-rgb-lightning` su Bare, iOS/Android), ma è una beta: Utexo l'ha qualificato su simulatore iOS e su emulatore Android, in build di debug e su regtest, **non su telefoni fisici**. Restano aperti il firmatore *strict*, la chiusura unilaterale RGB e il ripristino dei canali da backup. [V]
4. Lo schema "solo l'LSP vede la blockchain" **non regge**: il nodo sul telefono ha bisogno anche di un indexer (Electrum/Esplora) e di un proxy RGB. Non serve però un nodo Bitcoin completo. [V]
5. Il "relay" dello schema corrisponde con buona probabilità al **proxy di trasporto RGB** (`rgb-proxy-server`), che è open source e che ospitiamo già. Il nostro relay di eventi è un'altra cosa, e serve comunque. [V su cosa fa il proxy; I su cosa intendeva lo schema]
6. L'LSP UTEXO pubblico su signet è attivo e risponde senza autenticazione, ma accetta **un solo asset, LNUSDT (schema IFA)**, e non il nostro DUSD (NIA). Per una demo con DUSD l'LSP va ospitato da noi. [V]
7. Novità di oggi: `@utexo/wdk-rgb-lightning` **`0.2.0-beta.5` è su npm** (10:44 UTC), dopo lo spike 3. Va rifatto lo spike 3 con questa versione prima di decidere qualsiasi migrazione. [V]
8. **Raccomandazione:** prima una demo minima interamente self-hosted, con i nodi dei membri su motore `wdk` dentro processi Node che fanno la parte del telefono, Dave come hub/LSP (REST) e VSS locale. Poi l'app mobile (Expo + Bare) su simulatore. L'LSP UTEXO reale viene per ultimo, e solo con LNUSDT o con un accordo su DUSD.

---

## 1. Architettura attuale

### 1.1 Componenti e runtime [V]

```
 apps/web  React 19 + Vite + Tailwind 4, nel browser (?as=alice|bob|charlie|dave), polling 1 s
     │ HTTP
     ▼
 apps/agent  Fastify :4100 su Node 22, UN processo con 4 istanze MemberAgent
   ├─ ai/      QVAC @qvac/sdk ~0.21.0 in-process (OCR, Qwen3, Whisper)
   ├─ wallet/  RlnWallet: client REST verso il nodo del membro (packages/rln-client, openapi-fetch)
   ├─ rail/    LightningRail (ln-2ch) | OnchainRail
   ├─ flows/   spesa, loop dell'agente, azioni di Dave, backup
   └─ relay/   RelayClient (HTTP + SSE)
     │                                   │ REST (127.0.0.1:3001-3004)
     ▼                                   ▼
 apps/relay  Fastify :4000            infra/docker-compose.yml (regtest, porte su 127.0.0.1)
   SQLite append-only, firme,           bitcoind 30.2, electrs 0.11.0, esplora (:3010),
   catena di hash, SSE, blob backup     rgb-proxy-server 0.3.0 (:3000),
                                        4× rgb-lightning-node d4762ac (RGB-Tools)
 infra/treasury  progetto npm separato, Node 22.23.3: wdk-wallet-rgb 2.0.3 (tesoreria di Dave:
                 emissione DUSD e on-ramp), seed, demo:reset, lose-phone
```

- **Nessun runtime mobile**: niente React Native, Expo, Podfile o Gradle nel repository (`find` su `apps/`, `packages/`, `infra/`). Il "telefono" è una finestra del browser a larghezza mobile.
- **I quattro agenti stanno in un solo processo**, ognuno con il solo client del proprio nodo (SPEC §14, "Onestà sulla demo").

### 1.2 Chiavi e seed [V]
| Cosa | Dove | Chi lo scrive |
|---|---|---|
| Mnemonica e password di ogni nodo RLN | `infra/.secrets/nodes.json` (gitignored) | seed (`infra/treasury/seed.ts`) |
| Chiave ed25519 dell'app (autore degli eventi) | derivata dalla mnemonica (`deriveAppSecretHex`, `apps/agent/src/wallet/rln-wallet.ts`) | agent, a ogni avvio |
| Chiavi Lightning e on-chain del nodo | dentro il volume Docker `rln-<membro>` | RLN |
| Seed della tesoreria di Dave | gestito da `infra/treasury` (gitignored) | seed |

Il legame tra la chiave dell'app e il nodo passa da un invoice `kitty-bind:<sha256(appPubkey)>` (SPEC §9.1), perché `/signmessage` di RLN `d4762ac` firma la stringa vuota.

### 1.3 Pagamenti e trasferimenti oggi [V]
- **Lightning (`ln-2ch`)**: per ogni viaggiatore un canale di viaggio (viaggiatore → Dave, 50.00 DUSD) e un canale di liquidità (Dave → viaggiatore, 30.00), entrambi **pubblici**, da 1.000.000 sat. Il pagamento passa per `/lninvoice` → `/sendpayment` → `/getpayment` (preimage) e transita da Dave in circa 3,4 s (`docs/spike-lightning.md`).
- **On-chain RGB**: `/rgbinvoice` + `/sendrgb` attraverso il proxy RGB locale (`apps/agent/src/rail/onchain-rail.ts`).
- **Emissione e on-ramp**: `wdk-wallet-rgb` emette DUSD (NIA, precisione 2) e lo invia all'invoice RGB dei nodi RLN.
- **Esclusione**: chiusura cooperativa di Dave, poi sweep dei DUSD on-chain.

### 1.4 Servizi esterni [V]
Nessuno. Tutto gira su localhost: bitcoind, electrs, esplora, proxy RGB, nodi, relay, modelli QVAC in cache. È la condizione "funziona con il Wi-Fi spento" di SPEC §11.

### 1.5 Stato persistente [V]
- Nodi: volumi Docker; backup **lock → backup → unlock** (file cifrato di circa 100-440 KB) caricato su `PUT /backups/:pubkey` del relay (B6). Dave non fa backup automatici.
- Agenti: log locale degli eventi (`apps/agent/src/flows/local-log.ts`) e copia completa del registro.
- Relay: SQLite append-only.
- UI: nessuno stato proprio; legge `GET /api/:as/state`.

### 1.6 Dipendenze rilevanti [V]
| Pacchetto | Versione | Dove |
|---|---|---|
| Node | `>=22.17 <23` (treasury: `22.23.3` esatta) | root, `infra/treasury` |
| `rgb-lightning-node` | commit `d4762ac` (RGB-Tools), immagine `settleup/rln:d4762ac` | infra |
| `rgb-proxy-server` | `0.3.0` (`ghcr.io/rgb-tools/rgb-proxy-server`) | infra |
| bitcoind / electrs | `30.2` / `0.11.0` (hashbeam) | infra |
| `@utexo/wdk-wallet-rgb` | `2.0.3` (→ `@utexo/rgb-sdk` 1.0.3 → `@utexo/rgb-lib` 0.3.0-beta.8, `@tetherto/wdk-wallet` 1.0.0-beta.24) | `infra/treasury` |
| `@utexo/rgb-lib-darwin-arm64` | `0.3.0-beta.8` (non compila più con l'SDK di macOS 27, spike 3) | `infra/treasury` |
| `@qvac/sdk` | `~0.21.0` | `apps/agent` |
| `fastify` / `zod` / `@noble/curves` / `@noble/hashes` | `^5.12.7` / `^4.6.7` / `^2.4.0` / `^2.0.1` | apps, packages |
| `react` / `vite` / `tailwindcss` | `^19.3.0` / `^8.3.4` / `^4.3.3` | `apps/web` |
| Solo negli spike | `@utexo/wdk-rgb-lightning` `0.1.0-beta.15` (spike 2) e `0.2.0-beta.4` da GitHub (spike 3); `@utexo/rgb-lightning-node-nodejs` `0.1.0-beta.11` / `0.2.0-beta.4` | `spikes/wdk`, `spikes/wdk-lsp` |

### 1.7 Cosa è già compatibile con il target e cosa no
| Pezzo | Compatibile? | Perché |
|---|---|---|
| `packages/ledger`, `packages/shared` | ✅ [I alto] | TypeScript puro, `@noble/*` in JS puro, nessuna dipendenza Node: dovrebbero girare anche in un worklet Bare o in Hermes. Da provare. |
| Interfaccia `Wallet` (`apps/agent/src/wallet/types.ts`) | ✅ [V] | Ha già `engine: 'wdk' \| 'rln-rest'` e nasconde il motore a flussi e UI; config `KITTY_WALLET_ENGINE` già presente. Solo `backupNow()` restituisce un `blob`, che con VSS non esiste. |
| Interfaccia `Rail` e `KITTY_RAIL_MODE` (`ln-2ch`/`ln-lsp`/`onchain`) | ✅ [V] | La modalità `ln-lsp` è già prevista in SPEC §10.4. |
| Dave come hub | ✅ [V] | È il ruolo dell'LSP. `utexo-lsp` è ospitabile in proprio (spike 3). |
| Relay di eventi firmati | ✅ [V] | Indipendente dal motore; va solo esposto su Internet invece che su localhost. |
| QVAC | ✅ [V docs] / ⚠️ [I] | QVAC dichiara Android e iOS via Expo. Non l'abbiamo provato, e non sappiamo come conviva con il worklet Bare di WDK nella stessa app. |
| Firma eventi ed25519 + invoice di legame | ✅ [V] | Funziona con qualsiasi motore; il motore `wdk` offre anche la firma nativa del nodo e BIP-322 (beta.5). |
| UI web React | ❌ [V] | Va riscritta in React Native (Tailwind web e lucide-react non passano così come sono). La logica in `apps/web/src/*.ts` (lines, history, errors…) è riusabile. |
| Agent come server Fastify con 4 membri in un processo | ❌ [V] | Sul telefono l'agente di un solo membro diventa codice nell'app o nel worklet. Le rotte `/api/:as/...` restano solo per Dave. |
| Nodi RLN in Docker via REST, `rln-client` | ❌ per i membri, ✅ per Dave [V] | Sul telefono si usa il binding in-process (`rgb-lightning-node-bare`), non REST. Dave può restare REST. |
| Canali pubblici (`ln-2ch` attuale) | ❌ con client WDK [V] | Il firmatore VLS non firma `channel_announcement` e un canale pubblico non annunciato toglie i route hint dagli invoice (spike 2 e 3): con WDK tutti i canali devono essere **privati**. |
| Backup lock → backup → unlock | ❌ [V] | Con WDK si usa VSS (`vssBackup`), ma il ripristino con canali aperti oggi non funziona (§3). |
| Rete solo localhost, porte su 127.0.0.1 | ❌ [V] | I telefoni devono raggiungere indexer, proxy, hub e relay: servono endpoint su LAN o pubblici, e TLS fuori da regtest. |

---

## 2. Ricerca sugli strumenti

Versioni lette oggi dal registro npm (`registry.npmjs.org`) e dall'API di GitHub, salvo dove indicato.

### 2.1 Schede

| Strumento | Versione corrente [V] | Licenza [V] | Maturità | Piattaforme | Servizi esterni | Fonti |
|---|---|---|---|---|---|---|
| `@tetherto/wdk` (core) | `1.0.0-beta.20` (15/10) | Apache-2.0 | beta | Node, Bare | nessuno di suo | [npm](https://www.npmjs.com/package/@tetherto/wdk), [GitHub](https://github.com/tetherto/wdk), [docs](https://docs.wdk.tether.io/) |
| `@tetherto/wdk-wallet` (base dei moduli) | `1.0.0-beta.24` (`wdk-rgb-lightning` ne fissa `1.0.0-beta.14`) | Apache-2.0 | beta | Node, Bare | — | npm |
| `@utexo/wdk-wallet-rgb` (on-chain RGB) | `2.0.3` su npm (28/01/2026); il `main` su GitHub è più avanti (rete `utexo`, `rgb-lib-bare`) | Apache-2.0 | stabile di nome, ma su rgb-lib beta | npm 2.0.3: Node con binario `rgb-lib` nativo (node-gyp, Node 22); README `main`: wrapper di `@utexo/rgb-lib-bare` | indexer + proxy RGB | [GitHub](https://github.com/UTEXO-Protocol/wdk-wallet-rgb), `docs/vendor/wdk-wallet-rgb.md` |
| `@utexo/wdk-rgb-lightning` (nodo LN) | **`0.2.0-beta.5`** (oggi, 10:44 UTC; `0.2.0-beta.4` non è mai uscito su npm) | Apache-2.0 | **pre-1.0 beta**, "does not make a production-readiness claim" | Node (peer `rgb-lightning-node-nodejs`) e Bare `>=1.33` (peer `rgb-lightning-node-bare`) | indexer **o** bitcoind RPC, proxy RGB; facoltativi LSP e VSS | [GitHub](https://github.com/UTEXO-Protocol/wdk-rgb-lightning), [WDK docs](https://docs.wdk.tether.io/sdk/community-modules/wdk-rgb-lightning/), [Utexo docs](https://docs.utexo.com/sdk/wdk-rgb-lightning.md); CHANGELOG e `PRODUCTION-GATES.md` del tarball |
| `@utexo/rgb-lightning-node-bare` | `latest` `0.1.0-beta.20`, `beta` `0.2.0-beta.5` (RLN `v0.17.0-beta.3` `ecc69f2`) | Apache-2.0 | candidate "not approved for production rollout" | darwin-arm64, ios-arm64, ios-arm64-simulator, ios-x64-simulator, android-arm64, android-arm, android-x64 | idem | [GitHub](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare) |
| `@utexo/rgb-lightning-node-nodejs` | `latest` `0.1.0-beta.16`, `beta` `0.2.0-beta.5` | Apache-2.0 | beta | 5 target Node (macOS arm64/x64, Linux arm64/x64 GNU/musl) | idem | [GitHub](https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs) |
| `@utexo/rgb-sdk` | dist-tag `latest` = `1.0.0-beta.8`, ultima pubblicata `1.0.6` | MIT | **repo archiviato il 28/07/2026**: per Node Utexo indica `wdk-rgb-lightning` | Node | indexer + proxy (default iriswallet) | [Utexo docs, quickstart](https://docs.utexo.com/getting-started/quickstart/overview.md) |
| `@utexo/rgb-sdk-rn` (SDK React Native, alternativa a WDK) | `latest` `1.0.0-beta.39` | MIT su npm (Apache-2.0 su GitHub) | beta; richiede la New Architecture | iOS (xcframework), Android (Maven, minSdk 24) | rete `utexo` di default: indexer, proxy, LSP `lsp-signet.utexo.com` | [GitHub](https://github.com/UTEXO-Protocol/rgb-sdk-rn), [docs](https://docs.utexo.com/sdk/react-native-sdk.md) |
| `@utexo/rgb-lib-bare` | `0.3.0-beta.18` | non dichiarata su npm (MIT su GitHub) | beta | Bare | — | [GitHub](https://github.com/UTEXO-Protocol/rgb-lib-bare) |
| `@utexo/rgb-lib-wasm` | `latest` `1.0.0-beta.3` | non dichiarata (MIT su GitHub) | beta | browser (WASM) | — | [GitHub](https://github.com/UTEXO-Protocol/rgb-lib-wasm) |
| Bare (Holepunch) | `bare` `1.35.1`; `react-native-bare-kit` `0.16.0` (Utexo chiede **`0.15.5`** su Android) | Apache-2.0 | stabile | iOS, Android, desktop | — | [bare-kit](https://github.com/holepunchto/bare-kit), [RN bare-kit](https://github.com/holepunchto/react-native-bare-kit), [sospensione](https://docs.pears.com/how-to/run-on-native/handle-app-suspension/) |
| `rgb-lightning-node` (RGB-Tools) | in uso `d4762ac`; repo attivo (push 05/10) | MIT | beta | Linux/macOS, Docker | bitcoind, indexer, proxy | [GitHub](https://github.com/RGB-Tools/rgb-lightning-node) |
| `rgb-lightning-node` (fork UTEXO) | `v0.17.0-beta.3` nei binding; **non si compila** senza tre repository privati `*-s-bfa` (spike 3) | MIT | beta | — | — | [GitHub](https://github.com/UTEXO-Protocol/rgb-lightning-node) |
| `rgb-proxy-server` | in uso `0.3.0`; repo attivo (push oggi) | MIT | stabile | Docker (`ghcr.io/rgb-tools/rgb-proxy-server`) | nessuno | [GitHub](https://github.com/RGB-Tools/rgb-proxy-server) |
| `utexo-lsp` (server LSP) | `main` `b865c88` (spike 3); ultimo push 14/09 | **nessuna licenza dichiarata** su GitHub | non dichiarata; immagine GHCR non pubblica (`unauthorized`) | Go + nodo RLN `v0.13.0-beta.3` | nodo RLN, DB | [GitHub](https://github.com/UTEXO-Protocol/utexo-lsp), `docs/spike-wdk-lsp.md` |
| `vss-server` | `lightningdevkit/vss-server` `e4c8359` + Postgres 16 (spike 2 e 3) | MIT/Apache | stabile (LDK) | Docker | Postgres | `spikes/wdk/vss/`, [Utexo fork](https://github.com/UTEXO-Protocol/vss-server) |
| Demo Expo di Utexo (`utexo-rgb-wdk-demo`, oggi `utexo-rgb-wdk-sandbox`) | ultimo push 12/06/2026 | nessuna dichiarata | demo minima | iOS simulatore, Android emulatore | stack regtest locale | [GitHub](https://github.com/UTEXO-Protocol/utexo-rgb-wdk-sandbox) |

### 2.2 Rete "utexo" (signet di UTEXO) [V]
- Secondo il README di `wdk-wallet-rgb` (`main`), `network: 'utexo'` è un signet con il marchio UTEXO: rgb-lib lo tratta come Signet e i default sono `rpcs://rgb-proxy-utexo.utexo.com/json-rpc` (proxy) e `https://esplora-api.utexo.com` (indexer).
- **La `2.0.3` su npm non ha la rete `utexo`**: nessuna occorrenza nel pacchetto installato in `infra/treasury`, e la `Network` di `rgb-sdk` 1.0.3 è `mainnet|testnet|testnet4|signet|regtest`. Nemmeno `wdk-rgb-lightning` ha `utexo`: su signet gli endpoint vanno passati a mano.
- Endpoint provati oggi:

  | Endpoint | Esito |
  |---|---|
  | `https://esplora-api.utexo.com/blocks/tip/height` | HTTP 200, altezza 725732 |
  | `rgb-proxy-utexo.utexo.com` | 301 → `https://rgb-proxy.utexo.com/json-rpc`; `server.info` → `protocol_version 0.2`, `version 0.1.0` |
  | `https://vss-server.utexo.com/vss` | HTTP 400 a una GET vuota (servizio attivo) |
  | `https://lsp-signet.utexo.com/get_info` e `/health` | HTTP 200, senza token (dettagli in §2.4) |
  | `proxy.iriswallet.com/0.2/json-rpc` (default di `rgb-sdk`) | proxy `0.3.0` attivo |
- Faucet: bot Telegram `@Utexo_RLN_bot` ([docs RN SDK](https://docs.utexo.com/sdk/react-native-sdk.md)).

### 2.3 La demo Android ↔ iOS di WDK [V parziale]
- Il blog di RGB Protocol, il 28/08/2026, riporta un video dell'account WDK con **due wallet WDK nuovi, uno Android e uno iOS, su una rete di test**: prima un pagamento Lightning in BTC da Android a iOS, poi un trasferimento RGB ([rgb.info](https://rgb.info/rgb-lightning-tether-wdk/), [post su X](https://x.com/WDK_tether/status/2092975566811246809)). Il post non dice quale rete, se ci fosse un LSP o se l'RGB passasse su Lightning.
- La demo con codice pubblico è `utexo-rgb-wdk-sandbox` (Expo, `pear-wrk-wdk` + `wdk-worklet-bundler`, reti `bitcoin`, `rgb`, `rgb-lightning`). Gira su simulatore iOS ed emulatore Android contro un regtest locale; **non mostra** backup e ripristino, persistenza della cronologia né gestione degli errori (sezione "What this demo does NOT show").
- [I] Un resoconto di terze parti di un altro hackathon diceva che su Android il nodo in Bare non era affidabile; il registro di Utexo segna Android come "Pending" per i flussi RGB di invio (`PRODUCTION-GATES.md`, "Android remaining runtime flows").

### 2.4 LSP UTEXO [V]
- Il server è `UTEXO-Protocol/utexo-lsp` (Go) e lo spike 3 l'ha fatto girare in proprio. Funzioni: `onchain_send`, `lightning_receive` e `lightning_send` (ponti on-chain ↔ LN e HODL), Lightning Address/LNURL, APay. **Non è un hub di pagamenti tra membri**: quelli passano dal suo nodo RLN come da un nodo qualsiasi. Un cron apre da solo un canale verso ogni peer connesso.
- Autenticazione: `GET /get_info`, `/health` e LNURL sono pubblici. `APAY_BEARER_TOKEN` protegge `POST /internal/async_order/new`; `lspBearerToken` serve solo per APay ("required for APay", docs RN SDK). Non risulta pubblicato come ottenere il token. Le docs Utexo parlano di API key soltanto per Swap e Utexo Cloud ([llms.txt](https://docs.utexo.com/llms.txt)).
- Istanza pubblica su signet, `get_info` letto oggi:
  - `supported_assets`: un solo asset, `LNUSDT`, schema **IFA**, precisione 6 (`rgb:vDU5IB7L-…`);
  - canale fisso da **75.000 sat** con **100 LNUSDT** (`min = max_channel_asset_amount = 100000000`) e `initial_client_balance` 12.000.000 msat;
  - pagamenti da 3.000.000 a 7.500.000 msat;
  - pubkey `02a621de…366a@lsp-signet.utexo.com:9735`.
- Ambiente di test: è questo signet. Nessuna documentazione su SLA, limiti d'uso o termini per terzi.
- `@utexo/rgb-sdk-rn` con `createLsp()` attiva di default i **canali virtuali** (`enableVirtualChannelsV0` + pubkey dell'LSP fidata), cioè `trusted_no_broadcast`: il saldo dipende dalla collaborazione dell'LSP.

### 2.5 Risposte alle domande specifiche

**1. Un nodo RGB Lightning gira davvero dentro un'app mobile? Con quali limiti?**
- **Sì, tecnicamente** [V]: `rgb-lightning-node-bare` collega staticamente RLN in un worklet Bare (iOS e Android); WDK lo carica con `require('@utexo/wdk-rgb-lightning')` dentro il worklet. Utexo ha qualificato P01 (persistenza del firmatore) su **simulatore iOS 27, build di debug, regtest**: avvio a freddo, cinque reload di Metro, background breve (5 s) e lungo (40 s) con riapertura. I telefoni fisici sono esplicitamente esclusi ("Physical devices remain excluded by request, not counted as a pass", Q04), come la build release (Q01). Su Android manca la qualificazione dell'invio RGB.
- **Background** [V Holepunch]: quando l'app va in background `react-native-bare-kit` sospende il worklet, e l'OS uccide un'app che tiene socket o timer aperti, "usually within a few seconds". Il nodo quindi **non riceve pagamenti a app chiusa**. Lo spike 3 (G) mostra che il pagamento verso un membro spento fallisce in 5 s, senza perdite. La ricezione da spenti esiste solo con APay, che richiede canali virtuali fidati (§2.4).
- **Batteria**: nessuna misura pubblicata. [I] Il peso maggiore dovrebbe venire dalla sincronizzazione con l'indexer all'avvio e dalla riconnessione ai peer, non dall'idle (il worklet è sospeso).
- **Persistenza** [V]: vanno conservati sia `dataDir` (LDK + rgb-lib) sia `dataDir/vls-signer` (stato del firmatore VLS). "The mnemonic alone is not channel recovery" (README).
- **Backup** [V]: VSS c'è (cifrato lato client, chiave derivata dalla mnemonica `m/535'/1'`) ed è attivo di default in beta.5, ma **"VSS does not replicate the mnemonic, separate VLS signer database or application journals"** (CHANGELOG beta.5). È la causa coerente del guasto dello spike 3 (D): dopo il ripristino il primo pagamento rompe il canale. Utexo stesso: "seed-only or VSS-only recovery is not complete open-channel recovery". Su un telefono perso, quindi, oggi l'unica via sicura per i fondi nei canali è la **chiusura cooperativa da parte dell'hub**.
- **Altri blocchi** [V]: "Strict outgoing signing and same-process reopen remain blockers" (README di `rgb-lightning-node-bare` beta.5); S01: "strict outbound settlement, mature BTC force-close sweep, RGB commitment acceptance and channel recovery are not qualified". Le chiamate native sono sincrone e bloccano l'event loop da 10 a 400 ms (spike 2).

**2. Serve un indexer oltre all'LSP? "Solo l'LSP vede la blockchain" è realistico?**
- **No, non è realistico con questi moduli** [V]. Lo sblocco vuole "exactly one chain backend: `indexer_url`, or all four `bitcoind_rpc_*` fields" più `proxy_endpoint` (docs `wdk-rgb-lightning`); sul telefono si usa `ldk_chain_sync: { mode: 'TransactionSync', config: { indexer_url } }`. Lo dice anche la guida RN: "Network access is required for indexer, RGB transport, and Lightning operations".
- Motivi: RGB è validazione lato client (il telefono deve vedere le transazioni che ancorano i suoi asset), e LDK deve sorvegliare la chain per la sicurezza dei canali.
- Cosa si può fare: niente nodo Bitcoin completo sul telefono, solo un indexer leggero (Electrum o Esplora) **anche gestito da altri** (UTEXO, o l'operatore). [I] L'indexer vede quali indirizzi e UTXO interroga il telefono: è un problema di privacy, non di custodia.

**3. Il "relay" è il proxy di trasporto RGB? Possiamo ospitarlo noi?**
- Il proxy RGB (`rgb-proxy-server`) trasporta le consignment: il pagatore carica il file, il ricevente lo scarica, lo valida e risponde ACK/NACK; solo dopo l'ACK il pagatore trasmette la transazione. "Does not need to be trusted… Anyone can deploy" (README). **Sì, lo ospitiamo già** (`0.3.0` in `infra/docker-compose.yml`). UTEXO ne gestisce uno (`rgb-proxy.utexo.com`). [V]
- [I] Che lo schema intendesse proprio questo è un'ipotesi plausibile, perché i telefoni lo usano per ogni trasferimento on-chain RGB (on-ramp, rail on-chain, sweep). Nel nostro sistema c'è però anche **il relay di eventi kit+ty** (registro firmato, SSE, backup cifrati), che resta necessario e che nello schema non compare. Nel target vanno quindi disegnati **due** servizi online distinti, entrambi senza fiducia e ospitabili da noi.
- [I] I pagamenti RGB su Lightning tra nodi già con canale non passano dal proxy (le informazioni RGB dell'HTLC viaggiano nel canale); il proxy serve però per l'apertura dei canali con asset e per ogni trasferimento on-chain. Da confermare con Utexo.

**4. Si può sostituire l'LSP UTEXO con un nostro rgb-lightning-node come hub?**
- **Sì**, ed è quello che facciamo già (Dave) [V]. Con client WDK cambiano tre cose [V, spike 2 e 3]:
  1. canali **privati** (il VLS non annuncia i canali);
  2. l'hub deve inoltrare verso canali privati: con un hub RLN REST si imposta `accept_forwards_to_priv_channels` nella sua configurazione. In modalità SDK non si può, perché il `config.toml` non viene letto e serve `enableVirtualChannelsV0`, che rifiuta i canali in ingresso. **L'hub deve quindi restare un RLN daemon (REST)**, come Dave oggi;
  3. lo spike 3 ha verificato canali privati aperti dall'hub via REST più il canale del membro verso l'hub, e pagamento instradato alice → hub → bob in 6,2 s, ma **solo con firmatore permissivo**.
- Ospitare `utexo-lsp` vero (con LNURL, ponti, APay) è possibile ma serve poco a kit+ty: il suo cron va fermato con client WDK, gira solo con RLN `v0.13` (la `v0.17` del client richiede repo privati) e il repo non ha licenza. [V]
- Rete: regtest (tutto nostro, come oggi) oppure signet (indexer e proxy UTEXO o nostri, hub nostro). Su signet servono BTC dal faucet e la nostra emissione di DUSD.

**5. I due moduli (on-chain e Lightning) condividono stato e asset?**
- **No** [V, README beta.5]: "The two are independent: each owns its own `rgb-lib` SQLite state… they do **not** share asset records". Identità diverse dalla stessa mnemonica (il nodo LN usa un'entropia BIP-32 a 32 byte per il VLS, il modulo on-chain il BIP-32 standard); `dataDir` separate. Spostare DUSD dall'uno all'altro è un **trasferimento RGB on-chain** (proxy, una transazione, conferme).
- Impatto sulla UX: due saldi ("sul wallet" e "nel canale"), un'attesa di conferma per passare dall'uno all'altro e due insiemi di UTXO da gestire.
- **Ma per i viaggiatori il modulo on-chain non serve** [V]: il nodo LN fa anche RGB on-chain (`createRgbInvoice`, `sendRgbAsset` con `recipient_groups`, `refreshTransfers`; spike 3). L'unica cosa che non fa è **emettere** asset ("Released RLN rejects issuance and inflation in external-signer mode"). Proposta: sul telefono **solo `wdk-rgb-lightning`**, con un solo saldo e due "tasche" (on-chain e canale) nello stesso nodo; `wdk-wallet-rgb` resta solo nella tesoreria di Dave per l'emissione. [I sulla UX, V sulle capacità]

---

## 3. Matrice di fattibilità

Legenda: ✅ fattibile al 100% con open source / self-hosted · ⚠️ fattibile con rischi o limiti · 🔒 dipende da infrastruttura UTEXO · ❌ non fattibile oggi.

| # | Componente o funzione del target | Classe | Dettaglio | Alternativa self-hosted per la demo |
|---|---|---|---|---|
| 1 | Nodo RGB LN del membro in un processo Node (il "telefono simulato") | ⚠️ | `wdk-rgb-lightning` `0.2.0-beta.5` + binding Node: funziona su regtest con firmatore **permissivo** (spike 3, versione beta.4); con quello strict i pagamenti in uscita restano `Pending`. Beta.5 da riprovare. | — (è già self-hosted) |
| 2 | Nodo RGB LN **sul telefono** (Bare, iOS e Android) | ⚠️ | Simulatore iOS su regtest qualificato da Utexo; Android parziale; telefoni fisici e build release non qualificati; app sospesa in background. | Simulatore ed emulatore con il nostro regtest via LAN |
| 3 | Firmatore VLS strict (quello di produzione) | ❌ | Bloccante dichiarato da Utexo (README bare, S01). | Policy permissiva, ammessa su regtest/signet (`permissiveSignerPolicy`), da dichiarare |
| 4 | Canali standard (non virtuali) telefono ↔ hub con DUSD | ✅ | Privati; aperti dall'hub via REST e dal membro (spike 3, F). | Hub RLN nostro |
| 5 | Pagamento telefono → hub → telefono in DUSD, con preimage e `payee_pubkey` | ⚠️ | 6,2 s, verificato con permissivo (spike 3, E). | Hub nostro |
| 6 | Topologia `ln-2ch` (canale di viaggio + liquidità) con client WDK | ⚠️ | Mai provata esattamente con canali privati in entrambi i versi: spike 3 ha un canale del membro + uno dell'LSP, quindi è [I alto]. In alternativa `ln-lsp` (SPEC §10.4). | Hub nostro |
| 7 | Chiusura cooperativa con sweep dei DUSD (esclusione) | ✅ | Spike 3 (C): 13-15 blocchi, 36 s; il saldo "sparisce" durante lo sweep. | — |
| 8 | Chiusura unilaterale di un canale RGB (uscita senza l'hub) | ❌ | Bitcoin Core rifiuta il commitment (spike 3; S01). "Dave non può rubare, ma può tenere in ostaggio". | Nessuna; va detto nel pitch |
| 9 | Backup VSS del nodo | ✅ | `vssBackup` in 59-103 ms; `vss-server` ospitabile (Docker + Postgres). | `lightningdevkit/vss-server` locale |
| 10 | Ripristino su telefono nuovo con canali aperti | ❌ | VSS non include il DB del firmatore VLS; il canale si rompe al primo pagamento (spike 3, D). | Chiusura cooperativa da parte dell'hub + ripristino solo on-chain [I] |
| 11 | Ricezione a telefono spento (APay) | 🔒 / ⚠️ | Richiede canali virtuali `trusted_no_broadcast` (fiducia nell'LSP) e bearer token APay. | `utexo-lsp` nostro con `APAY_BEARER_TOKEN` nostro, ma resta la fiducia; fuori dalla demo |
| 12 | LSP UTEXO pubblico (signet) | 🔒 | Attivo e senza token per `get_info`, ma solo LNUSDT (IFA), canale fisso 75k sat / 100 LNUSDT; nessun accordo d'uso pubblicato. | Hub nostro (Dave) o `utexo-lsp` nostro |
| 13 | `utexo-lsp` ospitato da noi | ⚠️ | Funziona con RLN `v0.13`; immagine da costruire; cron da fermare; repo senza licenza. | — |
| 14 | Indexer (Electrum/Esplora) | ✅ / 🔒 | Nostro: electrs + esplora (già in infra). UTEXO: `esplora-api.utexo.com` (attivo). | electrs/esplora nostri |
| 15 | Proxy di trasporto RGB ("relay" dello schema) | ✅ / 🔒 | Nostro: `rgb-proxy-server` 0.3.0. UTEXO: `rgb-proxy.utexo.com` (attivo). | Il nostro |
| 16 | Relay di eventi kit+ty | ✅ | Già nostro; serve TLS ed esposizione pubblica (o tunnel). | Il nostro |
| 17 | Emissione DUSD (NIA) e on-ramp | ⚠️ | `wdk-wallet-rgb` 2.0.3 su Node 22; il binario rgb-lib non si ricompila più con l'SDK di macOS 27 (va tenuto quello già compilato o va costruito altrove). DUSD → nodo WDK provato (spike 3). | Tesoreria nostra |
| 18 | `wdk-wallet-rgb` sul telefono | ⚠️ | Il README `main` parla di `rgb-lib-bare`, ma la 2.0.3 su npm è del 28/01; le docs WDK elencano dipendenze native solo Linux/macOS [V da ricerca, da confermare]. Probabilmente non serve (§2.5.5). | Non usarlo sul telefono |
| 19 | Firma degli eventi sul telefono | ✅ | ed25519 dalla seed, offline (spike 3, H); oppure firma del nodo o BIP-322 (beta.5). | — |
| 20 | QVAC sul telefono | ⚠️ | Supporto Expo dichiarato [V docs]; non provato da noi; convivenza con il worklet WDK e memoria del Qwen3 1.7B su telefono [I]. | QVAC su un telefono di prova |
| 21 | Rete `utexo` nei moduli che usiamo | ⚠️ | Assente in `wdk-wallet-rgb` 2.0.3 e in `wdk-rgb-lightning`; si usa `signet` con endpoint espliciti. | — |
| 22 | Lightning su mainnet | ❌ | `LIGHTNING_DISABLED_ON_MAINNET` (beta.5). Per noi non conta: solo regtest (CLAUDE.md, regola 9). | — |

---

## 4. Piano di migrazione

Principio: ogni fase lascia una demo funzionante e la attuale (`rln-rest`) resta disponibile con `KITTY_WALLET_ENGINE=rln-rest` finché la nuova non è verde su `e2e:demo`. Nessuna fase tocca le regole del ledger.

### Fase 0: riaprire il gate con `0.2.0-beta.5` (S, mezza giornata) — stream B
- **Cosa:** rieseguire gli script di `spikes/wdk-lsp/` con `@utexo/wdk-rgb-lightning@0.2.0-beta.5` e `@utexo/rgb-lightning-node-nodejs@0.2.0-beta.5` (versioni esatte), sulle quattro condizioni di `docs/spike-wdk-lsp.md` ("Condizioni per riaprire il gate"): firmatore strict, chiusura unilaterale RGB, ripristino VSS seguito da un pagamento, canali privati. In più: `ln-2ch` con due canali privati per coppia (riga 6 della matrice).
- **File:** solo `spikes/wdk-lsp/` (package.json, script), risultati in `docs/spike-wdk-lsp.md` o in un nuovo `docs/spike-wdk-beta5.md`.
- **Dipendenze nuove:** le due beta.5, solo nello spike.
- **Rischi:** dal CHANGELOG, beta.5 non risolve strict e chiusura forzata (S01 aperto) [V]; ci si aspetta lo stesso esito su 3 delle 4 condizioni.
- **Fatto quando:** tabella esiti con log, e proposta di riga per SPEC §20.

### Fase 1: demo minima self-hosted, "telefoni" in processi Node (L, 2-3 giorni) — stream B + A
Obiettivo: i membri usano il nodo WDK in-process (lo stesso codice che girerà sul telefono), Dave resta l'hub RLN REST, tutto su regtest locale.
- **Topologia:** alice, bob e charlie con il motore `wdk` (firmatore permissivo, dichiarato in UI e nel README); dave invariato (RLN REST `d4762ac` o un RLN più recente con `accept_forwards_to_priv_channels`), canali **privati**, modalità `ln-2ch` se la Fase 0 la conferma, altrimenti `ln-lsp`.
- **Un processo per membro** (non quattro nel processo dell'agent): le chiamate native sincrone bloccano l'event loop (spike 2) ed è già la forma "un telefono = un nodo".
- **File da creare o modificare:**
  - `apps/agent/src/wallet/wdk-wallet.ts` (nuovo): implementazione di `Wallet` sul motore `wdk` (`createInvoice`, `decodeInvoice` (che non restituisce `description`: spike 2, trappola 10), `pay` con polling `getPayment(hash, 'Outbound')`, `balances`, `backupNow` → `vssBackup`).
  - `apps/agent/src/wallet/types.ts`: `backupNow()` con `blob` facoltativo (con VSS non c'è un file). File di B, non di `packages/shared`.
  - `apps/agent/src/flows/real-setup.ts`, `apps/agent/src/config.ts`: scelta del motore per membro (es. `KITTY_WALLET_ENGINE_<MEMBRO>`), percorso `dataDir`, URL VSS.
  - `apps/agent/src/index.ts` (stream A): avvio di un solo membro per processo (`KITTY_ACTOR`), con il relay come unico punto di contatto.
  - `infra/docker-compose.yml`: servizi `vss-server` + `postgres` (Dockerfile già in `spikes/wdk/vss/`); configurazione di Dave per l'inoltro verso canali privati.
  - `infra/treasury/seed.ts`, `infra/treasury/nodes.ts`: on-ramp verso l'invoice RGB dei nodi WDK (già provato nello spike 3, con il `refreshWallet` dopo l'ACK), canali privati aperti da Dave e dai membri, UTXO colorati ≥ capacità (spike 2, trappola 5).
  - `infra/scripts/demo-reset.sh`, `lose-phone.sh`: cancellazione delle `dataDir` WDK; `lose-phone` diventa "chiusura cooperativa e ripristino on-chain" finché il ripristino VSS dei canali non funziona.
  - `apps/agent/src/e2e/*`: `e2e:demo` con il motore misto.
- **Dipendenze nuove:** `@utexo/wdk-rgb-lightning@0.2.0-beta.5`, `@utexo/rgb-lightning-node-nodejs@0.2.0-beta.5` in `apps/agent` (oggi CLAUDE.md dice "non usati in demo": serve il via libera del PM e la riga in SPEC §20). Restano Node 22 e la tesoreria separata.
- **Servizi:** VSS locale; nient'altro di nuovo.
- **Rischi:** firmatore solo permissivo; esclusione senza uscita unilaterale; `lose-phone` più debole di oggi; route hint persi se un canale pubblico resta aperto per errore; due motori da mantenere.
- **Fatto quando:** `pnpm demo:reset && pnpm e2e:demo` verde 3 volte su 3 con alice, bob e charlie su `wdk`; SPEC §16 passi 1-7 identici dalla UI; ogni nodo WDK ha un backup VSS dopo ogni pagamento.

### Fase 2: separare l'agente del membro dal server (M, 1-2 giorni) — stream A + C
Obiettivo: il codice di un membro (flussi, ledger, AI, wallet) diventa una libreria che si può caricare in un'app, senza Fastify.
- **File:** `apps/agent/src/flows/member-agent.ts` e `runtime.ts` (un solo membro per istanza, nessun accesso al processo); un nuovo pacchetto `packages/member-core` (o simile) con flussi + ledger + `RelayClient`, senza import di `node:*`; le rotte `apps/agent/src/routes` restano solo per Dave e per la UI web.
- **Rischi:** dipendenze nascoste da Node (`node:fs` nei segreti e nel log locale, `node:crypto`); vanno astratte dietro interfacce (storage, segreti).
- **Fatto quando:** lo stesso `e2e:demo` passa con i tre viaggiatori caricati dalla libreria, e un test controlla che `member-core` non importi moduli `node:*`.

### Fase 3: app mobile su simulatore ed emulatore, ancora tutto self-hosted (L, 4-6 giorni) — stream C + B
- **Struttura:** `apps/mobile` (nuovo) con Expo e New Architecture, `react-native-bare-kit` (`0.15.5` su Android, come chiede Utexo), un worklet Bare con `wdk-rgb-lightning` + `rgb-lightning-node-bare@0.2.0-beta.5` e hook Gradle di staging per Android; seed nel keychain; `dataDir` e `vls-signer` nella cartella documenti; `member-core` nel worklet o nel JS di RN [decisione]; UI portata da `apps/web` (stesse schermate, componenti RN); QVAC via Expo.
- **Rete:** regtest sul portatile raggiungibile dal simulatore (`localhost`) e dall'emulatore (`10.0.2.2`); relay, proxy, esplora ed electrs non più solo su `127.0.0.1` ma sulla LAN della demo (attenzione a SPEC §13 #13: le porte REST dei nodi di Dave restano su localhost).
- **Ciclo di vita:** alla sospensione `vssBackup()` + chiusura delle connessioni; al ritorno sblocco, sincronizzazione e ripresa dei pagamenti in coda. Ricevere a app chiusa non è possibile: il silenzio-assenso e le scadenze devono tenerne conto (SPEC §15), e la UI di chi paga deve dire "bob è offline, riprovo".
- **Dipendenze nuove:** `expo`, `react-native`, `react-native-bare-kit`, `@utexo/wdk-rgb-lightning`, `@utexo/rgb-lightning-node-bare` (+ i tre pacchetti dati iOS/Android), `@qvac/sdk`. Tutte in PR dedicata (PLAN §5.5).
- **Rischi:** pacchetti nativi da 140 MB circa per iOS; memoria per QVAC + nodo sul telefono [I]; due worklet nella stessa app [I]; Android RGB send non qualificato; build release non qualificata.
- **Fatto quando:** due simulatori/emulatori (Android e iOS) + Dave server fanno i passi 2-7 della demo; un riavvio a freddo dell'app non perde canali né saldo.

### Fase 4: signet (M, 1-2 giorni) — stream B
- **Opzione A (consigliata):** signet con hub, relay ed emissione DUSD nostri; indexer e proxy UTEXO (`esplora-api.utexo.com`, `rgb-proxy.utexo.com`) o nostri. Porta la demo fuori dal portatile senza dipendere dall'LSP UTEXO.
- **File:** config di rete in `apps/agent/src/config.ts`, `apps/mobile`, `infra/treasury` (signet, faucet), script per gli endpoint; niente mining automatico (i blocchi di signet arrivano circa ogni 10 minuti): l'esclusione e lo sweep (13-15 blocchi) diventano lunghi ore, quindi su signet la demo dell'esclusione **non si fa dal vivo**.
- **Rischi:** CLAUDE.md regola 9 dice "solo regtest": serve una decisione esplicita del PM; tempi di conferma; disponibilità di servizi di terzi.
- **Fatto quando:** un pagamento tra due telefoni attraverso l'hub su signet, con prova verificabile.

### Fase 5: agganciarsi all'infrastruttura UTEXO (M-L, dipende dalle risposte) — PM + B
- **Prerequisiti:** risposte di Utexo (§5.2), in particolare su asset diversi da LNUSDT, token APay e qualificazione su telefono fisico.
- **Due strade:**
  1. **L'operatore ospita `utexo-lsp`** (consigliata per il nostro modello): Dave = LSP, con il codice di Utexo per Lightning Address, ponti e APay. Mantiene garanzia ed esclusione (Dave controlla i canali).
  2. **LSP UTEXO pubblico:** l'asset diventa LNUSDT (IFA, precisione 6, quindi va cambiato `packages/ledger/src/asset.ts` e la precisione dei centesimi), i canali li apre il cron di Utexo, e **Dave non controlla più i canali**: l'esclusione diventa solo un blocco nel ledger e la garanzia si paga dal nodo di Dave come peer qualsiasi. Cambia il modello di prodotto (SPEC §4, §6.7): va deciso.
- **Fatto quando:** un pagamento tra due telefoni attraverso l'LSP scelto, con `payee_pubkey` verificato (con APay l'invoice è dell'LSP: serve l'attestazione del destinatario, SPEC §13 #1).

### Stime complessive
| Fase | Complessità | Stream |
|---|---|---|
| 0 | S | B |
| 1 | L | B (wallet, infra), A (index, flussi) |
| 2 | M | A, C |
| 3 | L | C (app, UI), B (worklet, nodo) |
| 4 | M | B |
| 5 | M-L | PM, B |

---

## 5. Decisioni e domande aperte

### 5.1 Decisioni che spettano a noi (PM)
1. **Si riapre il gate** (Fase 0) e, se va, si accetta il **firmatore permissivo** in demo, dichiarato come limite? Senza, il motore `wdk` non paga.
2. **Versioni:** via libera a `@utexo/wdk-rgb-lightning` e ai binding `0.2.0-beta.5` (oggi CLAUDE.md li dà "non usati in demo") e riga nuova in SPEC §20.
3. **Topologia:** `ln-2ch` con canali privati (se la Fase 0 la conferma) o `ln-lsp` con finestra di custodia alla prenotazione (SPEC §10.4).
4. **Chi è l'LSP:** l'operatore con hub proprio (RLN REST o `utexo-lsp` ospitato) oppure Utexo. Dalla risposta dipendono asset, garanzia ed esclusione.
5. **"Telefono perso":** con WDK oggi il ripristino dei canali non funziona. Accettiamo che la storia diventi "Dave chiude in modo cooperativo e i fondi tornano on-chain"?
6. **Ricezione da spenti:** restiamo su "riprova quando torna online" (nessuna fiducia) o accettiamo APay con canali virtuali fidati?
7. **Uscita da regtest** per la Fase 4 (CLAUDE.md, regola 9).
8. **Un modulo o due sul telefono:** proposta di solo `wdk-rgb-lightning` (§2.5.5).
9. **Dove gira `member-core` nell'app:** nel worklet Bare (vicino al nodo) o nel JS di React Native (vicino alla UI e a QVAC).

### 5.2 Domande al team UTEXO
Sono già scritte e numerate in `docs/spike-wdk-lsp.md` ("Domande aperte", 1-14). Le aggiorno alla luce di beta.5 e aggiungo quelle nuove.
1. Beta.5: il firmatore **strict** risolve le aperture `signer_pending_funding` e i pagamenti in uscita `Pending`? Se no, quando? (era la 1)
2. Chiusura forzata RGB rifiutata da Bitcoin Core (`-26 … CHECK(MULTI)SIG`, S01): data della correzione? (era la 2)
3. Ripristino: il CHANGELOG beta.5 dice che VSS non replica il DB del firmatore VLS. Qual è il percorso supportato per **un telefono nuovo con canali aperti**? Prevedete di includere `vls-signer` in VSS? (era la 3)
4. **Asset diversi da LNUSDT** sull'LSP pubblico di signet: si può aggiungere un nostro asset NIA (DUSD) a `supported_assets`, o un canale aperto da noi con DUSD verso il vostro nodo viene rifiutato? [nuova]
5. Come si ottiene `lspBearerToken` / `APAY_BEARER_TOKEN`, e ci sono termini d'uso, limiti o SLA per un uso dimostrativo di `lsp-signet.utexo.com`, `esplora-api.utexo.com`, `rgb-proxy.utexo.com` e `vss-server.utexo.com`? (era la 12, ampliata)
6. **Telefoni fisici:** avete risultati su iPhone e Android reali? Quali limiti di memoria, batteria e background avete misurato? Come si comporta il nodo quando iOS sospende il worklet a metà di un HTLC? [nuova]
7. Android: quando sarà qualificato l'invio RGB ("Android remaining runtime flows: Pending")? `react-native-bare-kit` `0.16` è supportato o bisogna restare su `0.15.5`? [nuova]
8. `wdk-wallet-rgb`: è prevista una release npm dopo la 2.0.3 con la rete `utexo` e `rgb-lib-bare` (iOS/Android)? E un binario rgb-lib che compili con l'SDK di macOS 27? (era la 14, ampliata)
9. La rete `utexo` arriverà anche in `wdk-rgb-lightning`, o su signet vanno sempre passati indexer e proxy a mano? [nuova]
10. I pagamenti RGB su Lightning tra due nodi con canale passano dal proxy RGB, o il proxy serve solo per aperture e trasferimenti on-chain? [nuova, serve a dimensionare il "relay"]
11. `utexo-lsp`: che licenza ha? Si può usare e modificare per un LSP gestito dall'operatore? Opzione per canali standard **privati**? Immagine Docker pubblica? (erano la 5 e la 6, più la licenza)
12. Codice di RLN `v0.17.0-beta.3`: i repository `*-s-bfa` diventeranno pubblici, per poter ospitare un hub con la stessa versione del client? (era la 5)
13. Con APay l'invoice pagato è intestato all'LSP: come verifica il pagatore il destinatario finale ("address-attested APay" di beta.5: formato della prova, verificabile in TypeScript puro)? (era la 11)
14. Il VLS rifiuterà sempre `channel_announcement`, quindi con client WDK i canali saranno sempre privati? (era la 7)

### 5.3 Cosa resta da verificare noi (ipotesi segnate [I] sopra)
- `ln-2ch` con due canali privati per coppia e hub RLN REST con `accept_forwards_to_priv_channels`.
- `packages/ledger` e `packages/shared` dentro un worklet Bare e in Hermes.
- QVAC e il worklet WDK nella stessa app Expo, con il Qwen3 1.7B in memoria.
- Come si comporta un HTLC in volo quando il telefono del creditore va in background.

---

## Fonti
- Repository: `docs/SPEC.md`, `docs/PLAN.md`, `docs/spike-lightning.md`, `docs/spike-wdk.md`, `docs/spike-wdk-lsp.md`, `docs/status/b.md`, `docs/vendor/wdk-rgb-lightning.md`, `docs/vendor/wdk-wallet-rgb.md`, `infra/docker-compose.yml`, `apps/agent/src/wallet/types.ts`, `apps/agent/src/rail/types.ts`, i `package.json`; `node_modules` di `spikes/wdk-lsp` e `infra/treasury`.
- Tarball npm di `@utexo/wdk-rgb-lightning@0.2.0-beta.5` (CHANGELOG, README, `PRODUCTION-GATES.md`), scaricato oggi.
- npm registry: https://registry.npmjs.org (dist-tag e date lette il 20/10/2026).
- UTEXO: https://github.com/UTEXO-Protocol/wdk-rgb-lightning · https://github.com/UTEXO-Protocol/rgb-lightning-node-bare · https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs · https://github.com/UTEXO-Protocol/wdk-wallet-rgb · https://github.com/UTEXO-Protocol/utexo-lsp · https://github.com/UTEXO-Protocol/utexo-rgb-wdk-sandbox · https://github.com/UTEXO-Protocol/rgb-sdk-rn · https://github.com/UTEXO-Protocol/rgb-lightning-node
- Docs UTEXO: https://docs.utexo.com/llms.txt · https://docs.utexo.com/sdk/wdk-rgb-lightning.md · https://docs.utexo.com/sdk/react-native-sdk.md · https://docs.utexo.com/getting-started/quickstart/overview.md · https://docs.utexo.com/getting-started/quickstart/react-native.md · https://docs.utexo.com/overview.md
- Docs WDK: https://docs.wdk.tether.io/ · https://docs.wdk.tether.io/sdk/community-modules/wdk-rgb-lightning/
- RGB-Tools: https://github.com/RGB-Tools/rgb-proxy-server · https://github.com/RGB-Tools/rgb-lightning-node
- Holepunch: https://github.com/holepunchto/bare-kit · https://github.com/holepunchto/react-native-bare-kit · https://docs.pears.com/how-to/run-on-native/handle-app-suspension/
- Annunci: https://rgb.info/rgb-lightning-tether-wdk/ · https://rgb.info/wdk-rgb-lightning-architecture/ · https://x.com/WDK_tether/status/2092975566811246809
- Endpoint provati oggi con richieste di sola lettura: `lsp-signet.utexo.com` (`/get_info`, `/health`), `esplora-api.utexo.com`, `rgb-proxy.utexo.com`, `vss-server.utexo.com`, `proxy.iriswallet.com`.
