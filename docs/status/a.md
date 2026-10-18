# Stato stream A: dominio, AI, cervello dell'agente

> Aggiornato da Claude Code alla fine di ogni task. Solo lo stream A scrive qui.

## Task
- [x] K0 Sessione contratto (con C), branch `k0-contract`
- [x] A1 deriveTrip (branch `a/A1-derive-trip`)
- [x] A2 validateEvent (branch `a/A2-validate-event`)
- [x] A3 decideAutoPay (branch `a/A3-decide-auto-pay`)
- [x] A4 AI con QVAC + ai:eval (sab 17/10 17:20, branch `a/A4-qvac-ai`)
- [x] A5 Flussi dell'agente (fake → reale): ★1 (A5a, A5b), ★3 wallet reale (#19); passi 2-7 verdi sul reale con `pnpm e2e:demo` (B8, sab 17/10 16:55)
- [x] A7 liquidityPlan (SPEC §10.5) (branch `a/A7-liquidity-plan`)
- [x] A6 (P1) Anti-injection e hash dei modelli (sab 17/10 19:40, branch `a/A6-ai-hardening`)
- [x] Robustezza dell'estrazione (dom 18/10 10:30, branch `a/receipt-robustness`)
- [x] Scontrini semplici (dom 18/10 12:00, branch `a/simple-receipts`, PR in bozza)

## Bloccato da
- niente

## Prossimo passo
- Niente di A aperto. **Per il PM, SPEC §10.5 punto 2:** sostituire "per `daRicevere(m) − margine(m) + soglia`" con "per `soglia − margine(m)`" (vedi registro A7) e la nota di B9 sul canale grande almeno quanto la riga più grande.

## API di `MemberAgent` per C3 (`apps/agent/src/flows/member-agent.ts`)
Un'istanza per attore (alice, bob, charlie, dave), costruita da chi costruisce gli agenti (`server.ts`):
```ts
new MemberAgent({
  actor,                 // 'alice' | 'bob' | 'charlie' | 'dave'
  wallet,                // SOLO il wallet di quel membro
  relay,                 // RelayClient (C2)
  verifier,              // KITTY_FAKES=1 → fakeVerifier; altrimenti signatureVerifier (B4)
  now?,                  // orologio iniettato, default new Date()
  tripId?,               // solo per pubblicare prima di TRIP_CREATED (default 'vietnam-2026')
  retryMs?,              // back-off di un pagamento fallito, default 10 s
  checkpointEvery?,      // default 10 eventi
})
```
- **Loop:** il server chiama `agent.tick()` ogni secondo per ogni agente (un tick chiamato mentre il precedente è ancora in corso ritorna subito, lo garantisce l'agente). `tick()` = sync con il relay e validazione locale, `LINE_SEEN`, pagamenti automatici (uno alla volta, in background), `INVOICE_REISSUED` degli invoice scaduti, `CHECKPOINT`. `await agent.idle()` aspetta i pagamenti in volo (test, spegnimento).
- **Lettura per `GET /state`:**
  - `agent.trip()` → `TripState | null` (dalla copia verificata, all'ora corrente): membri, spese, righe, `defaults`, `rate`.
  - `agent.me()` → `MemberState | null` (null per Dave); `agent.policy()`.
  - `await agent.balances()` → `WalletBalances | null` dal nodo del membro (null se il nodo non risponde), per `me.balance`.
  - `agent.decisionFor(line)` → `AutoPayDecision | null`: il campo `LineView.agent` delle righe in cui l'agente è debitore (null per le altre).
  - `agent.activity()` → `ActivityItem[]` con `kind: 'AGENT'` (decisioni e pagamenti dell'agente, il più recente prima, con `proof`); le righe degli eventi del registro le costruisce la rotta dai `trip().expenses/lines`.
  - `agent.operations()` → `OperationView[]` (`paying`, `submitting_expense`, con errore e azione se fallisce).
  - `agent.log.health()` → `LedgerHealth` ("Registro verificato"); `agent.log.divergence` → `{ seq, hash, reason } | null` se il relay ha consegnato un evento che l'agente rifiuta (da quel momento la copia è congelata e `chainValid` è false).
  - `agent.log.invoices` → `Map<bolt11, DecodedInvoice>` decodificati dal proprio nodo (per `invoiceExpiresAt` di `LineView` e il pannello Prova).
- **Azioni (lanciano `FlowError`, `WalletError` o `LedgerError`, tutte con un `code` di `ErrorCode`; `FlowError`/`WalletError` hanno `toApiError()`):**
  - `previewSplit(receipt, assignments)` → `SplitPreview` (sincrono) per `POST /expenses/split`.
  - `submitExpense(receipt, assignments, receiptImageSha256)` → `StoredEvent` di `EXPENSE_SUBMITTED` per `POST /expenses`; l'`expenseId` è generato dall'agente (`body.expenseId`).
  - `decide(expenseId, 'approve' | 'contest', reason?)` → `LineRecord` per `POST /expenses/:id/decision`.
  - `voidExpense(expenseId)` per `POST /expenses/:id/void`.
  - `updatePolicy(policy)` → `Policy` per `PUT /policy`.
  - `joinTrip(policy?)` → `MemberState` (`MEMBER_JOINED` con l'invoice di legame del proprio nodo; non fa nulla se già iscritto).

## Runtime (`apps/agent/src/flows/runtime.ts`, avviato da `index.ts`)
- `index.ts` crea il `RelayClient` di C2 una volta sola (`createRelayClient({ baseUrl: config.RELAY_URL })`) e chiama `startAgents({ fakes, relay, wallets, log })` → `{ agents: Map<ActorId, MemberAgent>, dave: CoordinatorAgent, stop() }`. Un agente per attore, ciascuno con il proprio wallet; `tick()` ogni secondo; un errore viene registrato una volta sola finché non cambia (es. relay spento: `RELAY_UNREACHABLE … ` e poi `back to normal`). Verificatore: `fakeVerifier` con i fake, `signatureVerifier` (B4) senza.
- Senza wallet reale (B3 non c'è ancora) i loop non partono: avviso nel log.
- Con `KITTY_FAKES=1` e il registro vuoto, `seedFakeTrip` prepara il viaggio della demo sulla rete finta (crea, tasso, tre membri ammessi con canali), riprovando finché il relay risponde: `pnpm dev:fakes` ha subito un viaggio. Il seed vero è B2.

## API di `CoordinatorAgent` per C3 e B2 (`apps/agent/src/flows/dave.ts`)
L'agente di Dave: `new CoordinatorAgent({ wallet, relay, verifier, now?, tripId?, … })` (stesse opzioni di `MemberAgent`, senza `actor`: è sempre `dave`). Eredita lettura, `tick()` e `idle()`; nel tick ripubblica anche le `GUARANTEE_PAID` già pagate ma non ancora nel registro (mai ripagate). Ogni azione controlla che l'autore sia il `coordinatorPubkey` del viaggio.
- **Seed (B2), SPEC §6.1-6.2**, in quest'ordine:
  1. `createTrip({ name, assetId, params })` → `TRIP_CREATED` (solo se il registro è vuoto).
  2. `setRate({ asOf, source, rates })` → `RATE_SET` (anche `PUT /dave/rates`).
  3. per ogni viaggiatore: `travelers[id].joinTrip()`, poi `dave.admit(id)` (ricontrolla l'invoice di legame con `checkBindInvoice`), poi, aperti i due canali, `dave.channelsReady(id, { tripChannelId, liquidityChannelId })`.
- **Rotte (C3):**
  - `resolveDispute(expenseId, memberId, outcome, note)` → `LineRecord` per `POST /dave/disputes/:expenseId/:member`; solo su una riga `contested`.
  - `coverAndExclude(expenseId, memberId)` → `{ covered: ProofRef | null, closingTxids }` = `CoverAndExcludeResponse` per `POST /dave/defaults/:expenseId/:member/cover-and-exclude`; solo su una riga `overdue`. Ordine: paga lo stesso invoice con la liquidità di Dave e pubblica `GUARANTEE_PAID` se rientra nella garanzia rimasta (altrimenti `covered: null`, l'invoice si paga intero o niente); chiude i due canali (`closeChannelsWith`) e pubblica `MEMBER_EXCLUDED`; copre fino a G le altre righe del membro, diventate `overdue` con l'esclusione. Invoice scaduto → `FlowError INVOICE_EXPIRED` (il pagatore lo riemette da solo al tick dopo).
  - Insolvenze per la vista: `dave.trip().defaults`; garanzia usata e rimasta: `trip.members.get(pk).guaranteeUsedCents` e `params.guaranteeCapCents`.
- Operazioni per C7: `covering`, `closing_channels` in `dave.operations()`.

## Registro
<!-- Per ogni task finito: data e ora, cosa funziona, come si prova (comandi), problemi noti. Il più recente in alto. -->
### Scontrini semplici, dom 18/10 12:00
- **Set semplice: 26/30** (≤ 1 correzione) in due esecuzioni dopo le correzioni, stessi 4 falliti; latenza media dell'estrazione 16,7 s e 19,2 s, massima 20,8 s e 34,9 s (altro carico sulla macchina). Prima delle correzioni: 14/30. `pnpm ai:eval` (demo) resta verde con 0 correzioni.
- **Il set "hard" (scontrini affollati e fotografati) è stato provato e ha fallito sulle righe di rumore** (codici, contanti e resto, sotto-righe): tolto dalle fixture insieme a `ai:eval:hard`.
- **Set nuovo:** `infra/fixtures/receipts/simple/make-images-simple.py` genera 30 scontrini (EUR 12, USD 8, VND 10, `random.seed(42)`) nello stile del set demo e scrive `expected.json` con importi calcolati e controllati dallo script; divisione e frasi ostili su `eur-pizzeria-02`. `pnpm ai:eval:simple`; `eval.ts` stampa `receipts: X/Y passed, mean … ms, max … ms` e, per uno scontrino fallito, le righe OCR.
- **Correzioni generiche nel codice (`receipt.ts`):** importi con spazi intorno alla virgola ("6 ,00", "47 ,  00"); punto delle migliaia perso in VND ("10  000"); quantità del modello tenuta solo se stampata sulla riga ("Birra media 5,50" non è 5 × 1,10); data letta dalle righe stampate (gg/mm/aaaa, mm/gg/aaaa su USD) invece che dal modello, che copiava il 17/10/2026 dell'esempio nel prompt; la riga della data non è mai un articolo; una riga tasse/mancia/subtotale senza importo ("IVA inclusa") non viene letta come tale. Prompt non toccato. Test in `receipt.test.ts`.
- **I 4 falliti, tutti (b) il modello salta una riga di articolo:** `eur-museum-03`, `usd-grocery-02`, `usd-grocery-04`, `eur-bar-02` (in più (a): l'OCR legge "Tip 0  80" senza virgola → 80,00). L'OCR legge bene le cifre su tutti gli altri. Il controllo dei totali avvisa il pagatore in tutti e 4 i casi.
- **Non provato qui:** `demo:reset` + `e2e:demo` (l'altro dev usa lo stack); li lancia l'umano prima del merge.

### Fix split + contestazioni (branch `fix/receipt-split-and-dispute-payments`), dom 18/10
- **Divisione (bug: "Bob got pho" non metteva il pho a Bob):** il modello 1.7B, a cui si chiedevano le persone di ogni item, abbinava male parti della frase e item e riempiva quelli non citati. Ora risponde con le parti della frase (`parts: [{ said, members, items }]`, item e membri sempre come enum); gli item in nessuna parte restano `unassigned`. `pnpm ai:eval` ha 7 casi nuovi su scontrini scritti (item condivisi, nomi parziali, plurali): 4 falliti prima, 17/17 verdi dopo. Divisione più lenta (3-7 s invece di ~1,7 s): la risposta è più lunga.
- **Contestazioni:** una riga confermata da Dave e approvata dopo la nuova scadenza (`overdue`) non veniva mai pagata; ora `decideAutoPay` e l'agente pagano in ritardo una riga `overdue` approvata esplicitamente (SPEC §7). Test d'integrazione in `apps/agent/src/flows/disputes.test.ts`.
- Come si prova: `pnpm test`; `pnpm ai:eval` con i modelli in cache.

### Robustezza dell'estrazione, dom 18/10 10:30
- **Corpo da 16 MiB solo su `POST /api/:as/expenses/extract`:** hook `onRoute` in `server.ts` (le rotte sono di C, il loro file non è toccato); le altre rotte restano a 1 MiB. Test: ~4 MB accettati sull'estrazione, rifiutati su `POST /api/:as/expenses`.
- **Righe senza prezzo:** una riga data come articolo ma senza importo ("+ Patatine grandi", "Ketchup x2 OMAGGIO") viene scartata con l'avviso `Row "…" has no price: not counted as an item.`; resta un errore solo se nessun articolo ha un prezzo. `rowAmount` ignora misure (`0,5L`, `9PZ`, `500 g`) e conteggi (`x2`). Test in `receipt.test.ts`.
- **Prompt ed esempio: provati e annullati** (commit di revert): con le nuove regole e l'esempio, `usd-supermarket` di `ai:eval` falliva ("row 7 is both the subtotal and the tax"). Senza: `ai:eval` verde, 0 correzioni.
- **Misurato:** `ai:eval` verde; `ai:eval:hard` 0/6 prima e 0/6 dopo, ma ora nessuno scontrino fallisce per "has no amount"; `e2e:demo` 12/12 (log `infra/.out/logs/20261018-101750-e2e-demo.log`).
- **Problemi noti:** l'OCR stampa "26 , 80" (spazio prima della virgola) e `rowAmount` legge "80" → 80,00 (totale di eur-fastfood); `eval.ts` va in crash nella parte ostile se lo scontrino della divisione non è stato estratto.
### A6, sab 17/10 19:40
- **Hash dei modelli (SPEC §13 #19):** prima di caricare, `qvac-engine.ts` calcola lo sha256 dei file in cache (`QVAC_CACHE_DIR`, default `~/.qvac/models`, file `<prefisso>_<modelId>`) di `OCR_LATIN`, `OCR_CRAFT` (il rilevatore) e `QWEN3_1_7B_INST_Q4` e lo confronta con `sha256Checksum` della costante dell'SDK (fissato da `@qvac/sdk` 0.21.0). File alterato o mancante → AI in `error`, modulo manuale; l'agente parte comunque. Costo: ~9 s in più al caricamento (1,15 GB), in background.
- **Anti-injection (SPEC §13 #6):** 5 frasi ostili in `ai:eval` (istruzioni nascoste, membri inventati "mallory"/"eve", articoli 7 e 99, finto JSON): nessuna produce un membro o un articolo fuori dalla richiesta (lo schema `json_schema` lo impedisce già al campionamento, e la validazione lo ricontrolla). Le divisioni prodotte possono essere sbagliate, ma restano entro membri e articoli veri, e il debitore approva gli importi, non la frase. Unit test: 5 risposte "dirottate" del modello rifiutate dopo 2 tentativi, frase sempre passata come dato delimitato dopo le regole.
- **Misurato:** `pnpm ai:eval:offline` verde (log `infra/.out/logs/*-ai-eval-offline-a6.log`), `e2e:demo` 12/12 (log `20261017-193352-e2e-demo.log`).
- **Come si prova:** `pnpm ai:eval:offline`; per la manomissione, i test di `model-check.test.ts`.

### A4, sab 17/10 17:20
- **Cosa funziona:** AI sul dispositivo con QVAC (`@qvac/sdk` 0.21.0): `OCR_LATIN` per il testo e `QWEN3_1_7B_INST_Q4` per il JSON, caricati una volta in background all'avvio dell'agente (`index.ts`), stato `loading → ready | error` in `/state`. Se i modelli non si caricano l'agente parte comunque: AI in `error`, la UI apre il modulo manuale.
- **Come è fatto** (`apps/agent/src/ai/`): i blocchi OCR diventano righe stampate (`ocr-lines.ts`, dai bbox). Il modello **non scrive mai importi**: riceve le righe numerate e indica quale riga è un articolo (con etichetta e quantità), il subtotale, le tasse, la mancia e il totale (`receipt.ts`, schema `json_schema` passato a QVAC con gli indici di riga come limiti). Il codice legge l'importo dalla riga (`amounts.ts`, esponenti di `CURRENCY_EXPONENTS`, "2 x 65.000" → quantità e prezzo unitario) e aggiunge gli avvisi (somma delle righe, totale, quantità × prezzo): mostrati, mai corretti in silenzio. Una riga "Tip"/"Mancia" data come articolo diventa la mancia, una riga del totale data come articolo viene scartata, sempre con un avviso. Divisione (`split.ts`): una chiave per articolo ("0. Pho bo") e i membri come enum, quindi il modello non può nominare altri (injection, SPEC §13 #6); due esempi few-shot con nomi e piatti inventati; `proposeSplit` riceve anche il pagatore ("io"). Zod + al massimo 2 tentativi con l'errore passato al modello, poi `ok: false` con il parziale (`ai-service.ts`). `<think>` e blocchi di codice tolti.
- **Misurato:** `pnpm ai:eval`: cena VND, taxi EUR e supermercato USD (con articolo a peso) con **0 correzioni**; la frase della demo in italiano e in inglese dà esattamente la divisione attesa. Estrazione ~15 s, divisione ~2 s, caricamento 4-5 s con i modelli in cache. `pnpm ai:eval:offline` (stesso eval dentro `sandbox-exec` senza rete IP, verificato che blocca anche `127.0.0.1`): verde. `pnpm e2e:demo` ora fa il passo 2 vero: foto → AI → frase → 3.09/3.09/3.50 → invio, 11/11 verdi sui nodi (log `infra/.out/logs/20261017-171307-e2e-demo.log`).
- **Come si prova:** `pnpm ai:eval`, `pnpm ai:eval:offline`; immagini rigenerabili con `python3 infra/fixtures/receipts/make-images.py`.
- **Problemi noti:** la data non è controllata contro le date del viaggio (l'`AiService` non le riceve). L'OCR prende ~10 s su questo portatile: in UI serve l'attesa con il tempo trascorso (C7). Gira su Node 24 qui, anche se `engines` dice 22. Gli scontrini di prova sono generati (font monospazio): uno scontrino fotografato vero sarà più difficile.

### A5 ★3, wallet reale (sab 17/10, branch `a/A5-real-wallet`, PR #19)
- **Prova reale (B, stack regtest): verde in 25.5 s.** 20 eventi, firme 20/20, catena valida, stessa testa `387bf500da96` su 4/4, ultima riga `OK: real Lightning payment, proof verified, same log on 4/4 agents`.
- Funziona: senza `KITTY_FAKES`, `index.ts` crea un `RlnWallet` (B3) per attore con `realSetup(config)` (`flows/real-setup.ts`): ogni wallet legge solo i segreti del proprio membro. I loop degli agenti partono in entrambe le modalità.
- `seedTrip` (`flows/runtime.ts`, sostituisce `seedFakeTrip`): `TRIP_CREATED`, `RATE_SET`, poi per ogni viaggiatore `MEMBER_JOINED`, `MEMBER_ADMITTED`, `CHANNELS_READY`; ogni passo saltato se già sul relay (riavvio o crash a metà riprende). Asset e id dei canali (travel/liquidity con dave) da `infra/.out/seed-state.json`; tasso da `infra/fixtures/rates.json` (copiato da `_legacy`, `source` usata nel `RATE_SET`). Se il viaggio sul relay ha un altro `assetId` → `StaleRelayError` "the relay holds the trip of a previous seed …: wipe the relay database (RELAY_DB) and restart", l'agente esce con codice 1.
- Come si prova:
  - `pnpm test`: `flows/seed-state.test.ts` (lettura dei file, idempotenza, seed diverso) e `flows/real-wallet.test.ts`: **`RlnWallet` veri** costruiti da file di seed temporanei con `loadMemberWalletOptions`, firme ed25519 verificate dal vero `signatureVerifier`, relay vero via HTTP; solo i 4 nodi RLN sono simulati (`flows/test/rln-network.ts`, stessi endpoint e corpi dello spike). Viaggio dal seed, alice invia la cena, charlie contesta, bob paga 3.09 dopo il silenzio-assenso, preimage verificata, DUSD spostati, stessa testa su 4/4.
  - **Prova reale (da B):** `pnpm demo:unlock` (o `demo:reset`), `RELAY_DB=':memory:' pnpm --filter @kitty/relay start`, poi `pnpm --filter @kitty/agent exec tsx src/flows/check-real.ts`. Stampa i passi con i tempi ed esce con `OK: …` o `FAIL: …`. È un pagamento vero: bob finisce a 46.91, quindi `demo:reset` prima della demo.
- Problemi noti: `seedTrip` riprova ogni 2 s anche su errori che non passano da soli (es. schema): li stampa nel log. Le rotte (C3) non usano ancora `runtime.agents`.
### A5b, integrazione con C2 (sab 17/10)
- `main` aggiornato nel branch con un merge (C2, PR #15): compila e passa senza modifiche ai flussi (`subscribe` ha un secondo argomento opzionale, compatibile).
- `apiErrorOf` riconosce `RelayError`: un rifiuto del relay arriva al chiamante con il codice e il motivo del ledger (es. `INVALID_EVENT` "a due line cannot be contested") e l'azione.
- I flussi usano `list(sinceSeq)` a ogni tick, non `subscribe`: il relay è locale e il polling da 1 s basta; `subscribe` potrà far partire il tick subito (P1).
- Come si prova: `pnpm test` (`apps/agent/src/flows/relay-http.test.ts`): **passi 2-7 attraverso il relay vero** (`buildRelay` con il vero `validateEvent`, solo firme e decoder dei fake) e il `RelayClient` HTTP di C2, stessi esiti del test in memoria e testa del relay = testa di ogni agente; rifiuto del relay con motivo e azione. A mano: `KITTY_FAKES=1 RELAY_DB=':memory:' pnpm --filter @kitty/relay start` e `KITTY_FAKES=1 pnpm --filter @kitty/agent start` → 11 eventi del viaggio finto e 4 `CHECKPOINT` sul relay (provato su porte 4900/4901).

### A5b, sab 17/10
- Controllo iniziale: su `main`, rispetto ad A5a, c'è solo il merge della PR #13. **C2 (`RelayClient`) non è su `main` né su un branch remoto**: il piano non cambia (i flussi usano l'interfaccia `RelayClient`; i test il relay in memoria).
- Funziona (con `KITTY_FAKES=1`): `apps/agent/src/flows/dave.ts` (`CoordinatorAgent`, API sopra) e `MemberAgent.joinTrip`. `errors.ts` ora ha `apiErrorOf(err)` (qualsiasi errore → `ApiError` con azione), usato da entrambi.
- Il seed dei test (`flows/test/setup.ts`) passa ora dai flussi (`createTrip`, `setRate`, `joinTrip`, `admit`, `channelsReady`): anche i test di A5a li esercitano.
- Come si prova: `pnpm test` (`apps/agent/src/flows/dave.test.ts`):
  - **passi 2-7 di SPEC §16**: alice invia la cena → charlie contesta → dave conferma (nuova scadenza 30 s) → bob, in silenzio, paga 3.09 a 20 s → l'agente di charlie non paga la riga confermata (`payUpheldDisputes` false) → a 30 s dalla conferma la riga è tra le insolvenze → "copri ed escludi": stesso invoice pagato dal nodo di dave (preimage verificata), due txid di chiusura, `MEMBER_EXCLUDED` → alice: 6.59 ricevuti, nulla più da ricevere; bob 46.91; charlie 0 nei canali e 100.00 on-chain; dave −3.50; garanzia usata 3.50; registro valido e uguale su 4/4; charlie non più includibile in una spesa.
  - solo il coordinatore agisce come dave; iscrizione e ammissione idempotenti; contestazione risolta solo se `contested`, `line_voided` libera il debitore; copertura solo su `overdue`; oltre la garanzia rimasta: escluso ma non coperto, alice resta in credito; l'esclusione rende scadute le altre righe del membro e dave copre anche quelle.
- Problemi noti:
  - Collaudo con il wallet reale (★3) dopo B3, C2 e B2.
  - Il motivo dell'esclusione è fisso ("Did not pay by the deadline"): la rotta di `api.ts` non ha corpo.
  - Restano quelli di A5a (nessuna azione per pagare a mano una riga `overdue`; doppio controllo con il decoder JS: P1).

### A5a, sab 17/10
- Funziona (con `KITTY_FAKES=1`): `apps/agent/src/flows/`
  - `local-log.ts`: copia verificata del registro. Ogni evento del relay passa da `validateEvent` con il `trip` derivato a `receivedAt`; gli invoice li decodifica il **nodo del membro** (`wallet.decodeInvoice`, in cache, perché `validateEvent` vuole un decoder sincrono). Primo evento rifiutato → copia congelata, `chainValid: false`, motivo in `divergence`. Nodo irraggiungibile → nessun rifiuto, si riprova al tick dopo.
  - `publish.ts`: `inner` con nonce casuale di 16 byte, firma con il wallet del membro, `relay.append`.
  - `expense.ts`: `planExpense` (assegnazioni → quote del ledger con il tasso del giorno; ogni riga assegnata una volta, solo viaggiatori attivi, quota a 0.00 rifiutata) e `previewOf`.
  - `member-agent.ts`: `MemberAgent` (API sopra). Pagamenti uno alla volta per membro; una prova già ottenuta ma non pubblicata resta in memoria e viene ripubblicata, mai ripagata; pagamento fallito ritentato dopo il back-off.
- Scelte (approvate): opzione A (l'agente non è collegato al server: lo fa C3); `fakeVerifier` con i fake, `signatureVerifier` senza; l'agente decodifica con il proprio nodo, non con il decoder JS del relay (che sta in `apps/relay` e non legge gli invoice del `FakeWallet`).
- Come si prova: `pnpm test` (`apps/agent/src/flows/member-agent.test.ts`, relay in memoria con il vero `validateEvent`, quattro `FakeWallet`, orologio manuale): seed verificato da ogni agente; anteprima 3.09/3.09/3.50; **alice invia la cena → charlie contesta → bob, in silenzio, paga in automatico esattamente a 20 s**, preimage verificata, saldi spostati, una sola `PAYMENT_MADE`, stessa testa del registro su 4/4; sopra limite paga solo dopo l'approvazione; pagamento fallito (`TOPUP_REQUIRED`) ritentato; invoice scaduto riemesso e pagato; `CHECKPOINT` ogni 10 eventi; evento falsificato dal relay rifiutato da ogni agente.
- Problemi noti:
  - Nessuna azione per pagare a mano una riga `overdue` ("Pay it yourself" di `decideAutoPay`): manca anche la rotta in `api.ts`. In demo non serve (Charlie non paga). Da decidere con il PM.
  - Doppio controllo degli invoice con il decoder JS (spostarlo in `packages/shared`): P1.
  - Collaudo con il wallet reale (★3) dopo B3, C2 e B2.

### A7, sab 17/10
- Funziona: `liquidityPlan(trip, thresholdCents, extraLiquidity?)` (`packages/ledger/src/liquidity.ts`, riesportato da `kitty.ts`): una voce per membro attivo (canali pronti, non escluso) con `inboundCents`, `toReceiveCents`, `marginCents`, `openCents`.
- `inbound = L + extra + inviato − ricevuto`: L = `params.liquidityCents`; inviato = righe pagate da m via Lightning; ricevuto = righe a favore di m pagate via Lightning o coperte dalla garanzia; i pagamenti on-chain non toccano i canali. `daRicevere` = righe aperte a favore di m, contestate e scadute incluse.
- **Scelte approvate:**
  - apertura = `soglia − margine` quando margine < soglia. La formula di SPEC §10.5 (`daRicevere − margine + soglia`) apre troppo, esattamente di `daRicevere`: con inbound 30.00, da ricevere 45.00, soglia 5.00 aprirebbe 65.00 invece di 20.00. **Proposta di modifica alla SPEC per il PM**, non applicata.
  - terzo parametro `extraLiquidity: ReadonlyMap<Pubkey, bigint>` (default vuoto): la liquidità aperta da Dave dopo il primo canale, che il registro non contiene; la passa l'agente di Dave dal proprio nodo (B9). Senza, il piano richiederebbe la stessa apertura a ogni evento.
- Come si prova: `pnpm test` (blocco "A7 liquidityPlan": i 5 casi della checklist, più on-chain che non conta, `extraLiquidity` che azzera l'apertura, cena della demo: alice inbound 30.00, da ricevere 6.59, margine 23.41).
- Problemi noti: la soglia la sceglie chi chiama (agente di Dave, B9); non c'è ancora un valore in `TripParams`.

### A3, sab 17/10
- Funziona: `decideAutoPay(policy, line, trip, now, invoice)` (`packages/ledger/src/autopay.ts`, riesportato da `kitty.ts`) e `autoPaidLast24h(trip, debtor, now)`.
- **Cambio di firma (approvato, opzione A; avvisare C):** quinto parametro `invoice: DecodedInvoice | null`, decodificato dall'agente con il proprio nodo (`Wallet.decodeInvoice` di `line.bolt11`). `null` = non leggibile → non paga. Per `LineView.agent` di un debitore le rotte possono passare il decodificato o `null` (la frase degli stati non `due` non dipende dall'invoice).
- Regole: paga solo una riga `due` di un viaggio aperto, debitore e creditore non esclusi (creditore escluso → "pay on-chain"), spesa non annullata e con Σ che torna, invoice = quello firmato nel registro, payee = nodo del creditore, asset del viaggio, importo della riga, non scaduto; riga confermata da Dave senza approvazione esplicita solo con `payUpheldDisputes`. Per i pagamenti automatici: importo ≤ `autoPayLimitCents` (ricontrollato: la policy può cambiare dopo l'assenso) e tetto `dailyCapCents` su 24 h mobili (un pagamento di esattamente 24 h fa non conta più). L'approvazione esplicita salta limite e tetto (SPEC §8).
- `reason` per ogni stato, in inglese, per la UI: es. "Paying 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00." (prima di pagare), "Paid 3.09 to alice automatically: …" (dopo), "Will pay 3.09 to alice in 8 s unless you object.", "Not paid: 45.00 is above your automatic limit of 20.00. Approve it yourself.", tetto giornaliero, invoice scaduto, contestata, confermata da Dave, scaduta, coperta, annullata, viaggio chiuso.
- Come si prova: `pnpm test` (blocco "A3 decideAutoPay": gli 8 casi della checklist più frasi degli stati, policy abbassata dopo l'assenso, finestra mobile esatta, creditore escluso).
- Problemi noti: un creditore escluso non viene pagato in automatico (il rail on-chain B5 è P1): la riga resta `due` e poi `overdue` finché non c'è il rail on-chain; nemmeno la copertura di Dave funziona, perché paga via Lightning e il creditore escluso non ha più canali. Fuori dal percorso della demo.

### A2, sab 17/10
- Funziona: `validateEvent(stored, trip, deps)` (`packages/ledger/src/validate.ts`, riesportato da `kitty.ts`): catena (seq, prevHash, hash), firma via `deps.verify` su `signingMessage(inner)`, tripId, nonce (replay), autori (`EVENT_AUTHOR`: tipi di Dave solo da Dave, tipi dei membri mai da Dave, autore ammesso tranne `TRIP_CREATED`/`MEMBER_JOINED`), viaggio chiuso (solo `CHECKPOINT`), e le regole di ogni tipo di SPEC §9.3. Non lancia mai: un errore del decoder o del ledger diventa un rifiuto con il motivo.
- **Come chiamarlo (relay e agente, avvisare C):** `validateEvent(stored, deriveTrip(precedenti, new Date(stored.receivedAt)), deps)`, così lo stato delle righe è quello al momento della ricezione. La forma va già parsata con `StoredEventSchema`.
- Scelte (approvate): tasso = solo l'**ultimo** `RATE_SET` (USD = "1"); `INVOICE_REISSUED` solo con l'invoice precedente scaduto; `bindInvoice: null` rifiutato (rln-rest). Descrizione dell'invoice di legame `kitty-bind:${sha256Hex(appPubkey)}` (sha256 della stringa hex, come il `FakeWallet` di K0: **B4 e B3 devono usare lo stesso formato**). Invoice di riga: payee = nodo del pagatore, asset del viaggio, importo della riga, descrizione `kitty:<tripId>:<expenseId>:<debtor memberId>`, non scaduto alla ricezione, payment hash distinti. Preimage: `sha256(byte della preimage) = paymentHash`.
- Aggiunti al ledger: `expenseFingerprint(receipt, receiptImageSha256)` (`shares.ts`) e `hexToBytes` (`hex.ts`), da usare anche in A5.
- Come si prova: `pnpm test` (blocco "A2 validateEvent"): un log con tutti i 17 tipi di evento passa evento per evento; un test per ogni regola di rifiuto.
- Problemi noti: `PAYMENT_MADE` on-chain accettato con il solo `txid` (una funzione pura non può cercarlo sulla catena; la verifica va nel pannello Prova). `CHECKPOINT` controlla solo che `seq` esista: il confronto delle teste è in UI (P1).

### A1, sab 17/10 10:05
- Funziona: `deriveTrip(events, now): TripState | null` (`packages/ledger/src/kitty.ts`), tutti gli stati di SPEC §7; `expenseShares` (`packages/ledger/src/shares.ts`): scontrino + chi condivide cosa + tasso → quote in centesimi (cena: 3.09 / 3.09 / 3.50 su 9.68).
- Scelte (approvate): orologio = `receivedAt` del relay; `null` per un log vuoto (**cambio di firma, avvisare C**). Prima di ogni evento scattano le scadenze fino al suo `receivedAt` (con `>=`: esattamente alla scadenza la transizione è avvenuta), quindi il silenzio-assenso usa la policy in vigore alla scadenza. Silenzio-assenso se `cents ≤ autoPayLimitCents`. Un evento non applicabile allo stato della riga non cambia nulla (lo rifiuta A2).
- Campi aggiunti ai tipi del ledger (non a `shared`): `LineRecord.paymentDeadlineAt`, `overdueAt`, `contestedAt`; `MemberState.oweCents`, `owedToMeCents`; `TripState.defaults` (righe `overdue`, la più vecchia prima).
- Esclusione: tutte le righe aperte del membro come debitore diventano `overdue` (anche `submitted` e `contested`); quelle in cui è creditore restano. Spesa annullata (`EXPENSE_VOIDED` o `expense_voided`): le righe già `paid`/`guaranteed` restano, il fingerprint viene liberato per poterla reinviare corretta.
- `autoPayments`: i `PAYMENT_MADE` su righe senza approvazione esplicita (un `approve` su una riga `due` confermata da Dave la rende esplicita).
- Come si prova: `pnpm test` (blocco "A1 deriveTrip" e "expenseShares" di `packages/ledger/test/kitty.test.ts`, inclusa la proprietà fast-check Σ righe + quota pagatore = totale).
- Problemi noti: un debitore che non pubblica mai `LINE_SEEN` non va mai in `overdue` (SPEC: la scadenza parte da lì; in demo l'agente lo pubblica da solo; Dave può comunque escluderlo). Con `expense_voided` dopo un pagamento, chi ha già pagato va rimborsato fuori dalla piattaforma.

### K0, ven 16/10 22:45
- Funziona: monorepo pnpm (`@kitty/*`), TS strict, regola lint sui soldi con test, CI; `packages/shared` (id, codec unico dei soldi, JSON canonico + `sha256Hex`, schemi di tutti i 17 eventi, dominio, viste, rotte, client tipizzato, errori con azione); ledger copiato da `_legacy` (cambi, divisione, saldi) con i test; stub di `deriveTrip`, `validateEvent(stored, trip, deps)`, `decideAutoPay`, `liquidityPlan`; interfacce `Wallet`, `Rail`, `AiService`, `RelayClient`; `FakeWallet`/`FakeAi` solo con `KITTY_FAKES=1`; scheletri di relay (:4000), agente (:4100) e web (:5173).
- Come si prova: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm dev:fakes` e apri `http://127.0.0.1:5173/?as=alice`.
- SPEC aggiornata (con approvazione del PM): §9.2 `payerCents`, `payerItemIndexes`; §9.3 `validateEvent(stored, trip, deps)`.
- Problemi noti: nessuno. Nessuna dipendenza nativa (QVAC, `@utexo/*`, SQLite) installata: vanno in PR dedicate.

