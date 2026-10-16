# Stato stream B: nodi e soldi

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream B scrive qui.

## Task
- [x] B0 Spike Lightning → docs/spike-lightning.md (ven 10:35, modalità ln-2ch)
- [x] B0b Spike 2: motore WDK → docs/spike-wdk.md (ven 16:35, consigliato `rln-rest` + `wdk-wallet-rgb` per i DUSD di dave; decide il gate 2)
- [ ] B1 Infra (stack + VSS; RLN opzionale)
- [ ] B4 Verifica firme in TS puro, formato del motore scelto (crypto.ts)
- [ ] B2 Seed e demo:reset
- [ ] B3 Wallet reale e LightningRail
- [ ] B7 Chiusura canali per l'esclusione
- [ ] B8 e2e:demo
- [ ] B5 (P1) Rail on-chain
- [ ] B6 Backup automatico (VSS o lock-backup); demo:lose-phone = P1
- [ ] B9 Liquidità just-in-time di Dave (openLiquidity + liquidityPlan)

## Bloccato da
- niente

## Prossimo passo
- Gate 2: il PM sceglie tra le opzioni A/B/C di `docs/spike-wdk.md`. Con A: B1 (infra con RLN) + B4 (ed25519, `crypto.ts`); `verify.ts` dello spike resta pronto se si passa alla firma nativa.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### B0b, ven 16/10 16:35
- Funziona con `wdk` `0.1.0-beta.15`/`0.1.0-beta.11`: 4 nodi in un processo; emissione DUSD con `wdk-wallet-rgb@2.0.3` (solo Node 22) e invio ai nodi LN; pagamento instradato alice → dave → bob in 4,4 s con preimage, **solo** con canali privati aperti da dave (forma `ln-lsp`); firma nativa del nodo verificata in TS puro (`spikes/wdk/verify.ts`); `vssBackup` a nodo acceso.
- Non funziona: annuncio dei canali (il firmatore VLS lo rifiuta), canali in ingresso verso dave quando inoltra a canali privati, riavvio di un nodo con canali, sweep dei DUSD dopo la chiusura cooperativa, ripristino da VSS (lo sblocco si blocca).
- Come si prova: stack `settleup` senza RLN; `cd spikes/wdk && npm ci && fnm exec --using=22.23.3 node 08-full-single.ts` (spostare prima `data/` e `.secrets`); `node verify.ts`; VSS: `docker compose -f spikes/wdk/vss/compose.yaml up -d`, poi `09-vss.ts`.
- Lasciati accesi: container `kitty-vss-*` (porta 127.0.0.1:8081) e lo stack `settleup` senza RLN. Dati delle prove in `spikes/wdk/data-run*` (gitignored). Node 22.23.3 installato con fnm.
