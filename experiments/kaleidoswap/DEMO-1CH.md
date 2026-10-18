# Demo in modalità un canale + scambio atomico (`ln-1ch-swap`): stato al freeze

> Branch `experiment/rgb-lightning-node`, domenica 18 ottobre 2026, tentativo a tempo (09:15-11:00). **La demo su `main` (`ln-2ch`, RLN `d4762ac`) resta il piano sicuro.** Nessun push, PR o merge; lo stack `kitty` della demo non è mai stato toccato (container, volumi, immagine, porte).
> Risultati dell'esperimento da cui parte: `RESULTS.md`.

## In breve

- **Funziona end to end, alle 09:40** (in anticipo sui punti di verifica delle 10:00 e delle 10:40): seed `1ch` verde due volte di fila (114 s e 92 s), `e2e:demo` in modalità `1ch` **12/12 verde** con i numeri di SPEC §16, giro della UI reale dei passi 1-7 riuscito.
- **Nome della modalità:** `KITTY_RAIL_MODE=ln-1ch-swap`, con `KITTY_RLN_FLAVOR=kaleido`.
- **DUSD dalla tesoreria WDK come su main**: funziona con il fork al primo colpo, nessun fallback sull'emissione RLN.
- `ln-2ch` resta il default: typecheck, lint e **586 test** verdi (compresi quelli di `ln-2ch` e 6 nuovi per i due flavor). L'`e2e:demo` di `ln-2ch` **non** è stato rilanciato: avrebbe richiesto `demo:reset` sullo stack della demo, che non si tocca.
- Il watcher di dave nell'agente è stato provato dal vivo (claim on-chain di uno scambio lasciato `paid`).

## 1. Come si avvia

Tutto passa da `infra/scripts/env-1ch.sh`, che imposta porte e percorsi diversi da quelli della demo. Si può tenere acceso accanto allo stack `kitty`.

| Cosa | Demo `ln-2ch` (main) | `ln-1ch-swap` (questo branch) |
|---|---|---|
| progetto compose | `kitty` (`infra/docker-compose.yml`) | `kitty-1ch` (`infra/docker-compose.1ch.yml`) |
| immagine RLN | `settleup/rln:d4762ac` | `kitty/rln:kaleido-next` (+ `kitty/htlc-tool:dev`) |
| nodi RLN | 3001-3004, peer 9735-9738 | 33001-33004, peer 39735-39738 |
| bitcoind / electrs / esplora / proxy | 18443 / 50001 / 3010 / 3000 | 38443 / 33501 / 33010 / 33000 |
| relay / agent / web | 4000 / 4100 / 5173 | 4001 / 4101 / 5174 |
| e2e (relay / agent) | 4400 / 4500 | 4401 / 4501 |
| file (segreti, seed state, backup, scambi, relay) | `infra/.secrets`, `infra/.out`, `infra/data/backups` | tutto sotto `infra/data/1ch/` (gitignored) |

Comandi, dalla radice del worktree (`../kit-ty-1ch`):

```sh
# le immagini esistono già sulla macchina; se mancano: experiments/kaleidoswap/run.sh le costruisce
pnpm demo:reset:1ch        # azzera SOLO kitty-1ch e infra/data/1ch, seed con scambi (~2 min)
pnpm e2e:demo:1ch          # la demo senza UI, asserzioni di SPEC §16 (irreversibile: rifare demo:reset:1ch)
pnpm dev:1ch               # relay :4001 + agent :4101 (con il watcher di dave) + web :5174
# UI: http://127.0.0.1:5174/?as=alice  (bob, charlie, dave)
```

Spegnere solo lo stack dell'esperimento:

```sh
docker compose -f infra/docker-compose.1ch.yml down        # -v per cancellare anche i volumi
```

**Tornare alla demo `ln-2ch`:** non c'è niente da tornare indietro. La demo gira dalla cartella principale (`~/Pol/kit-ty`, branch `main`) con i suoi comandi di sempre (`pnpm demo:reset`, `pnpm dev`). Su questo branch, senza `env-1ch.sh`, tutti i default sono quelli di `ln-2ch` (`KITTY_RAIL_MODE=ln-2ch`, `KITTY_RLN_FLAVOR=d4762ac`, stesse porte e percorsi): i test di `ln-2ch` sono verdi.

## 2. Cosa è cambiato (solo su questo branch)

| Parte | Modifica |
|---|---|
| `packages/shared` | `RailModeSchema` + `'ln-1ch-swap'`; `BalanceView.swapIn` opzionale (txid dell'HTLC, preimage). Retrocompatibile: nessun nuovo tipo di evento. |
| `RlnWallet` | `flavor: 'd4762ac' \| 'kaleido'` (default `d4762ac`). Con `kaleido`: `/getpayment` con `payment_type: 'Outbound'`; `Claimable`/`Claiming` = ancora in corso, `Cancelled` = fallito; la prova richiede `payment_type === 'Outbound'`. Il vecchio `if (p.inbound)` (che sul fork sarebbe stato sempre falso, in silenzio) ora richiede `inbound === false` esplicito anche con `d4762ac`. 6 test nuovi per i due flavor. |
| `RlnWallet.balances()` | in `1ch` aggiunge `swapIn`, letto dal record dello scambio del viaggiatore (solo txid, hash, preimage già pubblica; mai la chiave di refund). |
| watcher di dave | `apps/agent/src/wallet/swap-watcher.ts`, avviato da `index.ts` solo con `KITTY_RAIL_MODE=ln-1ch-swap`: ogni 5 s legge da disco gli scambi `paid`, prende P da `/getpayment` (`Outbound`), verifica `sha256(P) = H`, fa il claim on-chain con `htlc-tool`, mina 1 blocco, salva `claimed_onchain`. Avvisa nel log se l'altezza si avvicina a T. |
| esclusione | stessa `closeChannelsWith` (chiude tutti i canali con il membro: qui uno solo). Con il fork lo sweep di LDK parte a tempo (~130 s), quindi `sweepWaitMs` = 180 s per dave; il testo dell'operazione in corso dice "the DUSD sweep back on-chain takes about 2 min", e la UI mostra già il tempo trascorso delle operazioni (C7). |
| seed | `infra/treasury/seed-1ch.ts` (Node 22): DUSD dalla **tesoreria WDK come su main** (funziona con il fork al primo colpo); dave riceve 3 allocazioni separate da 80.00; 3 canali dave → viaggiatore da 1 000 000 sat, `push_msat` 300 000 000, `asset_amount` 8000, **aperti prima** dell'on-ramp dei viaggiatori e della riserva di dave; poi lo scambio per alice, bob, charlie con il codice testato di `src/swap.ts`. Risultato: 50.00 dal lato del viaggiatore, 30.00 da quello di dave. |
| infra | `docker-compose.1ch.yml`, `scripts/env-1ch.sh`, `up-1ch.sh`, `demo-reset-1ch.sh`; variabili retrocompatibili `KITTY_COMPOSE_FILE`, `KITTY_SEED_STATE_FILE`, `KITTY_BACKUP_DIR`, `KITTY_OUT_DIR`, `WEB_PORT` (default = valori di oggi). |
| UI | Home del viaggiatore: un riquadro "50.00 in your channel, entered with an atomic swap" con HTLC txid (link a esplora) e preimage. Nient'altro. |
| e2e | `demo.e2e.ts`: in `1ch` una sola chiusura, timeout più lungo al passo 6, seed state da `KITTY_SEED_STATE_FILE`. |
| seed state | un canale per viaggiatore, registrato sia come `travel` sia come `liquidity` (stesso `channelId`), così `CHANNELS_READY` e il resto non cambiano. |

## 3. Cosa è stato provato

| Prova | Esito | Numeri |
|---|---|---|
| `pnpm typecheck && pnpm lint && pnpm test` | ✅ | 56 file, 586 test (580 di prima + 6 sui flavor) |
| `pnpm demo:reset:1ch` (due volte di fila) | ✅ ✅ | 114 s, 92 s. Per ogni viaggiatore: 1 canale, 50.00 dal suo lato, 30.00 da quello di dave, 50.00 on-chain. dave: 200.00 on-chain (riserva), 3 canali |
| `pnpm e2e:demo:1ch` | ✅ 12/12 | AI sullo scontrino VND 53 s (primo caricamento); quote 3.09 / 3.09 / 3.50; bob pagato in automatico dopo 24 s, **0 blocchi**, prova verificata; contestazione e conferma di dave; scaduta dopo 30 s; "Copri ed escludi" in **77 s, 7 blocchi, 1 chiusura**; charlie 100.00 on-chain; alice 56.59 (3.09 da bob + 3.50 garantiti); backup cifrati dei 3 viaggiatori sul relay (lock → backup → unlock funziona anche sul fork); stessa testa del registro su 4/4 |
| Giro della UI reale (`pnpm dev:1ch`, Chrome via Playwright, finestra 390×844) | ✅ passi 1-7 | 1: Home di alice con "50.00 entered your channel with an atomic swap", HTLC txid e preimage. 2: foto caricata **dalla UI**, AI sul dispositivo, frase, "Split with AI", parti 3.09/3.09/3.50 "Computed by the ledger", "Send to the group" **dalla UI**. 3: bob pagato in automatico ("Paid 3.09 to alice automatically: no objection in 20 s…"). 4-5-6: contestazione, conferma e "Copri ed escludi" chiamati **dall'API dell'agente** (non cliccati), con gli screenshot delle schermate: su dave l'operazione "Closing the channel with charlie…" con il tempo trascorso. 7: alice 56.59, registro uguale e valido su 4/4. Screenshot in `apps/web/.shots/1ch/` (gitignored) |
| Watcher di dave nell'agente, dal vivo | ✅ | scambio di 1.00 per alice lasciato `paid`; `SwapWatcher.tick()` prende P da `/getpayment` (`Outbound`), verifica sha256, claim on-chain al blocco 137 (T = 735), stato `claimed_onchain` su disco; secondo tick: niente da fare |
| Memoria con i due stack e il secondo agente QVAC | ⚠️ | libera tra il 19% e il 50% sul Mac da 8 GB, con lo stack demo e il `pnpm dev` di main accesi. Mai sotto il 15% (c'era un sorvegliante pronto a fermare l'e2e). `dev:1ch` spento a fine prova |

**Non provato:** riavvio dell'agente di dave tra incasso LN e claim (lo stato su disco è lo stesso dell'esperimento, caso 9 di `RESULTS.md`, ma non rifatto con l'agente); scambio fallito e refund dopo T dentro l'app (solo nell'esperimento); `demo:lose-phone` in `1ch`; i passi 4-6 cliccati a mano in UI (solo via API, con screenshot); `e2e:demo` di `ln-2ch` (vedi sopra).

**Dopo queste prove lo stack `kitty-1ch` non è pronto per una demo** (charlie escluso, uno scambio di prova in più): prima di usarlo, `pnpm demo:reset:1ch`.

## 4. Rischi sul palco

1. **Immagine del fork.** `kitty/rln:kaleido-next` è costruita in locale da `kaleidoswap/rgb-lightning-node` `1e4b1c3` (rgb-lib da `branch = master`, rust-lightning da un fork personale). Esiste solo su questa macchina; ricostruirla richiede tempo e rete. Mai sui volumi della demo.
2. **Watcher di dave.** Gira dentro l'agente di dave. Se l'agente è spento quando un viaggiatore incassa lo scambio e resta spento fino a T, dave perde D. Sul palco il rischio è nullo: tutti gli scambi si chiudono nel seed (il watcher del seed li riscuote subito) e T è 600 blocchi dopo. Ma va detto: in produzione è un processo critico, come un watchtower.
3. **Sweep a tempo.** Al passo 6 la chiusura del canale di charlie aspetta lo sweep di LDK, che parte a tempo e non a blocchi: misurato **77 s** (e2e) e circa 90 s (giro UI), contro pochi secondi di `ln-2ch`. La UI mostra l'operazione in corso con il tempo trascorso, ma il testo "…the DUSD sweep back on-chain takes about 2 min" è **troncato** sulla larghezza del telefono: si legge solo "Closing the channel with charlie…" e i secondi. Servono 1-2 minuti di parlato pronti per quel momento. Il saldo on-chain di charlie si aggiorna dopo.
4. **RAM.** Due stack più due agenti con QVAC su 8 GB: si è scesi al 19% libero durante il caricamento dei modelli. Per il palco: **un solo agente acceso**, cioè o la demo `ln-2ch` o `dev:1ch`, mai entrambi.
5. **Il riquadro dello scambio resta visibile** anche dopo l'esclusione di charlie (dice "entered your channel", che resta vero, ma il canale è chiuso). Cosmetico.
6. **Due wallet in più per persona:** accanto a ogni nodo c'è un wallet rgb-lib del fork (`htlc-tool`, in Docker, file in `infra/data/1ch/run/wallets`). Funziona, ma è un pezzo in più da spiegare se la giuria chiede.
7. `/signmessage` resta rotto anche nel fork: nessun impatto (si usa ed25519 come su main).

## 5. Cosa servirebbe per portarlo su main (decisione del PM)

Raccomandazione: **non oggi.** Il freeze è alle 11:00 e la demo `ln-2ch` è già verde; questa modalità cambia l'immagine di tutti i nodi e aggiunge un processo critico. Se il PM vuole comunque mostrarla, il modo meno rischioso è **una slide o un video** del giro `1ch` (gli screenshot ci sono), oppure accenderla solo come seconda demo a domanda, con la demo `ln-2ch` spenta (RAM).

Per portarla su main dopo l'hackathon:
- **SPEC** (PM): §4 e §6.2 un canale per viaggiatore e lo scambio atomico all'onboarding; §10.4 la modalità `ln-1ch-swap`; §13 due righe (watcher di dave offline fino a T → perdita di D; griefing sul lock del viaggiatore → fondi fermi fino a T); §15 T = altezza + 600, `push_msat` 300 000 sat, allocazioni separate di D + L; §20 la decisione.
- **Stream A** (`packages/shared`, `packages/ledger`): eventi firmati dello scambio (`SWAP_OFFERED`, `SWAP_LOCKED`, `SWAP_SETTLED`) e la loro validazione, così l'HTLC txid e la preimage stanno nel registro e non solo nel wallet; `RailModeSchema` e `BalanceView.swapIn` qui sono già retrocompatibili.
- **Stream B**: l'immagine del fork in `infra/` con un tag fissato (e il motivo per cui `rgb-lib` del fork viene da `master`); `htlc-tool` come sidecar o libreria; lo scambio nel wallet (`lockForSwap`, `createHodlInvoice`, `claimHodl`, `refundSwap`; dave `verifySwap`, `claimSwap`) invece che nel seed; il refund del viaggiatore dopo T dentro l'app; il watcher come processo monitorato separato dall'agente; test di integrazione del riavvio.
- **Stream C**: il testo dell'attesa dello sweep non troncato; il riquadro dello scambio nascosto a canale chiuso; i passi 4-6 provati a mano.
- Domande a KaleidoSwap: esporre `claim_deadline_height` in `/getpayment`; poter limitare lo shadow offset del CLTV in `/sendpayment` (accorcerebbe T da ~4 giorni); pubblicare un'immagine con tag stabile.
