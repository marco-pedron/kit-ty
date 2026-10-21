# Screenshot dell'app web

Generati il 21/10/2026 da `origin/main` al commit `d4a0e9e` (merge della PR #56).

- Motore WebKit tramite Playwright 1.59.0 (`apps/web/scripts/shots.ts`).
- Viewport 390×844 a 2x (PNG da 780×1688), ogni schermata in tema `light` e `dark`.
- Stack avviato con i fake (`pnpm dev:fakes`) su un relay vuoto: per questo in alto c'è la barra "Fakes on". Wallet e AI sono simulati, nessuna operazione RGB reale.
- 82 PNG: 41 schermate per tema.

## Come rigenerarli

```sh
cd apps/web && npx playwright install webkit && cd ../..
RELAY_DB="$(mktemp -d)/relay.sqlite" pnpm dev:fakes &   # relay vuoto, porte 4000, 4100, 5173
pnpm --filter @kitty/web shots                          # scrive in apps/web/.shots/
```

Serve un relay nuovo a ogni giro: il giro dark finisce con "Cover and exclude", che esclude Charlie. Poi si copiano i PNG da `apps/web/.shots/` in questa cartella.

## Schermate

Ogni nome esiste in due versioni, `<nome>-light.png` e `<nome>-dark.png`.

**alice** (chi paga la cena): home, gruppi e dettaglio del gruppo, nuova spesa, lettura dello scontrino sul dispositivo e revisione con la frase di divisione, toast di +ty, prova di pagamento verificata, QR, profilo, registro, riconnessione al relay.
`alice-home`, `alice-groups`, `alice-group`, `alice-new`, `alice-reading`, `alice-check`, `alice-toast`, `alice-proof`, `alice-qr`, `alice-profile`, `alice-log`, `alice-reconnecting`

**bob** (debitore che lascia pagare l'agente): riga da approvare con conto alla rovescia, home, gruppi, nuova spesa, QR, profilo, registro, agente non raggiungibile.
`bob-card`, `bob-home`, `bob-groups`, `bob-group`, `bob-new`, `bob-qr`, `bob-profile`, `bob-log`, `bob-offline`

**charlie** (debitore che contesta e viene escluso): riga da approvare, foglio di contestazione, home, gruppi, nuova spesa, QR, profilo, registro, schermata finale da escluso con i fondi tornati on-chain.
`charlie-card`, `charlie-dispute`, `charlie-home`, `charlie-groups`, `charlie-group`, `charlie-new`, `charlie-qr`, `charlie-profile`, `charlie-log`, `charlie-out`

**dave** (coordinatore): home con contestazioni, insolvenze e tasso del giorno, membri, registro, profilo, prova, decisione sulla contestazione, flusso "Cover and exclude" (avviso, avanzamento, esito con i txid di chiusura).
`dave-home`, `dave-members`, `dave-log`, `dave-profile`, `dave-proof`, `dave-dispute`, `dave-cover`, `dave-cover-alert`, `dave-cover-progress`, `dave-cover-done`

**styleguide**: componenti e token dell'interfaccia, nella viewport e a pagina intera.
`styleguide`, `styleguide-full`
