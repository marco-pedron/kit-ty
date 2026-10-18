# Demo in modalità un canale + scambio atomico (`ln-1ch-swap`): stato al freeze

> Branch `experiment/rgb-lightning-node`, domenica 18 ottobre 2026, tentativo a tempo (09:15-11:00). **La demo su `main` (`ln-2ch`, RLN `d4762ac`) resta il piano sicuro.** Nessun push, PR o merge; lo stack `kitty` della demo non è mai stato toccato (container, volumi, immagine, porte).
> Risultati dell'esperimento da cui parte: `RESULTS.md`.

## In breve

_(compilato a fine lavoro, vedi §3)_

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

_(compilato a fine lavoro)_

## 4. Rischi sul palco

_(compilato a fine lavoro)_

## 5. Cosa servirebbe per portarlo su main (decisione del PM)

_(compilato a fine lavoro)_
