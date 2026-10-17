# Esperimento: canali RLN diretti tra viaggiatori (P2P)

> Branch `experiment/rgb-lightning-node`. `main` non si tocca. Piano da approvare prima di scrivere codice.
> Riferimenti letti: `docs/SPEC.md`, `docs/PLAN.md`, `docs/spike-lightning.md`, `docs/vendor/rln-openapi.yaml` (RLN `d4762ac`), README e `regtest.sh` upstream di `RGB-Tools/rgb-lightning-node` (master), `apps/agent/src/wallet/*`, `apps/agent/src/rail/*`, `infra/docker-compose.yml`, `infra/treasury/seed.ts`.

## 1. Situazione attuale su `main`

**RLN è già il motore in produzione della demo** (gate 2, SPEC §20): l'esperimento non introduce RLN, cambia la **topologia** dei canali.

- **Stack:** monorepo pnpm, TypeScript su Node 22. `apps/relay` (Fastify + SQLite, registro firmato), `apps/agent` (Fastify, un agente per membro: AI QVAC, wallet, rail, flussi), `apps/web` (React + Vite). Logica pura in `packages/ledger`, schemi zod in `packages/shared`.
- **Utenti:** nessun account; quattro membri fissi (`alice`, `bob`, `charlie`, `dave`). Identità = chiave ed25519 dell'app legata al nodo con un invoice `kitty-bind:` (SPEC §9.1).
- **Wallet:** interfaccia `Wallet` (`apps/agent/src/wallet/types.ts`), implementata da `RlnWallet` (`rln-wallet.ts`, ~940 righe) sopra il client tipizzato `@kitty/rln-client` (generato da `rln-openapi.yaml`). Un nodo RLN per membro in Docker (`infra/docker-compose.yml`, progetto `kitty`, porte 3001-3004).
- **Pagamenti:** `LightningRail` (`apps/agent/src/rail/lightning-rail.ts`): il creditore crea un invoice RGB (`/lninvoice`), il debitore paga (`/sendpayment` + polling `/getpayment`). Fallback `OnchainRail` (`/rgbinvoice` + `/sendrgb`).
- **Canali (modello hub, `ln-2ch`):** ogni viaggiatore ha **due** canali con **dave**: canale di viaggio (viaggiatore → dave, D = 50.00) e canale di liquidità (dave → viaggiatore, L = 30.00). Ogni pagamento passa da dave (2 hop). Aperti dal seed (`infra/treasury/seed.ts`). Dave apre liquidità just-in-time (`openLiquidity` + `liquidityPlan`), chiude i canali per l'esclusione (`closeChannelsWith`) e copre le insolvenze pagando lo stesso invoice (`apps/agent/src/flows/dave.ts`).

## 2. Modello dei nodi: hub o P2P

Scelto con te: **P2P, un nodo RLN per utente con canali diretti tra viaggiatori.** Il confronto, che va anche in `docs/rln-experiment.md`:

| | Hub (oggi, dave) | P2P (esperimento) |
|---|---|---|
| Canali per n viaggiatori | 2n (6 per 3) | n(n−1) con due canali per coppia (6 per 3, 20 per 5, 90 per 10); n(n−1)/2 con uno |
| Budget D del viaggiatore | tutto in un canale, spendibile verso chiunque | frammentato su n−1 canali (o instradato attraverso altri viaggiatori) |
| Capitale BTC immobilizzato | dave: n canali; viaggiatore: 1 | ogni viaggiatore: n−1 canali da `capacity_sat` |
| Liquidità in entrata | la fornisce dave (L), pianificata dal ledger | la forniscono gli altri viaggiatori: chi non apre verso di te non ti può pagare |
| Hop per pagamento | 2 (via dave) | 1 se c'è il canale diretto, altrimenti multi-hop tra viaggiatori |
| Privacy (SPEC §13 #18) | dave vede tutti i pagamenti | ognuno vede solo i propri; nessun punto centrale |
| Dipendenza da un nodo | se dave è offline non paga nessuno | nessun punto unico; serve però che il **creditore** sia online |
| Garanzia di dave (§6.7) | dave paga lo stesso invoice con la sua liquidità | dave non ha canali: copre on-chain (`OnchainRail`) o deve tenere anche lui canali (ibrido) |
| Esclusione (§6.7) | dave chiude 2 canali | dave non è parte dei canali: ogni viaggiatore chiude i propri con l'escluso (cooperativa solo se l'escluso è online, altrimenti forzata: non verificata) |
| Nuovo membro a viaggio iniziato | 2 canali | 2(n−1) canali, 6 conferme ciascuno |
| Onestà sul modello | il routing passa dall'operatore | più vicino a "nessuno al centro", ma più costoso |

**Varianti di topologia P2P** (decisione aperta, §7):
- **P2P-2ch (consigliata per l'esperimento):** due canali per coppia, uno per verso, come `ln-2ch` ma tra viaggiatori. Ogni debito tra due persone si paga in 1 hop. È il caso più semplice da confrontare con l'hub.
- **P2P-1ch + routing:** un canale per coppia; il verso "sbagliato" si paga facendo il giro attraverso un terzo viaggiatore. Meno canali, ma dipende dal routing RGB multi-hop tra nodi non hub e dal saldo lungo il percorso.
- **Ibrido:** P2P tra viaggiatori più un canale per viaggiatore con dave solo per garanzia ed esclusione. Fuori dall'esperimento, solo come conclusione.

## 3. Dove si inserisce (e dove no)

**Proposta:** esperimento **isolato** in una cartella nuova, `experiments/rln-p2p/`, che **non modifica** `apps/`, `packages/` né `infra/`. Motivi:
- la demo è domani alle 13:00 e lo stack `kitty` è acceso adesso (8 container): l'esperimento non deve toccarne i volumi né la catena;
- `CLAUDE.md` assegna `apps/agent/src/wallet`, `infra/` e `packages/rln-client` allo stream B, e `packages/shared` e `ledger` allo stream A;
- `Wallet` è già l'astrazione giusta per i pagamenti (crea invoice, paga, decodifica: non dipende dalla topologia). Cambiano il seed, `balances()`, `openLiquidity`, `closeChannelsWith`, la garanzia e `liquidityPlan`, cioè proprio le parti condivise.

Uso **in sola lettura** `@kitty/rln-client` (client tipizzato già generato dalla stessa `rln-openapi.yaml`): niente body indovinati, e il confronto avviene sullo stesso motore e sulla stessa versione. Nessun codice di RLN copiato nel repo: si usa l'immagine Docker già costruita `settleup/rln:d4762ac`.

### Struttura
```
experiments/rln-p2p/
├─ docker-compose.yml   progetto compose `kitty-p2p`: bitcoind, electrs, proxy RGB, 3 nodi RLN
│                       (alice, bob, charlie); porte diverse dallo stack `kitty`, tutte su 127.0.0.1
├─ .env.example         URL dei nodi, porte, network, parametri dei canali; nessun segreto
├─ src/
│  ├─ config.ts         legge e valida l'env (zod); rifiuta network ≠ regtest
│  ├─ rln-node.ts       `RlnNode`: un nodo RLN via REST (init, unlock, address, createutxos,
│  │                    connectpeer, openchannel, listchannels, lninvoice, sendpayment/getpayment,
│  │                    closechannel, issueassetnia, assetbalance, refreshtransfers); errori tipizzati
│  ├─ chain.ts          regtest: invio BTC e mining via bitcoind RPC (come infra/scripts/mine.sh)
│  ├─ p2p-network.ts    `ChannelNetwork`: interfaccia + implementazione P2P (apre canali tra coppie,
│  │                    attende l'usabilità minando, paga, saldi per peer, chiude); il resto dipende da qui
│  ├─ wait.ts           attese con timeout e motivo (blocchi, stato canale, pagamento)
│  └─ e2e.ts            lo scenario end-to-end (§5)
├─ package.json         pacchetto `@kitty/exp-rln-p2p` (dipende da `@kitty/rln-client` e zod)
└─ README.md            rimanda a docs/rln-experiment.md
```

L'interfaccia che separa l'esperimento dalle API dirette:
```ts
interface ChannelNetwork {
  setupNode(name: string): Promise<{ pubkey: string }>          // init (se serve) + unlock
  fund(name: string, btc: string): Promise<void>                 // address + sendtoaddress + mine + createutxos
  issueAsset(name: string, amount: bigint): Promise<string>      // NIA, precisione 2 → assetId
  openChannel(p: { from: string; to: string; assetId: string; assetAmount: bigint; capacitySat: number }): Promise<{ channelId: string }>
  waitUsable(channelIds: string[], opts?: { maxBlocks?: number }): Promise<void>   // mina finché ready && is_usable
  pay(p: { from: string; to: string; cents: bigint; description: string }): Promise<{ paymentHash: string; preimage: string; ms: number }>
  channels(name: string): Promise<ChannelView[]>                 // per peer: asset locale/remoto, sat, stato
  balances(name: string): Promise<{ onchainCents: bigint; outboundCents: bigint; inboundCents: bigint }>
  close(p: { by: string; channelId: string; peer: string }): Promise<{ txid?: string; sweptCents: bigint }>
}
```
Se l'esperimento va bene, il passo successivo (fuori da questo piano) è un `Wallet` P2P per l'app: lì servirà un PR per `packages/shared`/`ledger` (garanzia ed esclusione senza hub), da concordare con gli stream A e B.

## 4. Implementazione (dopo l'approvazione)

Commit piccoli, uno per passo:
1. `chore(exp): rln-p2p package and compose stack`: compose, `.env.example`, package, script `exp:p2p:up|down|reset` **dentro** `experiments/rln-p2p/package.json` (il `package.json` di root non si tocca; aggiungo solo `experiments/*` a `pnpm-workspace.yaml`, chiedo prima se preferisci di no).
2. `feat(exp): RlnNode REST wrapper`: wrapper sottile su `@kitty/rln-client`, con test unitari a fetch iniettato (errori RLN, timeout, nodo non raggiungibile).
3. `feat(exp): regtest chain helpers`: mining e invio BTC via RPC.
4. `feat(exp): P2P channel network`: apertura, attesa, pagamento, saldi, chiusura.
5. `test(exp): e2e alice-bob P2P channel`: lo scenario del §5, eseguito davvero.
6. `docs(exp): rln-experiment.md`: istruzioni, misure, limiti, confronto con `main`.

**Errori e conferme** (tutto da `docs/spike-lightning.md`, nessuna ipotesi nuova):
- canale usabile solo dopo **6 conferme**: `waitUsable` mina un blocco alla volta e interroga `/listchannels` fino a `ready && is_usable`, budget 10 blocchi, poi errore con lo stato visto;
- `/sendpayment` risponde 200 anche quando fallisce (`status: "Failed"`, es. invoice scaduto): controllo la scadenza prima, poi polling `/getpayment` ogni 250 ms, timeout 30 s;
- `amt_msat` = `rgb_htlc_min_msat` letto da `/nodeinfo` (3 000 000 a `d4762ac`); valori minori → `400 InvalidAmount`;
- chiusura cooperativa: 1 blocco per la conferma + ~6 per lo sweep dei DUSD, poi `/refreshtransfers` (budget 12);
- aperture dallo stesso nodo **in sequenza** (il seed ha visto input spesi due volte con aperture ravvicinate);
- errori RLN con nome (`RlnError.rlnName`) propagati con un messaggio d'azione.

**Configurazione (env, con default per regtest):** `P2P_NETWORK=regtest` (unico valore accettato), `P2P_NODE_URLS=alice=http://127.0.0.1:3201,bob=…,charlie=…`, `P2P_BITCOIND_RPC_URL`, `P2P_BITCOIND_RPC_USER`/`PASSWORD` (regtest `user`/`password`, come upstream: non sono segreti, ma restano nell'env), `P2P_INDEXER_URL`, `P2P_PROXY_ENDPOINT`, `P2P_CAPACITY_SAT=1000000`, `P2P_ASSET_AMOUNT=5000`. Password dei nodi generate a runtime e salvate in `experiments/rln-p2p/.secrets/` (gitignored), come fa il seed.

**Porte proposte** (nessuna in conflitto con lo stack `kitty`): bitcoind 18543, electrs 50101, proxy 3100, nodi RLN API 3201-3203, peer LN interni alla rete docker.

## 5. Verifica end-to-end (girerà davvero, con l'output nel resoconto)

`pnpm --filter @kitty/exp-rln-p2p e2e`, partendo da `exp:p2p:reset`:
1. avvia lo stack `kitty-p2p`, init + unlock di alice e bob;
2. finanzia entrambi (BTC + `/createutxos`), alice emette un NIA di prova (`/issueassetnia`, precisione 2) e ne trasferisce una parte a bob on-chain;
3. apre **alice → bob** (DUSD) e **bob → alice**, mina, attende `is_usable`;
4. bob crea un invoice da 3.09, alice paga in 1 hop: controlla `sha256(preimage) == paymentHash`, i saldi del canale prima e dopo (asset e sat) e misura la latenza; poi il verso opposto;
5. chiude in modo cooperativo un canale, mina, `/refreshtransfers`, controlla i DUSD tornati on-chain;
6. **estensione P2P (stessa esecuzione, con charlie):** canale solo bob → charlie e pagamento alice → bob → charlie: verifica se il routing RGB multi-hop tra viaggiatori funziona senza hub (risponde alla variante P2P-1ch).

Le asserzioni falliscono con un messaggio chiaro; `pnpm typecheck && pnpm lint && pnpm test` restano verdi (l'e2e è escluso da `pnpm test`, come gli altri e2e).

## 6. Rischi

- **RAM:** un secondo stack (bitcoind, electrs, proxy, 3 nodi) accanto a quello della demo. Se manca memoria, lo fermo prima di `demo:reset` e lo dico; non condivido bitcoind con lo stack `kitty` per non minare blocchi sulla catena della demo.
- **Proprietà delle cartelle (`CLAUDE.md`):** l'esperimento sta in una cartella nuova non assegnata a nessuno stream; non tocca nient'altro. Branch con nome diverso da `<stream>/<ID>` perché lo chiedi tu.
- **Non verificati a `d4762ac`:** ricezione su canale privato, routing multi-hop tra nodi non hub, chiusura forzata. Il §5.6 ne misura uno; gli altri restano nei limiti noti.
- **Niente fake:** l'esperimento usa solo nodi reali su regtest.

## 7. Decisioni da prendere con te

1. Topologia: **P2P-2ch** (consigliata) o P2P-1ch + routing come caso principale?
2. Posizione: `experiments/rln-p2p/` isolato (consigliato) o direttamente come secondo `Wallet` dentro `apps/agent` (tocca lo stream B e i contratti condivisi)?
3. Va bene aggiungere `experiments/*` a `pnpm-workspace.yaml` (unica modifica fuori dalla cartella), o preferisci un pacchetto autonomo con il suo `package.json` fuori dal workspace?
4. Asset: NIA emesso da RLN nell'esperimento (consigliato, autonomo) o DUSD dalla tesoreria WDK di dave come in `main`?
