# CLAUDE.md: istruzioni per Claude Code (caricato a ogni sessione)

Progetto **kit+ty**: cassa distribuita per viaggi di gruppo, con canali Lightning RGB, AI locale QVAC e agenti che pagano entro limiti fissati dall'utente. Hackathon *Agentic Dollars on Bitcoin*, Torino, 17-18 ottobre 2026. Submit domenica alle 13:00.

## Fonti di verità
- Prodotto, regole, eventi, sicurezza, architettura: @docs/SPEC.md
- Task, priorità, proprietà delle cartelle, calendario: @docs/PLAN.md
- Esito degli spike: `docs/spike-lightning.md` (RLN via REST) e `docs/spike-wdk.md` (moduli WDK). Il motore scelto è nel registro decisioni di SPEC §20. Leggili prima di scrivere codice che parla con un nodo.
- Riferimenti API (leggili prima di scrivere codice di integrazione, mai a memoria):
  - Nodi Lightning, rgb-lightning-node REST (motore `rln-rest`, scelto al gate 2): `docs/vendor/rln-openapi.yaml`, tramite il client tipizzato in `packages/rln-client`.
  - Tesoreria WDK di dave (emissione e on-ramp dei DUSD): `docs/vendor/wdk-wallet-rgb.md` (scritto dallo spike 2) e i `.d.ts` del pacchetto. Versione **esatta**: `@utexo/wdk-wallet-rgb` `2.0.3`, su Node 22; se si installa un'altra versione, fermati e avvisa.
  - `@utexo/wdk-rgb-lightning` e `@utexo/rgb-lightning-node-nodejs`: non usati in demo, vedi SPEC §20.
  - QVAC SDK: `docs/vendor/QVAC.md` (linea v0.21). È enorme: cercaci dentro con grep la sezione che serve, non leggerlo tutto. `@qvac/sdk` fissato a `~0.21.0`; se si installa un'altra versione, fermati e avvisa.
- Codice del vecchio progetto: `_legacy/`. Si **copia e adatta**, non si importa mai da lì. La cartella viene cancellata domenica.

## Proprietà delle cartelle
Ogni sessione lavora per uno stream (A, B o C, vedi `docs/PLAN.md` §2) e scrive **solo** nelle cartelle di quello stream. Il resto è in sola lettura. Se ti serve un cambiamento altrove, in particolare in `packages/shared`, descrivilo e fermati.

## Regole che non si violano
1. **Non inventare API.** Endpoint, campi, funzioni QVAC, costanti dei modelli, flag di CLI: solo se compaiono nei riferimenti sopra, nei `.d.ts` in `node_modules` o in `docs/spike-lightning.md`. Se manca, scrivi "mi serve X, non lo trovo, le opzioni sono A/B" e fermati.
2. **Niente transazioni simulate nella demo.** Ogni pagamento, apertura o chiusura di canale mostrato in UI corrisponde a un'operazione RGB reale su regtest. I fake esistono solo dietro `KITTY_FAKES=1`, con banner visibile, e `demo:reset` li rifiuta.
3. **I soldi sono codice deterministico.** Importi in `bigint`, unità minime (centesimi; 1 centesimo = 1 unità DUSD). Mai `number` o float per gli importi. L'LLM propone, il ledger calcola.
4. **Ogni output dell'AI passa da zod**: al massimo 2 tentativi con l'errore passato al modello, poi modulo manuale precompilato.
5. **Le regole stanno nel ledger** (`deriveTrip`, `validateEvent`, `decideAutoPay`), come funzioni pure con test. Relay e agente le chiamano, non le riscrivono.
6. **Ogni evento è firmato** dal suo autore e verificato da chi lo riceve. Nessun componente si fida del relay.
7. **Terminologia RGB corretta:** solo RGB Protocol v0.11.1 (`docs.rgb.info`, `github.com/RGB-Tools`), mai `rgb.tech`, RGB-WG, v0.12 o RGB++. Schema **NIA**, non "RGB20". "Private contract", non "smart contract".
8. **Nomi:** viaggiatori `alice`, `bob`, `charlie`; coordinatore `dave`. Nessun nome di persone o aziende reali nel codice, nella UI o nei dati.
9. **Solo regtest.** Mai mainnet, mai fondi reali. Mai committare `.env`, mnemoniche, password, modelli, volumi Docker, backup.
10. **Lingua:** documentazione in italiano; codice, commenti, commit e testi della UI in inglese.

## Come lavori
- All'inizio della sessione: di' su quale stream e quale task (ID di `PLAN.md`) lavori e qual è il criterio "fatto quando".
- **Prima di scrivere codice, proponi un piano** (file da creare o modificare, documenti letti, rischi) e **aspetta l'approvazione**.
- Branch `<stream>/<ID>-<nome-breve>` (es. `a/A1-derive-trip`). Mai lavorare su `main`, mai `push --force`, mai riscrivere la storia. A fine task Claude Code: git fetch && git merge origin/main, poi typecheck, lint e test verdi, push del branch, PR con titolo [ID] ..., gh pr checks --watch, e se la CI è verde gh pr merge --merge --delete-branch. Se la CI è rossa o ci sono conflitti si ferma e avvisa. Mai push --force, mai push su main. Se un merge viene bloccato dai permessi, lo chiede all'umano.
- Commit piccoli in Conventional Commits (`feat(ledger): derive line states`), dopo ogni passo che funziona.
- Dopo ogni passo: `pnpm typecheck && pnpm lint && pnpm test` e incolla l'esito.
- Se lo stesso errore si ripete 3 volte, fermati e riassumi: cosa hai provato, l'errore esatto, la tua ipotesi.
- Se una regola di `SPEC.md` ti sembra sbagliata, proponi la modifica; non cambiarla da solo.
- **A fine task aggiorna solo il tuo file** `docs/status/<a|b|c>.md`: casella del task, cosa funziona, come si prova, problemi noti, prossimo passo.

## Comandi (esistono dopo la sessione contratto e i task di B)
```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm dev                      # relay + agent + web
pnpm infra:up | infra:down | infra:reset | infra:check
pnpm demo:reset               # catena da zero, seed, canali, viaggio pronto
pnpm e2e:demo                 # la demo senza UI, con asserzioni
pnpm ai:eval                  # scontrini di prova
```
