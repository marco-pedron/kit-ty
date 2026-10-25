# kit+ty: flussi e schermate (C4, bozza per il PM)

> Basato su `docs/FLOWS-inventario.md`. Glossario: **parte** = quanto un membro deve per una spesa; **limite** = cifra sotto la quale l'agente paga da solo. Nei testi UI (in inglese, CLAUDE.md regola 10) proposti qui: *your part*, *limit* (domanda E3). Mai "quota", "soglia".
> Tempi della demo: oggi `DEMO_TRIP_PARAMS` (`packages/shared/src/domain.ts:145`) dà 20 s di finestra di contestazione e 30 s di scadenza di pagamento, contati tutti e due da `LINE_SEEN`. Il PM ha deciso **45 s e 120 s** (sotto). Le tabelle delle storie usano ancora 20/30 dove citano frasi già verificate in `e2e:demo`.

## Decisioni del PM (sab 17/10, dopo la prima revisione)
1. **Niente interruttore.** Un solo slider del limite, da 0 alla capacità del canale di viaggio (D = 50.00, `trip.params.tripChannelCents`). Etichette: a 0 "Always ask me"; a D "Automatic payment"; in mezzo "Pay automatically up to X DUSD". Sostituisce l'interruttore ON/OFF della sezione B e le domande E1 ed E4.
2. **Finestre in sequenza.** Contestazione 45 s, poi approvazione fino a 120 s dalla notifica (`LINE_SEEN`). Il ledger le conta già entrambe da `LINE_SEEN`: con 45/120 diventano due fasi consecutive (0-45 s contestazione; 45-120 s approvazione delle parti sopra limite, ancora contestabili). **Serve però una modifica di codice**: i tempi non sono configurabili, sono le costanti di `DEMO_TRIP_PARAMS` che `seedTrip` scrive in `TRIP_CREATED` (`apps/agent/src/flows/runtime.ts:95`). Richiesta R4 allo stream B in `docs/status/c.md`; SPEC §15 va aggiornata dal PM.
3. **Alla scadenza dell'approvazione** la parte diventa insolvente da sola (`overdue`, derivata senza evento: `packages/ledger/src/kitty.ts:152-158`) e compare tra gli insolventi di Dave; l'esclusione la decide sempre Dave con "Cover and exclude" (`MEMBER_EXCLUDED` firmato solo da lui, `apps/agent/src/flows/dave.ts`). Corrisponde già al codice.

4. **R4 approvata (sab 17/10):** i tempi 45/120 si passano al seed come override; i test restano su 20/30. La implementa lo stream B.
5. **E12, tempi confermati:** 45/120. **Dal vivo si fa solo la storia 1; la storia 2 va nel video, con i tagli** sulle attese (120 s dopo la conferma di Dave, ~73 s di "Cover and exclude").
6. **E2:** tetto giornaliero fisso a 60.00, mostrato in sola lettura in Settings.
7. **R1 → P1** (serve solo al modulo manuale), chiusa lato UI: l'anteprima del modulo manuale si calcola nel browser con `expenseShares` di `@kitty/ledger` (vedi C2).
8. **Parte sopra 50.00 con lo slider al massimo:** caso accettato, in demo non succede.

Effetti da sapere:
- Dopo una contestazione **confermata** da Dave la nuova scadenza è risoluzione + `paymentDeadlineSeconds` (`kitty.ts:315`): con 120 s, nella storia 2 Charlie diventa insolvente **2 minuti dopo** la conferma di Dave, più circa 73 s di "Cover and exclude". La storia 2 si allunga di circa 1 min e 30 s rispetto a oggi. Domanda E12.
- Bob paga dopo 45 s invece di 20: la frase dell'agente diventerà "no objection in 45 s" (`autopay.ts`, calcolata dai parametri).
> Tutte le schermate leggono solo `GET /api/:as/state` (polling 1 s). Le rotte sotto sono quelle di `packages/shared/src/api.ts`, chiamate con `createAgentClient`.

---

## A. Le due storie della demo

Legenda colonne: **Schermata** · **Chi** · **Rotta** · **Evento sul relay** · **Cosa vede il giudice**.

### Storia 1 "Quando va bene" (taxi)

Preparazione (prima di salire sul palco): Charlie porta lo slider a 10.00 ("Pay automatically up to 10.00 DUSD") → `PUT /api/charlie/policy` → `POLICY_UPDATED`. Bob resta al default (20.00). Scontrino: la fixture di A4 `infra/fixtures/receipts/eur-taxi.png` (45.00 EUR, tasso 0.86 → circa 52.33 USD). In tre fanno circa 17.44 a testa (le cifre esatte le calcola il ledger): sotto il limite di Bob, sopra quello di Charlie. Nelle righe qui sotto "5.69" e "3.00" vanno letti come "≈ 17.44" e "10.00".

| # | Schermata | Chi | Rotta | Evento | Il giudice vede |
|---|---|---|---|---|---|
| 1a | Nuova spesa → Foto | alice | `POST /api/alice/expenses/extract` | — | "Reading on this device…" con secondi trascorsi, poi le righe del taxi modificabili |
| 1b | Nuova spesa → Divisione | alice | `POST /api/alice/expenses/split` (`{receipt, text:"taxi split in three"}`) | — | Le parti per persona calcolate dal ledger, con il tasso del giorno |
| 1c | Nuova spesa → Invia | alice | `POST /api/alice/expenses` | `EXPENSE_SUBMITTED` | "Sent. 2 payment requests signed by your node." Alice: "Owed to you" ≈ 11.38 |
| 2 | Home di bob e charlie (banner) | agenti di bob e charlie, da soli | nessuna (polling) | `LINE_SEEN` ×2 | Sui due telefoni compare insieme: "alice paid Taxi. Your part: 5.69" (cifre indicative) con conto alla rovescia di 20 s |
| 3 | Dettaglio spesa di bob | agente di bob | nessuna | `PAYMENT_MADE` | Il conto arriva a 0 → "Your agent paid 5.69 to alice: no objection in 20 s, under your limit of 20.00." + link Proof. **Nessun blocco minato** |
| 4 | Dettaglio spesa di charlie | charlie | `POST /api/charlie/expenses/:id/decision {approve}` | `LINE_DECIDED{approve}`, poi `PAYMENT_MADE` | "Needs your approval: 5.69 is above your limit of 3.00" + bottone Approve con il tempo rimasto per pagare (30 s). Dopo il tocco: "Paying…", poi "Paid 5.69 to alice: you approved it." |
| 5 | Home di tutti | — | nessuna | — | Spesa "Settled". Alice: "Owed to you 0.00", nell'attività i due pagamenti con le prove |

Note:
- **Anteprima del modulo manuale (ex R1, ora P1, decisione 7):** `FakeAi` restituisce sempre la cena, quindi con `pnpm dev:fakes` il taxi va corretto e assegnato a mano. Le parti si mostrano prima dell'invio calcolandole nel browser con `expenseShares` di `@kitty/ledger`, la stessa funzione pura che l'agente usa in `planExpense` (C2). Con l'AI reale (A4) la storia 1 passa da `/expenses/split`, che restituisce già l'anteprima.
- Battuta 4: Charlie deve approvare **entro 120 s da `LINE_SEEN`** (decisione 2, dopo R4; oggi 30 s). Il bottone è attivo da subito, anche durante la finestra. Dopo la scadenza la riga è `overdue` e "Approve" viene rifiutato (il pagamento manuale di una riga scaduta è P1).

### Storia 2 "Quando va male" (cena, SPEC §16; verde in `pnpm e2e:demo`)

| # | Schermata | Chi | Rotta | Evento | Il giudice vede |
|---|---|---|---|---|---|
| 1 | Nuova spesa | alice | `extract` → `split` (`"Bob and I had the pho, Charlie only beers, water for all three"`) → `POST /api/alice/expenses` | `EXPENSE_SUBMITTED` | Parti 3.09 / 3.09 / 3.50 calcolate dal ledger; "Owed to you 6.59" |
| 2 | Dettaglio spesa di bob | agente di bob | nessuna | `LINE_SEEN`, poi `PAYMENT_MADE` | Conto alla rovescia 20 s → "Your agent paid 3.09 to alice: no objection in 20 s, under your limit of 20.00." + Proof |
| 3 | Dettaglio spesa di charlie | charlie | `POST /api/charlie/expenses/:id/decision {contest, reason:"I only had water"}` | `LINE_SEEN`, `LINE_DECIDED{contest}` | Durante i 20 s Charlie preme Contest, scrive il motivo → "Contested: waiting for dave to decide." |
| 4 | Home Dave → Contestazione | dave | `POST /api/dave/disputes/:expenseId/charlie {outcome:'upheld', note}` | `DISPUTE_RESOLVED{upheld}` | Dave vede il motivo e le righe assegnate a Charlie dall'AI (Bia Saigon x3, Water), l'hash della foto; Alice mostra la foto di persona; Dave preme "Uphold". Charlie vede "Dave upheld alice's expense: approve 3.50 yourself" con 30 s |
| 5a | Home Dave → Insolventi | orologio | nessuna | — | Charlie non approva; dopo 30 s la riga compare tra gli insolventi con "Guarantee left 50.00" |
| 5b | Home Dave → "Cover and exclude" | dave | `POST /api/dave/defaults/:expenseId/charlie/cover-and-exclude` | `GUARANTEE_PAID`, `MEMBER_EXCLUDED` | Attesa di ~73 s che dice cosa succede (`operations`: "Paying 3.50 to alice with the operator's liquidity…", "Closing both channels with charlie…"), poi i txid di chiusura con link a esplora. Charlie: "You were excluded: your channels are closed", fondi on-chain |
| 6 | Proof e Registro (qualsiasi telefono) | chiunque | `GET /api/proof/:paymentHash`; `/state` → `ledger` | — | Proof: tre ✓ (preimage = hash, invoice firmato dal nodo di alice, importo e asset). Registro: "23 events · 23/23 signatures valid · chain valid · head 3f9a…" |

Note:
- Battuta 3: Charlie ha **45 s** per contestare (decisione 2, dopo R4), perché la sua parte (3.50) è sotto il suo limite: allo scadere l'agente paga e la contestazione non è più possibile.
- Battuta 5b: la richiesta HTTP resta aperta ~73 s (b.md, B8). La UI mostra le `operations` di Dave mentre aspetta, e non manda un secondo clic (bottone disabilitato "Working…").
- Battuta 6: "same on 4/4 phones" **non** è disponibile (`ledger.checkpoints` è `null`, P1). La UI mostra la catena e le firme e omette il confronto finché non arriva (domanda E9).
- Passo 7 di SPEC §16, Alice: "Reimbursed 6.59: 3.09 from bob, 3.50 guaranteed by the operator" si costruisce da `me.credits` (`paidBy`).

---

## B. Slider del limite (solo UI; decisione 1 del PM)

Rotta: `PUT /api/:as/policy {policy}` con la policy **intera** (`autoPayLimitCents`, `dailyCapCents`, `payUpheldDisputes`). Esiste: **non è bloccante**.

| Posizione | Etichetta | Cosa manda la UI |
|---|---|---|
| 0 | "Always ask me": l'agente non paga mai da solo, ogni parte va approvata | `autoPayLimitCents = 0` |
| tra 0 e D | "Pay automatically up to X DUSD" | `autoPayLimitCents = X` |
| D (50.00) | "Automatic payment": l'agente paga ogni parte dopo la finestra, salvo contestazione | `autoPayLimitCents = D` |

- **Valore massimo:** D si legge da `/state` → `trip.params.tripChannelCents` (anche in `me.balance.tripChannelCents`, che però è `null` se il nodo non risponde: si usa il primo). La posizione si legge da `me.policy.autoPayLimitCents`; un valore ≥ D si mostra come "Automatic payment".
- **"Limite disattivato" non è assoluto.** Il ledger confronta sempre la parte con il limite (`kitty.ts:145-150`). A D = 50.00 una parte sopra 50.00 chiede comunque l'approvazione. Oggi può capitare solo a chi ha ricevuto rimborsi: Alice, dopo la storia 2, ha 56.59 spendibili. In demo è irrilevante; va detto a voce se lo chiedono. Caso accettato dal PM (decisione 8).
- **Contestare resta possibile** durante la finestra di 45 s anche a "Automatic payment", perché ogni pagamento automatico la aspetta (`deriveTrip`). Lo si scrive sotto lo slider: "You can always contest within 45 s."
- **Tetto giornaliero (decisione 6):** 60.00 fisso, mostrato in sola lettura sotto lo slider: "and at most 60.00 a day". La UI rimanda sempre `dailyCapCents` invariato da `me.policy`.
- **Effetto immediato:** il cambio vale per le parti la cui finestra non è finita, e `decideAutoPay` ricontrolla il limite prima di pagare. Abbassare il limite su una parte già `due` la blocca ("Approve it yourself").
- **Salvataggio:** al rilascio dello slider parte una sola `PUT`: "Saving…", poi "Saved: signed and shared with your agent". In caso di errore, messaggio + `action`. Lo slider si muove a passi di 0.50 e i valori restano `bigint` in centesimi. Non serve più `localStorage`.

---

## C. Schermate

Elementi comuni a ogni schermata: banner "Fakes on" se `fakes`; nome dell'attore; errore di `/state` con il suo `action`; una riga per ogni `operation` in `running` ("Paying 3.09 to alice through the operator's node… 2 s").

### C1. Home membro
- **Scopo:** quanto ho, quanto devo, quanto mi devono, e cosa sta facendo il mio agente.
- **Contenuti, in ordine:**
  1. Banner di notifica se c'è una parte nuova o che richiede me (`me.debts` in `awaiting_decision`/`awaiting_explicit`/`due` confermata): "alice paid Taxi · Your part 5.69 · Agent pays in 14 s" oppure "Needs your approval".
  2. Saldo del canale di viaggio: `balance.tripOutboundCents` "of 50.00 · Only you can spend it".
  3. "You owe" `oweCents` · "Owed to you" `owedToMeCents`.
  4. Stato dell'agente con l'etichetta dello slider ("Automatic payment" / "Pay automatically up to 20.00 DUSD" / "Always ask me"), più "Paid automatically today: 3.09".
  5. Ultime spese (`expenses`, 3) con stato della mia parte; link ad Attività.
  6. Riga compatta "Ledger verified ✓ 23/23" → Registro.
- **Azioni:** "I paid" (Nuova spesa) se sono membro attivo e AI `ready` o modulo manuale; tocco su una spesa → Dettaglio; Impostazioni.
- **Non possibili:** vedere i saldi degli altri (non c'è nulla da mostrare: "Only you see your balance"). Escluso: "I paid" disabilitato con "You were excluded from this trip".
- **Stati:** vuoto "No expenses yet. When someone pays for the group, it shows here."; saldo `null` → "Balance not available: your node is not responding" + azione `NODE_UNREACHABLE`; `trip: null` → "Waiting for the trip to be set up by dave"; `topupWarning` → "Your trip channel is low".

### C2. Nuova spesa (scontrino + divisione AI)
- **Scopo:** dalla foto alle parti firmate, con l'AI che propone e il ledger che calcola.
- **Passi e contenuti:**
  1. **Foto:** scatta o scegli. "The photo never leaves this phone." La UI calcola `sha256` della foto (WebCrypto) per `receiptImageSha256`.
  2. **Lettura:** "Reading on this device…" + secondi trascorsi + badge "Runs on this device" (o "Simulated AI" con i fake).
  3. **Revisione:** esercente, data, valuta, righe (etichetta, quantità, totale), mancia, tasse, totale. `warnings` in evidenza, mai corretti in silenzio. Totale che non torna → avviso + "Fix an item or the total".
  4. **Divisione:** campo frase ("Who had what?"), poi assegnazioni proposte per riga con i nomi; eventuale domanda dell'AI (`clarificationNeeded`) con una risposta, mandata una volta.
  5. **Anteprima:** parte per persona in DUSD (`preview.shares`), tasso e data del tasso. La mia parte esclusa dai debiti.
     Nel modulo manuale (AI fallita, o righe e assegnazioni corrette a mano) l'anteprima si calcola nel browser con `expenseShares` (`packages/ledger/src/shares.ts`), una funzione pura che non usa moduli di Node. Gli input: `receipt`; `rate`, che è `/state` → `rate.rates[currency]` (`"1"` per USD); come id le **pubkey** dei membri (`members[].pubkey`), non i nomi, perché i pareggi di arrotondamento si risolvono per id e così i centesimi coincidono con quelli dell'agente. La UI controlla prima le stesse condizioni di `planExpense` (tasso presente, ogni riga assegnata una sola volta, solo viaggiatori attivi, almeno un altro membro, nessuna parte a 0.00). L'ultima parola resta all'agente, che ricalcola tutto all'invio.
  6. **Invia.**
- **Azioni:** Invia solo con anteprima valida (nessuna riga non assegnata, tasso presente); modifica manuale di righe e assegnazioni sempre.
- **Non possibili:** assegnare a Dave o a un escluso (non compaiono nella lista); cambiare le cifre delle parti (le calcola il ledger: "Parts are computed by the ledger, not the AI").
- **Stati:** AI `loading` → "On-device AI is loading" + "Fill in by hand"; AI fallita dopo 2 tentativi → modulo manuale precompilato con `partial`; `MISSING_RATE` → "Ask dave to set today's rate"; invio in corso → "Creating 2 payment requests and signing…" (operation `submitting_expense`); errore → `message` + `action`.

### C3. Notifica / dettaglio spesa (approva o contesta)
- **Scopo:** decidere sulla mia parte, o seguire chi deve pagarmi.
- **Contenuti, in ordine:**
  1. Da debitore: la mia parte, a chi, e la frase dell'agente (`LineView.agent.reason`, es. "Will pay 3.09 to alice in 12 s unless you object."), con il conto alla rovescia (`deadlineAt` − `serverNow`).
  2. Le righe dello scontrino che mi sono state assegnate (`items` con `members`), tasso bloccato, totale.
  3. Da pagatore: una riga per debitore con stato ("Paid by bob", "Contested by charlie: 'I only had water'", "Covered by the operator").
  4. Prova di ogni pagamento (link) e annotazione di Dave (`resolution.note`).
- **Azioni:**
  - **Approve:** `submitted`/`awaiting_decision`/`awaiting_explicit`, oppure `due` confermata da Dave e non ancora approvata.
  - **Contest** (motivo obbligatorio): solo `submitted`/`awaiting_decision`/`awaiting_explicit`.
  - **Void expense** (pagatore): nessuna riga `paid`/`guaranteed`.
- **Non possibili:** contestare dopo la finestra su una parte sotto limite → "Already paid by your agent: the 20 s window is over. Ask dave if something is wrong."; approvare o pagare una parte `overdue` → "Overdue: the operator may cover it" (pagamento manuale P1); annullare dopo un pagamento → "Someone already paid: ask dave to void it"; decidere la parte di un altro → non c'è il bottone.
- **Stati:** decisione in corso "Signing…"; pagamento in corso (operation `paying`); errore con `action`; spesa annullata "Voided: you owe nothing".

### C4. Impostazioni (agente)
- **Scopo:** decidere cosa il mio agente può pagare senza chiedermi.
- **Contenuti, in ordine:** slider del limite con la sua etichetta (sezione B); spiegazione delle finestre ("You can always contest within 45 s. Parts above your limit wait for your approval up to 2 min."); "Pay upheld disputes on my own" (`payUpheldDisputes`, OFF di default); nota "Your settings are signed and shared in the trip ledger".
- **Azioni:** tutte sempre disponibili per un membro, anche durante il viaggio.
- **Non possibili:** Dave non ha questa schermata (403 dalla rotta); escluso: controlli disabilitati con "You were excluded".
- **Stati:** "Saving…", "Saved", errore con `action`.

### C5. Prova
- **Scopo:** dimostrare che un pagamento è avvenuto davvero, senza fidarsi di nessuno.
- **Contenuti, in ordine:** "Verified ✓" o "Not verified ✗"; chi ha pagato chi, quanto, `paidBy` ("by bob" / "by the operator's guarantee"); i tre controlli con `label` e `detail`; `paymentHash` e `preimage` abbreviati e copiabili; per on-chain txid e link a esplora.
- **Azioni:** copia; apri esplora (on-chain).
- **Stati:** 404 subito dopo il pagamento → "Waiting for the proof to reach the ledger…" e nuovo tentativo dopo 1 s; ✗ → il dettaglio del controllo che fallisce.

### C6. Registro
- **Scopo:** mostrare che nessuno, nemmeno il relay, può falsificare la storia.
- **Contenuti, in ordine:** "Ledger verified ✓" se `chainValid` e `validSignatures = events`; "N events · N/N signatures valid · hash chain valid"; testa `headSeq` e `headHash` abbreviato; elenco `activity` (eventi del registro più decisioni dell'agente) con link Proof; confronto tra telefoni solo quando `checkpoints` non è `null`.
- **Azioni:** apri una prova.
- **Stati:** `chainValid: false` → "The relay sent an entry this phone rejects. Your agent stopped trusting it and keeps its own copy." (in rosso); vuoto prima del viaggio.

### C7. Home Dave (contestazioni, insolventi, tasso del giorno) — costruita in C5
- **Scopo:** decidere le contestazioni, coprire chi non paga, tenere il tasso.
- **Contenuti, in ordine:**
  1. **Contestazioni** (`coordinator.disputes`): debitore, parte, motivo, righe assegnate, esercente, hash della foto ("Ask alice to show the photo").
  2. **Insolventi** (`coordinator.defaults`): debitore, creditore, parte, da quando, garanzia residua.
  3. **Membri**: stato (attivo/escluso), garanzia usata/residua, credito dell'operatore, margine di liquidità.
  4. **Tasso del giorno** (`rate`): fonte, data, valori.
- **Azioni:** Uphold / Void line / Void expense (riga `contested`, nota facoltativa); "Cover and exclude" (riga in `defaults`); modifica tasso.
- **Non possibili:** muovere fondi dei viaggiatori o approvare per loro (non esiste: "Dave can't spend anyone's money"); coprire oltre G (`coverable: false`) → bottone "Exclude only" con "3.50 is above the guarantee left (1.00)" (il flusso esclude comunque e restituisce `covered: null`).
- **Stati:** nessuna contestazione "No disputes"; nessun insolvente "Everyone is paying on time"; copertura in corso con le `operations` di Dave e il tempo trascorso; `INVOICE_EXPIRED` → "Wait for alice's agent to reissue the payment request".

---

## D. Cosa capisce un giudice in 3 secondi

- **Home membro:** "Questi sono soldi miei (50.00, solo io li spendo), so subito quanto devo e quanto mi devono, e c'è un agente che paga per me entro un limite che ho scelto io." Il primo sguardo cade sul banner con il conto alla rovescia, poi sul saldo.
- **Home Dave:** "L'operatore non tiene i soldi di nessuno: vede solo i problemi (una contestazione, un insolvente) e ha un bottone per coprire ed escludere, con un tetto di garanzia visibile."

---

## E. Domande aperte per il PM

1. ~~Valore MAX di "Pagamento automatico"~~ **Deciso:** slider da 0 a D, senza interruttore.
2. ~~Tetto giornaliero~~ **Deciso:** 60.00 fisso, in sola lettura (decisione 6).
3. **Lingua della UI.** CLAUDE.md dice UI in inglese; il glossario è in italiano. **Raccomando** inglese con *your part* (parte) e *limit* (limite), mai *share*/*quota*/*threshold*.
4. ~~Storia 1, scadenza di 30 s~~ **Deciso:** 45 s / 120 s (decisione 2), con R4.
5. ~~Storia 2, contestazione in 20 s~~ **Superata** dai 45 s della decisione 2.
6. ~~Storia 1 con i fake~~ **Chiusa:** anteprima manuale nel browser con `expenseShares` (decisione 7).
7. **Ordine delle storie in demo.** Charlie viene escluso alla fine della storia 2. **Raccomando** storia 1 → storia 2 sullo stesso viaggio, senza `demo:reset` in mezzo.
8. **Registro per evento.** SPEC §9.5 chiede solo il riepilogo, che c'è. **Raccomando** riepilogo + attività ora; l'elenco con hash e firme per evento (R2) solo se lo stream B ha tempo.
9. **"Uguale su 4/4".** Non c'è (P1). **Raccomando** di non simularlo confrontando le finestre dal browser: si mostra quando `checkpoints` arriva.
10. **Notifiche.** **Raccomando** solo banner in app dal polling (nessuna notifica del browser), che basta per tre finestre affiancate.
11. **"Cover and exclude" di ~73 s.** **Raccomando** di tenerlo sincrono e mostrare le `operations`; se il PM vuole un tempo più corto sul palco, è lavoro di B (mining).
12. ~~Durata della storia 2 con 120 s~~ **Decisa:** dal vivo solo la storia 1, la storia 2 nel video con i tagli (decisione 5).

---

## F. Piano C4 completo (superato dal piano ridotto a 4 h del PM, sab 17/10)

**Ordine di costruzione** (quelle delle due storie per prime):
1. Guscio: `?as=`, banner fake, hook di stato, errori. 2. Home membro (C1). 3. Dettaglio spesa / banner (C3). 4. Nuova spesa (C2). 5. Impostazioni (C4). 6. Attività. Prova e Registro sono C6, Home Dave è C5: tracce minime ora solo se servono a chiudere le storie.

**Componenti riutilizzabili:** `Money` (bigint → `formatCents`, mai `number`); `Countdown` (`deadlineAt` contro `serverNow`, con lo scarto rispetto all'orologio del browser calcolato a ogni polling); `PartRow` (riga con stato, parte, persona); `StateBadge` (etichetta per ogni `LineState`); `AgentSays` (la frase di `LineView.agent`); `ActionButton` (abilitato o disabilitato con il motivo scritto accanto, stato "Signing…"); `ErrorBox` (`message` + `action`); `OperationsBar` (operazioni in corso con il tempo trascorso); `NotificationBanner`; `ProofLink`; `EmptyState`.

**Lettura dello stato:** un hook `useTripState(as)` che fa polling di `/state` ogni secondo con `createAgentClient` (già nello scheletro di `App.tsx`), conserva lo snapshot precedente per rilevare le parti nuove (notifica), e dopo ogni azione forza un aggiornamento subito. Niente SSE: l'agente non ne espone e la UI non parla con il relay (SPEC §14). Tutti gli importi restano `bigint` dopo `z.decode`.

**Dati di prova:** `pnpm dev:fakes` (relay + agente con `FakeWallet`, `FakeAi` e `seedTrip` con i canali finti; viaggio "Vietnam 2026" con 3 membri attivi). La storia 2 gira così com'è. La storia 1 richiede R1 oppure l'AI reale. Una qualsiasi immagine JPEG fa da scontrino (`FakeAi` non la legge). Poi un giro sullo stack reale dopo `pnpm demo:reset`.

**Stima:** guscio + hook + componenti 2 h; Home 1,5 h; Nuova spesa 3 h; Dettaglio/banner 2 h; Impostazioni 1 h; Attività 1 h; test delle funzioni pure (conto alla rovescia, rilevamento novità, ON/OFF) 1 h; giro sul reale e correzioni 1,5 h. **Totale ≈ 13 h** (più ≈ 1 h se arriva R1 e si collega il modulo manuale).
