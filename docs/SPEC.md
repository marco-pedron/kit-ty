# kit+ty: specifica di prodotto e tecnica

> **Fonte di verità del progetto.** Se codice, prompt o altri documenti la contraddicono, vale questo file. Le modifiche passano dal PM, che aggiorna il registro decisioni in fondo (§20).
> Convenzioni: **[D]** = decisione presa, non riaprire senza motivo. **[VERIFICA]** = comportamento di RLN non ancora provato, da chiudere con lo spike (`docs/prompts/00-spike-lightning.md`); finché non è verificato, il codice non lo dà per scontato.
> Nomi: prodotto **kit+ty**; nel codice `kitty`; repository `kit-ty`; pacchetti `@kitty/*`.

---

## 1. In una frase

**kit+ty è la cassa comune dei viaggi di gruppo, senza custode.** Ogni viaggiatore tiene i propri dollari digitali in un canale Lightning RGB verso il nodo del tour operator. L'AI sul telefono legge lo scontrino e divide la spesa; l'agente di ciascuno rimborsa chi ha pagato in pochi secondi, entro limiti fissati da lui. Se qualcuno non paga, l'operatore copre il buco e lo esclude dal gruppo.

**Il valore, detto onestamente:**
- rimborso **istantaneo e automatico** di chi anticipa, tra sconosciuti di nazionalità diverse, con un unico dollaro digitale per tutti;
- **nessuno custodisce i soldi di nessuno**: né il coordinatore né l'operatore possono spendere i fondi di un viaggiatore;
- **certezza del rimborso** fino a un tetto, garantita dall'operatore, che conosce i suoi clienti, invece che dai soldi altrui;
- **privacy**: la foto dello scontrino non lascia il telefono, nessuno vede i saldi degli altri.

Non è contante spendibile sul posto: il ristorante in Vietnam si paga comunque in contanti o con carta. kit+ty regola **i conti tra i membri del gruppo**.

## 2. Contesto: l'hackathon e come veniamo giudicati

*Agentic Dollars on Bitcoin*, BLOX Torino, 17-18 ottobre 2026. Organizzatore RGB Protocol Association; sponsor Tether (WDK, QVAC) e Utexo; giuria Tether, KaleidoSwap, Utexo. **Submit domenica alle 13:00, pitch alle 16:00.**

RGB e QVAC sono obbligatori; WDK dà un bonus, pieno se l'integrazione è "ben fatta e centrale": in kit+ty WDK gestisce la tesoreria on-chain dell'operatore: emissione e on-ramp dei DUSD (§14.0); il nodo Lightning WDK è in roadmap (§18). Cinque criteri con lo stesso peso, voto 1-10. Ecco come li colpiamo:

| Criterio | Come lo colpisce kit+ty |
|---|---|
| **RGB usage** (transazioni vere, non simulate) | Canali Lightning RGB con asset NIA, pagamenti instradati via hub, aperture e chiusure on-chain, fallback on-chain. Tutto su regtest, con prove verificabili (preimage, txid). |
| **QVAC e AI locale** (quanto è centrale) | OCR ed estrazione dello scontrino, divisione da linguaggio naturale, tutto on-device. Senza AI il flusso non parte. |
| **Execution** (end-to-end) | Un percorso felice blindato: foto → AI → firma → pagamento automatico → contestazione → copertura → esclusione. |
| **Marketability** | B2B2C per tour operator di viaggi di gruppo; il concorrente è la busta di contanti più Splitwise. |
| **UX/UI** (il flusso, non l'estetica) | Ogni passo asincrono dice cosa succede; ogni errore ha un'azione suggerita; l'agente spiega perché ha pagato o non ha pagato. |

Tracce toccate: 2 (conti condivisi self-custodial), 1 (cross-border) e soprattutto 4 (*agenti economici autonomi*: l'AI propone, l'utente fissa i limiti, l'agente paga).

## 3. Utenti e problema

- **Cliente pagante (B2B2C):** il tour operator di viaggi di gruppo organizzati (formato tipo WeRoad, citato solo come esempio di mercato).
- **Utente operativo:** il coordinatore del viaggio, **Dave**, dipendente dell'operatore. Ha tutto l'interesse a far funzionare il gruppo: la sua valutazione e quella dell'operatore dipendono dal viaggio.
- **Utenti finali:** viaggiatori che non si conoscono, di nazionalità diverse. Nella demo **Alice** (IT), **Bob** (DE), **Charlie** (US), in viaggio in Vietnam, spese in VND.

Oggi le spese comuni finiscono in due modi sbagliati: la **busta di contanti** del coordinatore (opaca, un solo custode, residuo restituito a mano), oppure qualcuno **anticipa** e "poi ci sentiamo" con un'app che calcola ma non paga. I più disponibili finiscono in credito verso sconosciuti che spariscono.

## 4. I concetti

| Concetto | Cos'è |
|---|---|
| **Canale di viaggio** | Canale Lightning RGB aperto **dal viaggiatore** verso il nodo dell'operatore, con D dollari digitali suoi. È il suo budget impegnato per il viaggio. Solo lui può spenderlo, e può uscire chiudendo il canale. |
| **Canale di liquidità** | Canale aperto **dall'operatore** verso il viaggiatore, con L dollari dell'operatore. Serve al viaggiatore per **ricevere** i rimborsi. I fondi restano dell'operatore finché non vengono instradati. (Due canali per coppia: verificato nello spike.) |
| **Cassa distribuita** | La somma dei saldi dei viaggiatori nei loro canali. Nessuno la detiene e nessuno ne vede il totale: ognuno vede solo il proprio saldo. **Non si chiama "cassa comune" nel pitch.** |
| **DUSD** | Asset NIA demo, precisione 2 (1 centesimo = 1 unità), al posto di USDT. Emesso nel seed dal **wallet WDK on-chain** dell'operatore (`wdk-wallet-rgb`), che lo "vende" ai viaggiatori alla prenotazione (simulazione dell'on-ramp). |
| **Agente** | Il software che agisce per un membro: ha accesso **solo** al nodo e alla chiave di quel membro, verifica il registro e paga secondo la policy del membro (§8). |
| **Registro firmato** | Elenco append-only di eventi firmati dai rispettivi autori, ospitato da un **relay** (il "postino") che non può falsificare nulla (§9). |
| **Garanzia dell'operatore** [D] | Se un debitore non paga entro la scadenza, Dave paga il creditore **con la liquidità dell'operatore**, fino a un tetto G per membro e viaggio. Il debito diventa un credito dell'operatore verso il debitore, recuperato fuori dalla piattaforma (l'operatore ha prenotazione, documento e carta del cliente). |
| **Esclusione** [D] | Un membro disonesto viene escluso da Dave: Dave **chiude entrambi i canali** con lui e il membro non può più essere incluso in nuove spese. I suoi fondi tornano a lui on-chain: l'esclusione è una sanzione, **non** un modo per recuperare il debito (quello lo fa la garanzia). |

**[D] Perché la garanzia:** con la self-custody nessuno può prendere i soldi di Bob per pagare Alice. La certezza del rimborso non viene più dai soldi degli altri ma dall'operatore, che ha un incentivo commerciale e conosce i suoi clienti. È lo stesso modello delle carte di credito: chi conosce il cliente si prende il rischio.

## 5. Ruoli e poteri

| Chi | Può | Non può |
|---|---|---|
| **Viaggiatore** | Registrare spese che ha pagato; approvare o contestare **le proprie** righe; fissare i limiti del suo agente; uscire chiudendo il canale. | Approvare righe altrui; spendere fondi altrui. |
| **Agente del viaggiatore** | Firmare e pagare le righe dovute secondo la policy; verificare ogni evento. | Pagare oltre i limiti; pagare righe contestate o non verificate. |
| **Dave (coordinatore/operatore)** | Instradare i pagamenti; pubblicare il tasso del giorno; risolvere le contestazioni (conferma o annulla la riga); coprire le insolvenze con la garanzia; escludere un membro. | **Muovere i fondi dei viaggiatori**; firmare al loro posto; approvare righe per conto loro. |
| **Relay (postino)** | Ricevere, validare, ordinare e consegnare eventi; conservare backup cifrati. | Creare o modificare eventi (sono firmati); leggere i backup (sono cifrati). Può solo non consegnare, e questo viene rilevato (§9.4). |

## 6. Ciclo di vita

### 6.1 Onboarding (alla prenotazione)
1. Il viaggiatore compra DUSD dall'operatore (on-ramp). **Demo:** il seed trasferisce on-chain 100.00 DUSD a ciascuno.
2. L'app crea il nodo del viaggiatore e mostra la mnemonica una volta. L'agente pubblica `MEMBER_JOINED`, firmato con la chiave del nodo, con nome e policy.
3. Dave pubblica `TRIP_CREATED` (parametri del viaggio) e `MEMBER_ADMITTED` per ogni membro.

### 6.2 Apertura dei canali
1. Il viaggiatore apre il **canale di viaggio** con D = 50.00 DUSD verso Dave.
2. Dave apre il **canale di liquidità** con L = 30.00 DUSD verso il viaggiatore.
3. Dopo le conferme, Dave pubblica `CHANNELS_READY` per quel membro (un'attestazione: nessun altro può vedere i canali).
4. Il viaggiatore vede: "50.00 nel tuo canale di viaggio. Solo tu puoi spenderli".

### 6.3 Una spesa
1. Alice paga la cena al ristorante (contanti o carta, in VND).
2. Fotografa lo scontrino. L'AI **sul suo telefono** estrae le righe (§11). Alice corregge se serve.
3. Alice scrive: *"Bob e io la pho, Charlie solo birre, l'acqua in tre"*. L'AI propone l'assegnazione; il ledger calcola le quote in centesimi con il tasso del giorno di Dave, **bloccato all'invio**.
4. Per ogni debitore, l'agente di Alice crea un **invoice Lightning** dal nodo di Alice: importo = quota in DUSD, descrizione `kitty:<tripId>:<expenseId>:<debtor>`, scadenza `INVOICE_EXPIRY_SECONDS`.
5. L'agente di Alice pubblica `EXPENSE_SUBMITTED` con scontrino strutturato, hash della foto, tasso, quote e invoice. **La foto resta sul telefono di Alice.**

### 6.4 Approvazione
1. L'agente di ogni debitore riceve l'evento, lo verifica (firma, totali, invoice intestato ad Alice) e pubblica `LINE_SEEN`. **La scadenza del silenzio-assenso parte da qui**, non dall'invio: una spesa caricata di notte non scade mentre il debitore dorme.
2. Il debitore può approvare o contestare (`LINE_DECIDED`). Se non fa nulla entro `SILENT_ASSENT_SECONDS` e la riga rientra nella sua policy, vale il **silenzio-assenso**.
3. Sopra il limite della policy il silenzio-assenso non vale: serve un'approvazione esplicita.

### 6.5 Pagamento
1. Una riga approvata o assentita è **dovuta**. L'agente del debitore paga subito l'invoice via Lightning, attraverso Dave.
2. A pagamento riuscito pubblica `PAYMENT_MADE` con `paymentHash` e `preimage`: chiunque può verificare che `sha256(preimage) == paymentHash` dell'invoice firmato dal nodo di Alice (§10.2).
3. Saldo insufficiente nel canale → la riga resta dovuta, l'utente vede `TOPUP_REQUIRED` (§6.9).

### 6.6 Contestazione
1. Il debitore contesta con una motivazione: la riga si blocca e compare tra le contestazioni di Dave.
2. Dave può chiedere di vedere la foto: Alice gliela mostra (in demo, di persona; in roadmap, inviata cifrata alla chiave di Dave).
3. Dave decide con `DISPUTE_RESOLVED`:
   - **confermata** → la riga torna dovuta con scadenza `PAYMENT_DEADLINE_SECONDS`;
   - **riga annullata** → la riga non è più dovuta;
   - **spesa annullata** → tutta la spesa è annullata (va reinviata corretta).
4. Una riga confermata da Dave **non** viene pagata in automatico, a meno che il debitore non abbia attivato `payUpheldDisputes` nella sua policy. Deve approvarla lui.

### 6.7 Insolvenza, copertura, esclusione
Una riga dovuta e non pagata oltre la scadenza diventa **scaduta** e compare tra le insolvenze di Dave. Dave ha due azioni, che in UI sono un unico bottone "Copri ed escludi":
1. **Copertura (`GUARANTEE_PAID`)**: il nodo di Dave paga **lo stesso invoice** che il debitore avrebbe dovuto pagare, con la propria liquidità. La prova è identica (preimage). Il creditore è rimborsato; nasce un credito dell'operatore verso il debitore, mostrato nella vista di Dave.
2. **Esclusione (`MEMBER_EXCLUDED`)**: Dave chiude in modo cooperativo i due canali con il membro. I DUSD tornano al membro on-chain con uno sweep circa 6 blocchi dopo la conferma della chiusura, visibili dopo `/refreshtransfers` (in demo: budget di 12 blocchi minati). Da quel momento:
   - il membro non può essere incluso in nuove spese (validazione);
   - le sue righe aperte diventano subito scadute, e Dave le copre fino al tetto G;
   - ciò che gli altri devono a lui viene pagato con il rail on-chain (§10.3), perché non ha più canali.

Anche il tetto G è un limite: oltre G, il creditore resta con un credito off-chain verso il debitore. Va detto onestamente.

### 6.8 Fine viaggio
Tutte le righe sono pagate, coperte o annullate → Dave pubblica `TRIP_CLOSED`. Ogni viaggiatore sceglie se tenere aperto il canale per il prossimo viaggio (modello LSP) o chiuderlo e riavere i fondi on-chain. **Non esistono residui "non riscossi":** i fondi di ciascuno sono sempre stati suoi.

### 6.9 Ricarica
Avviso quando il saldo del canale di viaggio scende sotto il 20% di D. La ricarica è un **secondo canale di viaggio** [VERIFICA: splicing non supportato in RLN, quindi niente aumento del canale esistente]. Fuori dal percorso della demo.

## 7. Stati di una riga

Una riga = (spesa, debitore). Lo stato è **derivato** dagli eventi da una funzione pura del ledger (`deriveTrip(events, now)`), mai salvato a mano.

| Stato | Si entra quando | Si esce verso |
|---|---|---|
| `submitted` | `EXPENSE_SUBMITTED` | `awaiting_decision` (al `LINE_SEEN`) |
| `awaiting_decision` | `LINE_SEEN`; scadenza = seenAt + `SILENT_ASSENT_SECONDS` | `due` (approvata, o assentita entro policy), `contested`, `awaiting_explicit` (scaduta ma oltre limite) |
| `awaiting_explicit` | silenzio-assenso non applicabile | `due` (approvata), `contested`, `overdue` (dopo seenAt + `PAYMENT_DEADLINE_SECONDS`) |
| `contested` | `LINE_DECIDED{contest}` | `due` (confermata da Dave, nuova scadenza), `voided` |
| `due` | approvata, assentita o confermata | `paid`, `overdue` |
| `overdue` | scadenza superata senza pagamento, o membro escluso | `guaranteed` (copertura), `paid` (paga tardi) |
| `paid` | `PAYMENT_MADE` valido | stato finale |
| `guaranteed` | `GUARANTEE_PAID` valido | stato finale (credito dell'operatore) |
| `voided` | `DISPUTE_RESOLVED{line_voided/expense_voided}` o `EXPENSE_VOIDED` | stato finale |

La riga di chi ha pagato (la sua quota) non esiste: non deve nulla a se stesso.

## 8. La policy dell'agente (i "dollari agentici")

Ogni viaggiatore imposta i limiti del suo agente (schermata Impostazioni). Default:

| Parametro | Default | Significato |
|---|---|---|
| `autoPayLimitCents` | 2000 (20.00) | Sopra questo importo per riga, niente silenzio-assenso. |
| `dailyCapCents` | 6000 (60.00) | Totale massimo pagato in automatico in 24 ore. |
| `payUpheldDisputes` | `false` | Se paga da solo le righe contestate e poi confermate da Dave. |

L'agente **paga** una riga solo se tutte queste condizioni sono vere: è `due`; l'evento della spesa è verificato (§9.5); l'invoice è intestato al nodo del creditore registrato nel viaggio; importo e asset dell'invoice coincidono con la quota; non è oltre il tetto giornaliero (per i pagamenti automatici).

L'agente **non paga mai**: righe contestate o non verificate; spese il cui totale non torna; se il viaggio è chiuso.

Ogni decisione dell'agente è spiegata all'utente con il motivo, ad esempio: *"Pagato 3.09 ad Alice in automatico: nessuna obiezione in 20 s, sotto il tuo limite di 20.00"*, oppure *"Non pagato: 45.00 supera il tuo limite automatico. Approva tu."*

La decisione è una funzione pura del ledger: `decideAutoPay(policy, line, trip, now) → { pay: boolean, reason }`.

## 9. Il registro firmato

### 9.1 Busta e firma
L'autore firma il contenuto; il relay lo incapsula e lo concatena.

```
SignedEvent (scritto dall'autore)
  inner = { v: 1, tripId, type, author: <nodePubkey>, nonce: <16 byte hex>, createdAt: <ISO>, body: {...} }
  sig   = firma di canonical(inner)

StoredEvent (scritto dal relay)
  { seq, prevHash, signed: SignedEvent, receivedAt, hash = sha256(canonical({ seq, prevHash, signed })) }
```

- **canonical** = JSON canonico RFC 8785 (JCS); importi bigint serializzati come stringhe decimali.
- **Chi firma (motore scelto al gate 2: `rln-rest`, §14.0 e §20):**
  - **motore `rln-rest` (scelto, verificato):** `/signmessage` di RLN (`d4762ac`) firma sempre la stringa vuota, quindi **non va mai usato**. Si usa una chiave ed25519 dell'app (`appPubkey`) come `author`, legata al nodo da un invoice: in `MEMBER_JOINED` il membro include un invoice creato dal **proprio nodo** con `description` = `kitty-bind:<sha256(appPubkey)>`; il `payee_pubkey` dell'invoice diventa il `nodePubkey` del membro, e Dave verifica il legame prima di `MEMBER_ADMITTED`.
  - **motore `wdk` (scartato al gate 2):** la firma con l'identità del nodo di `@utexo/wdk-rgb-lightning` funziona (spike 2: messaggi diversi danno firme diverse, verifica in TypeScript puro, firma alterata rifiutata), ma il motore no; vedi §20.
  - Ogni controllo "invoice intestato al creditore" confronta il `payee_pubkey` con il `nodePubkey` del membro.
  - Extra (P2): correzione di `/signmessage` in un fork di RLN, con link agli organizzatori e proposta upstream.
- `nonce` + `tripId` + riferimenti espliciti (hash dell'evento della spesa, importi) rendono ogni firma inutilizzabile in un altro contesto (anti-replay).

### 9.2 Tipi di evento

| Tipo | Autore | Campi principali del `body` |
|---|---|---|
| `TRIP_CREATED` | Dave | `name`, `assetId`, `params` (§15), `coordinatorPubkey` |
| `RATE_SET` | Dave | `asOf`, `source`, `rates` (unità per 1 USD, stringhe) |
| `MEMBER_JOINED` | membro | `displayName`, `memberId`, `appPubkey`, `nodePubkey`, `bindInvoice`, `policy` |
| `MEMBER_ADMITTED` | Dave | `memberPubkey` |
| `POLICY_UPDATED` | membro | `policy` |
| `CHANNELS_READY` | Dave | `memberPubkey`, `tripChannelId`, `liquidityChannelId` |
| `EXPENSE_SUBMITTED` | pagatore | `expenseId`, `receipt` (merchant, date, currency, items, tax, tip, total), `receiptImageSha256`, `rateEventHash`, `rate`, `totalUsdCents`, `payerCents` (quota del pagatore), `payerItemIndexes` (righe dello scontrino che condivide), `lines: [{ debtorPubkey, cents, itemIndexes, bolt11 }]`, `fingerprint` |
| `LINE_SEEN` | debitore | `expenseEventHash` |
| `LINE_DECIDED` | debitore | `expenseEventHash`, `decision: approve \| contest`, `cents`, `reason?` |
| `PAYMENT_MADE` | debitore | `expenseEventHash`, `creditorPubkey`, `cents`, `rail: ln \| onchain`, `paymentHash` + `preimage` oppure `txid` |
| `EXPENSE_VOIDED` | pagatore | `expenseEventHash` (solo se nessuna riga è già pagata) |
| `DISPUTE_RESOLVED` | Dave | `expenseEventHash`, `debtorPubkey`, `outcome: upheld \| line_voided \| expense_voided`, `note` |
| `INVOICE_REISSUED` | pagatore | `expenseEventHash`, `debtorPubkey`, `bolt11` (se il precedente è scaduto) |
| `GUARANTEE_PAID` | Dave | `expenseEventHash`, `debtorPubkey`, `creditorPubkey`, `cents`, `paymentHash`, `preimage` |
| `MEMBER_EXCLUDED` | Dave | `memberPubkey`, `reason`, `closingTxids` |
| `CHECKPOINT` | chiunque | `seq`, `headHash` |
| `TRIP_CLOSED` | Dave | `summary` |

### 9.3 Validazione
Le stesse regole, in una funzione pura `validateEvent(stored, trip, deps)` del ledger, con `deps = { verify: SignatureVerifier, decodeInvoice: (bolt11) => DecodedInvoice }` iniettati (così il ledger resta puro e testabile senza B e senza un nodo), girano **sia sul relay** (che rifiuta l'evento) **sia in ogni agente** (che non si fida del relay):
- firma valida per `author`; autore ammesso al viaggio (tranne `TRIP_CREATED` e `MEMBER_JOINED`); i tipi "Dave" solo da Dave;
- `nonce` mai visto in quel viaggio;
- `EXPENSE_SUBMITTED`: totale = righe + tasse + mancia (nella valuta dello scontrino); `Σ lines.cents + payerCents = totalUsdCents`, e le quote coincidono con quelle ricalcolate dal ledger da scontrino, `itemIndexes`, `payerItemIndexes` e `rate`; i debitori sono membri attivi (non esclusi); `fingerprint` non duplicato; per ogni riga, l'invoice è decodificabile, intestato al pagatore, per l'asset del viaggio e per l'importo della riga;
- `LINE_SEEN`/`LINE_DECIDED`: l'autore è debitore di quella spesa; `cents` coincide con la riga;
- `PAYMENT_MADE`/`GUARANTEE_PAID`: `sha256(preimage) == paymentHash` dell'invoice della riga; l'importo coincide.

Decodifica degli invoice: il relay usa un decoder BOLT11 in JS; l'agente usa anche `/decodelninvoice` del proprio nodo, che restituisce `payee_pubkey`, `asset_id`, `asset_amount`, `payment_hash`, `description`, `expiry_sec`.

### 9.4 Cosa garantisce e cosa no
- **Falsificazione:** impossibile senza la chiave dell'autore.
- **Riordino o omissione:** la catena di hash li rende evidenti.
- **Storie diverse a membri diversi (equivocation):** ogni agente pubblica periodicamente `CHECKPOINT { seq, headHash }`; la UI mostra se le teste di tutti i membri coincidono. In produzione i checkpoint viaggerebbero anche fuori dal relay (messaggi onion Lightning, roadmap).
- **Censura e indisponibilità:** il relay può non consegnare. Si rileva, non si impedisce. Ogni agente conserva una copia completa.

### 9.5 "Registro verificato" in UI
Ogni telefono mostra: numero di eventi, firme valide su totali, catena valida, hash di testa abbreviato, e "uguale su N/N telefoni".

## 10. Pagamenti

### 10.1 Rail Lightning (principale)
- Il creditore crea l'invoice con `/lninvoice` (`asset_id`, `asset_amount`, `amt_msat` ≥ `rgb_htlc_min_msat`, `description`, `expiry_sec`).
- Il debitore paga con `/sendpayment` e interroga `/getpayment` ogni 250 ms (timeout 30 s) fino a `Succeeded` o `Failed`; la `preimage` è in `Payment.preimage`, anche lato pagatore. Latenza misurata: 3,4 s, nessun blocco.
- Instradamento: canale di viaggio del debitore → Dave → canale di liquidità del creditore. Commissioni di instradamento 0 nella demo. Canali **pubblici** (la ricezione su canale privato non è verificata).
- **I sat che viaggiano con i DUSD.** In RGB su Lightning ogni pagamento in sospeso (HTLC) deve corrispondere a un output Bitcoin vero nella transazione di impegno del canale, perché è lì che RGB "appoggia" i DUSD se il canale viene chiuso in quel momento. Un output sotto la soglia di polvere non esiste on-chain, quindi RLN impone un minimo: `rgb_htlc_min_msat` = 3,000,000 msat = **3000 sat per pagamento**. Non sono commissioni né gas: passano dal pagatore al ricevente insieme ai DUSD (misurato nello spike) e seguono gli stessi flussi. Chi paga deve però avere BTC nel canale: un canale da C sat regge circa `C / 3000` pagamenti in uscita prima di dover ricevere qualcosa.
- **Pagamenti in volo.** Il limite di 483 HTLC del protocollo è sul **numero**. Quello osservato nello spike è sul **valore**: LDK accetta in volo al massimo una percentuale della capacità del canale (10% per default; 10,000,000 msat su 100,000 sat, misurato). Con 3000 sat a HTLC fanno 3 pagamenti in volo. Dipende dalla capacità che scegliamo: con **1,000,000 sat** diventano 33 in volo e circa 330 pagamenti in uscita. In ogni caso l'agente mette in coda i pagamenti di uno stesso membro.
- **Invoice scaduto:** `/sendpayment` risponde HTTP 200 con `status: "Failed"`. L'agente controlla `timestamp + expiry_sec` **prima** di pagare; se scaduto, il creditore pubblica `INVOICE_REISSUED`.

### 10.2 Prova di pagamento
`{ rail: "ln", paymentHash, preimage, cents, payeePubkey }`. Verificabile da chiunque abbia l'invoice: `sha256(preimage) == paymentHash` e l'invoice è firmato dal nodo del creditore. Nel pannello Prova: "Verificato ✓" con i tre controlli esplicitati.

### 10.3 Rail on-chain (fallback)
Il rail RGB on-chain già funzionante nel vecchio progetto (`/rgbinvoice` del ricevente, `/sendrgb` del pagatore, mining, `/refreshtransfers`). Prova: `txid` e link a esplora REST `/tx/<txid>`. Si usa:
- per pagare un membro escluso (che non ha più canali);
- in **modalità on-chain** completa se lo spike Lightning fallisce (§19).

### 10.4 Modalità di funzionamento [D: **`ln-2ch`**, scelta al gate del 16/10]
| Modalità | Quando | Cosa cambia |
|---|---|---|
| `ln-2ch` (preferita) | Due canali tra la stessa coppia funzionano | Come descritto sopra. |
| `ln-lsp` | Un solo canale per coppia | Il viaggiatore paga D on-chain a Dave; Dave apre un canale con D + L e `push_asset_amount = D`. Finestra di custodia di pochi minuti alla prenotazione (modello LSP "compra un canale"): **va detto**. |
| `onchain` | Il routing RGB Lightning non funziona entro il gate | Niente canali: ogni riga si paga con un trasferimento RGB on-chain diretto debitore → creditore. Resta tutto il resto (AI, registro, policy, garanzia, esclusione come blocco nel viaggio). Lightning va in roadmap. |

Il codice usa un'interfaccia `Rail` unica, così la modalità è una variabile di configurazione (`KITTY_RAIL_MODE`).

**Perché due canali e non uno con i fondi di entrambi.** Il protocollo Lightning prevede i canali a doppio finanziamento (entrambe le parti mettono fondi nella transazione di apertura), ma l'API di RLN non li espone: `/openchannel` accetta solo i fondi di chi apre, più un eventuale `push`, che però è un regalo all'altra parte. Per RGB servirebbe anche un'allocazione dell'asset da entrambi i lati nella stessa transazione. Fare un solo canale significherebbe quindi o un regalo, o un pagamento preventivo a Dave (custodia temporanea, la modalità `ln-lsp`). Due canali danno lo stesso risultato senza fiducia.

### 10.5 Quanta liquidità deve mettere Dave [D]
Dal punto di vista di un membro m, i suoi due canali con Dave si comportano come un unico serbatoio. Quanto m può **ricevere** in un dato momento è il saldo di Dave sui canali di m:

`inbound(m, t) = L(m) + inviato(m, t) − ricevuto(m, t)`

Ogni pagamento che m fa aumenta la parte di Dave sul suo canale di viaggio, quindi gli restituisce capacità di ricevere. Il fabbisogno è dunque **il credito netto di picco** di m: `L(m) ≥ max_t (ricevuto(m, t) − inviato(m, t))`. Le coperture della garanzia contano come "ricevuto".

Questo valore è **deterministico e noto in anticipo**, perché il ledger conosce ogni spesa prima che venga pagata (tra l'invio e il pagamento c'è il silenzio-assenso). Regola dell'agente di Dave:
1. `margine(m) = inbound(m) − daRicevere(m)`, dove `daRicevere(m)` è la somma delle righe aperte (non pagate, non annullate) a favore di m.
2. Se `margine(m) < soglia`, Dave apre **subito** un nuovo canale di liquidità verso m, per `daRicevere(m) − margine(m) + soglia`. In produzione l'apertura richiede circa un'ora (6 conferme), meno delle 12 ore di silenzio-assenso; su regtest è immediata.
3. La funzione `liquidityPlan(trip)` sta nel ledger (funzione pura, testata); l'agente di Dave la esegue a ogni evento.

L iniziale è solo il punto di partenza: un tetto deterministico e prudente è la spesa di gruppo più grande prevedibile moltiplicata per (n−1)/n; con i dati storici dell'operatore (spese comuni dei viaggi passati) si sceglie il percentile 90 del credito netto di picco per viaggiatore e si lascia il resto alla regola 2. Il capitale immobilizzato da Dave è Σ L(m) più le aperture successive, e torna tutto a lui alla chiusura dei canali. Nella demo L = 30.00 basta (Alice riceve 6.59).

## 11. AI locale (QVAC)

Tre compiti, ognuno con uno schema zod in `@kitty/shared`:

1. **Estrazione dello scontrino:** immagine → OCR QVAC → testo → LLM → `Receipt { merchant, date, currency, items: [{ label, quantity, unitPrice, total }], subtotal?, tax?, tip?, total, warnings[] }`. Controlli deterministici dopo zod: righe + tasse + mancia = totale; valuta nota; data dentro il viaggio. Se non torna: avviso visibile, mai correzione silenziosa.
2. **Divisione da linguaggio naturale:** input = righe + nomi dei **viaggiatori attivi** (mai Dave, mai esclusi) + frase in italiano o inglese → `SplitProposal { assignments: [{ itemIndex, members: string[] }], unassigned: number[], clarificationNeeded? }`. Nome sconosciuto o indice fuori range = errore di validazione.
3. **Ambiguità:** se c'è `clarificationNeeded`, la UI fa la domanda e la risposta viene passata una volta al modello.

Regole [D]:
- Ogni output passa da zod; al massimo 2 tentativi con l'errore passato al modello, poi modulo manuale precompilato. L'app non si blocca mai per un JSON sbagliato.
- Togliere i blocchi di codice e il blocco `<think></think>` vuoto che Qwen3 emette.
- **I soldi li calcola il ledger, mai l'LLM.** L'LLM propone righe e assegnazioni; quote, cambi e arrotondamenti sono codice deterministico con test.
- **Prompt injection:** la frase di divisione e il testo dello scontrino sono input non fidati. Il prompt di sistema dice al modello di trattarli come dati; l'output è vincolato a membri e indici esistenti; il debitore approva **righe e importi risultanti**, mai la frase.
- Modelli caricati una volta all'avvio dell'agente; stato esposto (`loading | ready | error`) e mostrato in UI con "Gira su questo dispositivo".
- Modelli: quelli già in cache nel vecchio progetto (OCR latino, Qwen3 1.7B instruct Q4; Qwen3 0.6B come alternativa veloce). Le costanti esatte si prendono da `docs/vendor/QVAC.md`, mai a memoria. `@qvac/sdk` fissato a `~0.21.0`.
- Funziona con il Wi-Fi spento.

## 12. Backup e telefono perso o rubato [D: P1]

**Il problema:** con RGB la mnemonica non basta a recuperare i fondi. Lo dice la stessa API di RLN (`/init`): *"a mnemonic alone is not sufficient to recover RGB state, which also requires client-side data"*. Senza lo stash, chi perde il telefono perde i DUSD.

**La soluzione:**
1. **Motore `rln-rest` (scelto, verificato):** `/backup` funziona **solo a nodo bloccato**: `/lock` → `/backup` → `/unlock`, rimandato finché il nodo è inattivo da 10 s, con i pagamenti in coda nel frattempo (per Dave mai durante un pagamento). Il file (≈440 KB, include i canali LDK) finisce in un volume condiviso `/backups` e l'agente lo carica sul relay (`PUT /backups/:pubkey`), che non può leggerlo. Ripristino su un nodo **mai inizializzato**: `/restore` → `/unlock` (verificato: stessa pubkey, canali usabili, instrada pagamenti).
2. **VSS (motore `wdk`, non usato):** `vssBackup()` funziona a nodo acceso (circa 60 ms), ma nello spike 2 il ripristino da VSS si blocca allo sblocco: un backup senza ripristino non serve alla demo. Roadmap (§18).
3. Dopo il ripristino l'agente riscarica il registro dal relay e verifica tutto. **Il nodo vecchio non deve mai tornare online.**
4. **Rischio specifico di Lightning:** ripristinare uno stato di canale **vecchio** e usarlo può essere punito come frode. Per questo il backup si aggiorna a ogni pagamento, e il ripristino usa sempre l'ultimo. Alternativa sicura, sempre disponibile: chiedere a Dave la chiusura cooperativa dei canali. Dave ha interesse a collaborare.
5. **Telefono rubato:** il danno massimo è limitato da `autoPayLimitCents` e `dailyCapCents`; un'approvazione sopra limite richiede sblocco del dispositivo (roadmap: biometria). Il viaggiatore può chiedere a Dave di chiudere subito i canali.

Demo (P1): `pnpm demo:lose-phone bob` cancella il nodo di Bob, ne avvia uno nuovo, lo ripristina dal backup sul relay e mostra lo stesso saldo di prima.

## 13. Sicurezza: attacchi considerati

Priorità: **P0** = nella demo; **P1** = se c'è tempo, altrimenti nelle slide; **R** = roadmap, solo nelle slide.

| # | Attacco | Difesa | Dove | Pri |
|---|---|---|---|---|
| 1 | Server o rete sostituisce l'invoice del creditore | L'agente paga solo se `payee_pubkey` dell'invoice = nodo del creditore registrato | `ledger/validate`, `agent` | P0 |
| 2 | Relay inventa o modifica eventi | Firme di ogni autore | `shared/crypto`, `relay`, `agent` | P0 |
| 3 | Firma riusata in un altro contesto (replay) | `nonce`, `tripId`, hash della spesa e importo dentro la firma | `shared`, `ledger/validate` | P0 |
| 4 | Silenzio-assenso abusato (spesa caricata di notte) | Scadenza da `LINE_SEEN`; limite per riga; tetto giornaliero | `ledger/policy` | P0 |
| 5 | Scontrino duplicato | `fingerprint` = sha256(merchant, data, valuta, totale, hash foto); duplicati rifiutati | `ledger/validate` | P0 |
| 6 | Prompt injection nella frase o nello scontrino | Output vincolato da zod a membri e indici; il debitore approva gli importi, non la frase | `agent/ai` | P0 |
| 7 | Debitore che non paga o sparisce | Scadenza → garanzia dell'operatore → esclusione | `ledger`, `agent/flows`, UI Dave | P0 |
| 8 | Contestare tutto per non pagare | Dave decide; chi abusa viene escluso | UI Dave | P0 |
| 9 | Scontrino falso o gonfiato | Hash della foto impegnato nell'evento; Dave può chiedere la foto; esclusione | flusso | P0 (manuale) |
| 10 | Dave manipola il tasso di cambio | `RATE_SET` firmato con fonte e data; tasso bloccato all'invio; contestabile | `ledger` | P0 |
| 11 | Dave annulla spese legittime | Ogni annullamento è un evento firmato visibile a tutti | registro | P0 |
| 12 | Relay mostra storie diverse a membri diversi | `CHECKPOINT` e confronto delle teste in UI | `agent`, UI | P1 |
| 13 | API del nodo esposta | Porte RLN legate a `127.0.0.1`; in produzione token Biscuit (supportati da RLN) | `infra` | P0 |
| 14 | Telefono perso | Backup cifrato automatico + ripristino | §12 | P1 |
| 15 | Telefono rubato | Limiti di policy; chiusura canali su richiesta; sblocco per importi alti | §12 | P1 / R |
| 16 | Dave pubblica uno stato vecchio del canale | Watchtower indipendente dall'operatore | | R |
| 17 | Dave rifiuta di instradare | Il viaggiatore chiude il canale ed esce; rail on-chain diretto | rail | P1 |
| 18 | Dave vede tutti i pagamenti (sorveglianza) | Ammesso; più hub e percorsi ciechi | | R |
| 20 | Firma del nodo riusata per impersonare un membro (`/signmessage` firma sempre la stringa vuota) | `/signmessage` mai usato; firme ed25519 dell'app legate al nodo da un invoice | `shared/crypto`, `ledger/validate` | P0 |
| 19 | Modello AI manomesso | Hash dei file GGUF verificato all'avvio | `agent/ai` | P1 |

Frase per la giuria: **"Dave può essere fastidioso, ma non può rubare."**

## 14. Architettura

### 14.0 Il wallet di ogni membro: motore misto [D, gate 2]
- **Nodi Lightning: `rgb-lightning-node` (`d4762ac`) via REST**, uno per membro (alice, bob, charlie, dave), in Docker. Canali, invoice, pagamenti, chiusure con sweep dei DUSD e backup lock → backup → unlock: tutto verificato nello spike 1 (`docs/spike-lightning.md`). Ogni membro ha la mnemonica del proprio nodo.
- **Tesoreria on-chain di Dave: `@utexo/wdk-wallet-rgb` `2.0.3`** (rgb-lib): emette il DUSD (NIA, precisione 2) e fa l'on-ramp verso i nodi RLN dei viaggiatori. Il processo che lo importa gira su **Node 22** (il binario rgb-lib non compila su Node 24), e il binario `@utexo/rgb-lib` della piattaforma della macchina demo va dichiarato esplicitamente in `package.json` (altrimenti npm lo salta in silenzio). [VERIFICA: trasferimento da `wdk-wallet-rgb` a un invoice di un nodo RLN REST; nello spike 2 è provato solo verso nodi `wdk`, con lo stesso formato di invoice.]

| Motore | Cosa è | Stato |
|---|---|---|
| `wdk` | `@utexo/wdk-rgb-lightning` in-process, un nodo per membro | **scartato al gate 2** (`0.1.0-beta.15`: firmatore non persistente, nessuno sweep dopo la chiusura, ripristino VSS bloccato; roadmap §18) |
| `rln-rest` | `rgb-lightning-node` in Docker via REST (`d4762ac`) | **scelto**, verificato nello spike 1 |

L'interfaccia `Wallet` (§14.2) nasconde il motore: ledger, relay, flussi e UI non cambiano. Variabile `KITTY_WALLET_ENGINE`.

Esito dello spike 2 e opzioni valutate al gate: `docs/spike-wdk.md`.

```
 apps/web (React+Vite, ?as=alice|bob|charlie|dave)      tre finestre a larghezza telefono
        │ HTTP, polling 1 s
        ▼
 apps/agent (Fastify :4100)  ── un'istanza Agent per membro, ognuna con SOLO il suo wallet e il suo seed
   ├─ ai/      QVAC in-process (caricato una volta, usato dall'agente di chi paga)
   ├─ wallet/  Wallet per membro: RLN via REST (nodo in Docker) + tesoreria wdk-wallet-rgb di Dave
   ├─ rail/    LightningRail | OnchainRail (KITTY_RAIL_MODE)
   ├─ flows/   spesa, decisioni, loop dell'agente (seen, policy, pagamento, checkpoint), azioni di Dave
   └─ routes/  API per la UI
        │ HTTP + SSE                                   │ REST
        ▼                                              ▼
 apps/relay (Fastify :4000)                    docker compose regtest: bitcoind, electrs (+ REST esplora :3010),
   SQLite append-only, verifica firme,         rgb-proxy-server :3000;
   catena di hash, SSE                         4× rgb-lightning-node (3001-3004)
                                               (porte su 127.0.0.1)
```

**Onestà sulla demo:** i quattro agenti girano nello stesso processo per non caricare quattro volte i modelli AI, ma ogni istanza riceve soltanto il client del proprio nodo; i quattro nodi girano su un portatile. In produzione l'agente e il nodo stanno sul telefono del viaggiatore.

### 14.1 Struttura del repository
```
kit-ty/
├─ CLAUDE.md                 regole per Claude Code (caricato da solo)
├─ docs/
│  ├─ SPEC.md  PLAN.md  SETUP.md  PITCH.md
│  ├─ spike-lightning.md     risultati dello spike (scritto da B)
│  ├─ prompts/               prompt di avvio delle sessioni Claude Code
│  ├─ status/                avanzamento per stream (a.md, b.md, c.md)
│  └─ vendor/                QVAC.md, rln-openapi.yaml (riferimenti API)
├─ packages/
│  ├─ shared/     zod: id, denaro, eventi, API, viste; JSON canonico, sha256, verifica firme
│  ├─ ledger/     funzioni pure: cambi, divisione, deriveTrip, validateEvent, decideAutoPay
│  └─ rln-client/ client tipizzato generato da rln-openapi.yaml
├─ apps/  relay/  agent/  web/
├─ infra/         docker-compose, script, rates.json, fixtures scontrini
├─ spikes/        esperimenti a tempo; mai importati dalle app
└─ _legacy/       codice del vecchio progetto da cui copiare; MAI importato; cancellato domenica
```

### 14.2 Interfacce (fissate nella sessione contratto)
```ts
interface Wallet {                         // B — apps/agent/src/wallet
  engine: 'wdk' | 'rln-rest'
  nodePubkey(): Promise<string>
  authorPubkey(): Promise<string>                    // = appPubkey ed25519 con rln-rest (scelto); = nodePubkey con wdk (non usato in demo)
  sign(message: string): Promise<string>             // ed25519 (rln-rest) o firma nativa del nodo (wdk, non usato in demo), §9.1
  bindInvoice(appPubkey: string): Promise<string | null>   // rln-rest: invoice di legame; null con wdk (non usato in demo)
  createInvoice(p: { cents: bigint; description: string; expirySec: number }): Promise<{ bolt11: string; paymentHash: string }>
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>      // payeePubkey, paymentHash, assetId, cents, description, expiresAt
  pay(bolt11: string, opts?: { timeoutMs?: number }): Promise<PaymentProof>
  balances(): Promise<{ tripOutboundCents: bigint; inboundCents: bigint; onchainCents: bigint }>
  openLiquidity(peerPubkey: string, cents: bigint): Promise<{ channelId: string }>   // solo Dave, §10.5
  closeChannelsWith(peerPubkey: string): Promise<{ txids: string[] }>   // solo Dave
  backupNow(): Promise<{ version: string }>                             // lock-backup-unlock (rln-rest) o VSS (wdk, non usato in demo)
}
interface SignatureVerifier {              // B — packages/shared/src/crypto.ts; usato da relay e ledger
  verify(authorPubkey: string, message: string, signature: string): boolean
}
interface AiService {                      // A — apps/agent/src/ai
  status(): 'loading' | 'ready' | 'error'
  extractReceipt(image: Uint8Array): Promise<AiResult<Receipt>>
  proposeSplit(receipt: Receipt, members: string[], text: string): Promise<AiResult<SplitProposal>>
}
interface RelayClient {                    // C — apps/agent/src/relay
  append(e: SignedEvent): Promise<StoredEvent>
  list(sinceSeq?: number): Promise<StoredEvent[]>
  subscribe(onEvent: (e: StoredEvent) => void): () => void
  putBackup(pubkey: string, blob: Uint8Array): Promise<void>
  getBackup(pubkey: string): Promise<Uint8Array | null>
}
```
Il motore `wdk` resta nell'unione di `engine` per non cambiare il contratto, ma non è usato in demo (§20). Emissione e on-ramp dei DUSD non passano da `Wallet`: li fa il seed (B2) con `wdk-wallet-rgb` sulla tesoreria di Dave (§14.0).

Esistono dei **fake** (`FakeWallet`, `FakeAi`) per sviluppare in parallelo, attivi solo con `KITTY_FAKES=1`, con un banner visibile, e vietati da `demo:reset` (`assertNoFakes()`).

### 14.3 API dell'agente per la UI
Ogni richiesta porta il ruolo nel percorso (`/api/:as/...`). Importi come stringhe decimali di centesimi.

| Metodo e percorso | Chi | Cosa |
|---|---|---|
| `GET /api/:as/state` | tutti | `TripView`: membri, mio saldo, mie righe, spese, contestazioni e insolvenze (Dave), stato AI, verifica del registro |
| `POST /api/:as/expenses/extract` | viaggiatore | immagine → `AiResult<Receipt>` |
| `POST /api/:as/expenses/split` | viaggiatore | `{ receipt, text }` → `AiResult<SplitProposal>` + anteprima quote dal ledger |
| `POST /api/:as/expenses` | viaggiatore | invia la spesa (crea invoice, firma, pubblica) |
| `POST /api/:as/expenses/:id/decision` | debitore | `{ decision, reason? }` |
| `POST /api/:as/expenses/:id/void` | pagatore | annulla prima di qualsiasi pagamento |
| `PUT /api/:as/policy` | viaggiatore | limiti dell'agente |
| `POST /api/dave/disputes/:expenseId/:member` | Dave | `{ outcome, note }` |
| `POST /api/dave/defaults/:expenseId/:member/cover-and-exclude` | Dave | garanzia + esclusione |
| `PUT /api/dave/rates` | Dave | tasso del giorno |
| `GET /api/proof/:paymentHash` | tutti | prova di pagamento verificata, passo per passo |

## 15. Parametri e numeri della demo

| Parametro | Demo | Produzione (indicativo) |
|---|---|---|
| D, canale di viaggio | 50.00 DUSD (5000 unità) | scelto dal viaggiatore |
| L, liquidità iniziale di Dave per viaggiatore | 30.00 DUSD | percentile 90 storico, poi regola di §10.5 |
| On-ramp nel seed | 100.00 DUSD a viaggiatore | acquisto alla prenotazione |
| Emissione DUSD | 10,000.00 sul nodo di Dave | USDT di Tether |
| `SILENT_ASSENT_SECONDS` | 20 | 12 ore |
| `PAYMENT_DEADLINE_SECONDS` | 30 | 24 ore |
| `INVOICE_EXPIRY_SECONDS` | 3600 | 48 ore |
| G, garanzia per membro | 50.00 | scelta dall'operatore |
| Capacità BTC dei canali | 1,000,000 sat (≈330 pagamenti in uscita, 33 in volo) | dimensionata dall'operatore |
| Blocchi per aprire i canali | 6 (si minano in un colpo dopo tutte le aperture) | |
| Blocchi per chiudere e vedere i DUSD | 1 + ~6 di sweep, poi `/refreshtransfers` (budget 12) | |
| Tasso | 26,350 VND per 1 USD (`infra/rates.json`, valori plausibili, non di mercato) | fonte pubblica |

**La cena:** 255,000 VND = 9.68 USD. Quote: Alice 3.09, Bob 3.09, Charlie 3.50 (pho Alice + Bob, birre Charlie, acqua in tre, mancia proporzionale; numeri già testati nel vecchio ledger).

## 16. La demo (circa 3 minuti)

Prima di salire sul palco: `pnpm demo:reset` (catena da zero, seed, on-ramp, canali aperti, viaggio "Vietnam 2026" creato). Sullo schermo: tre finestre a larghezza telefono, Alice, Charlie e Dave; Bob in una quarta finestra più piccola, o mostrato al passo 3.

1. **Viaggio:** "Ognuno ha 50.00 nel suo canale. Solo lui può spenderli. Nessuno tiene i soldi di nessuno."
2. **Alice** fotografa lo scontrino → "Lettura sul dispositivo…" (tempo trascorso) → righe modificabili → scrive la frase → quote per persona → Invia.
3. **Bob** non tocca nulla: conto alla rovescia di 20 s → *"Il tuo agente ha pagato 3.09 ad Alice: nessuna obiezione, sotto il tuo limite di 20.00"* → pannello Prova: preimage verificata, **nessun blocco minato**.
4. **Charlie** contesta: "Ho preso solo acqua".
5. **Dave** vede la contestazione con le righe estratte dall'AI; Alice gli mostra la foto; Dave conferma la riga.
6. Charlie non paga entro 30 s → compare tra le insolvenze → Dave: **"Copri ed escludi"** → il nodo di Dave paga 3.50 ad Alice sullo stesso invoice → i canali di Charlie si chiudono → link a esplora con il txid di chiusura.
7. **Alice:** "Rimborsata 6.59: 3.09 da Bob, 3.50 garantiti dall'operatore". Tutti i telefoni: "Registro verificato ✓, uguale su 4/4".
8. (P1) **Bob perde il telefono:** `demo:lose-phone bob` → ripristino dal backup cifrato → saldo 46.91 di nuovo lì.

Chiusura: **"Nessuno ha custodito i soldi di nessuno. Alice è stata rimborsata in pochi secondi. Charlie se n'è andato con i suoi soldi, e l'operatore, che lo conosce, ha coperto il buco."**

Saldi attesi dopo il passo 7: Alice 50.00 nel canale di viaggio + 6.59 ricevuti; Bob 46.91; Charlie canali chiusi, 50.00 tornati a lui on-chain (più i suoi 50.00 on-chain del seed); Dave −6.59 di liquidità verso Alice, +3.09 nel canale di Bob, credito di 3.50 verso Charlie.

## 17. Cosa è reale e cosa no (va nel README)

**Reale:** ogni pagamento, apertura e chiusura di canale è una vera operazione RGB su Bitcoin regtest; firme e catena di hash; AI in locale con il Wi-Fi spento.
**Semplificato:** quattro nodi e quattro agenti su un portatile; relay locale; DUSD al posto di USDT; on-ramp simulato dal seed; foto della contestazione mostrata di persona.

## 18. Fuori scope e roadmap

Non si costruisce: watchtower, più hub, splicing, relay P2P via messaggi onion, invio cifrato della foto, app mobile (il percorso è `@utexo/rgb-sdk-rn` o il modulo WDK su Bare), multisig, LSP e canali virtuali di UTEXO. **Roadmap WDK:** `@utexo/wdk-rgb-lightning` come nodo di ogni membro (in-process, anche su mobile) con backup VSS, quando saranno pubblicate su npm le correzioni upstream (firmatore persistente `createWithStorage`, sweep dei DUSD dopo la chiusura, ripristino VSS). Oggi in demo WDK è la tesoreria on-chain di Dave (§14.0).

## 19. Domande dello spike (chiuse il 16/10)

Risposte complete, con le richieste esatte che funzionano, in `docs/spike-lightning.md`. Esito: 1-5, 7, 9, 10 ✅; 6 ⚠️ (`/signmessage` inutilizzabile → ed25519); 8 ⚠️ (backup solo a nodo bloccato). Non verificati: ricezione su canale privato, aperture parallele dal nodo di Dave, chiusura forzata.

Domande originali:

1. Apertura di un canale RGB con DUSD tra viaggiatore e Dave su regtest: parametri che funzionano, conferme necessarie.
2. Due canali tra la stessa coppia di nodi (uno per verso)?
3. Pagamento instradato Alice → Dave → Bob con DUSD: funziona? Canali pubblici o privati?
4. `preimage` disponibile sul lato del pagatore (`/getpayment`)?
5. `/decodelninvoice.payee_pubkey` = pubkey del nodo del creditore?
6. Formato di `/signmessage` e verifica in TypeScript.
7. Chiusura cooperativa di un canale RGB: blocchi necessari, dove finiscono i DUSD, come li vede il viaggiatore.
8. `/backup` e `/restore`: con nodo sbloccato o bloccato, dove scrive, cosa include.
9. `rgb_htlc_min_msat`, BTC spostati per pagamento, quanti pagamenti regge un canale da 100,000 sat.
10. Latenza di un pagamento; comportamento con invoice scaduto.

### Spike 2: motore WDK (venerdì pomeriggio, `docs/prompts/02-spike-wdk.md`)
Domande: installazione dei moduli e delle librerie native sulla macchina della demo; più nodi in un processo; canale RGB e pagamento instradato tra nodi `wdk` (e, se serve, tra `wdk` e `rln-rest`); preimage e `payee_pubkey`; firma e verifica dei messaggi; server VSS locale, backup e ripristino; convivenza di `wdk-wallet-rgb` e `wdk-rgb-lightning` con lo stesso seed; emissione DUSD con `wdk-wallet-rgb` e trasferimento al nodo Lightning.
**Regola del gate 2:** canale + pagamento instradato + preimage tra nodi `wdk` verdi → motore `wdk`. Firma o VSS rossi da soli non bastano a scartarlo: si usano i fallback di §9.1 e §12. Altrimenti motore `rln-rest`, già verificato.
**Esito (16/10, `docs/spike-wdk.md`):** canale, pagamento instradato e preimage tra nodi `wdk` verdi solo in forma `ln-lsp`; stato del firmatore perso al riavvio, nessuno sweep dei DUSD dopo la chiusura, ripristino VSS bloccato allo sblocco. Quindi motore `rln-rest`, con `wdk-wallet-rgb` per i DUSD di Dave (§20).

**Regola del gate 1 (venerdì 13:30):** 1, 3, 4 e 5 verdi → modalità Lightning (`ln-2ch` se anche 2 è verde, altrimenti `ln-lsp`). Altrimenti modalità `onchain`, senza discussioni.

## 20. Registro decisioni

| Data | Decisione | Perché |
|---|---|---|
| 16/10 | Abbandonata la cassa custodiale di Dave; canali Lightning RGB, uno per viaggiatore verso l'operatore | Giuria orientata alla self-custody; uso più profondo di RGB |
| 16/10 | Garanzia dell'operatore fino a G, poi esclusione | Recupera la certezza del rimborso senza custodia |
| 16/10 | Registro firmato su relay "postino", catena di hash, checkpoint | Nessuna fiducia nel server per i contenuti |
| 16/10 | Silenzio-assenso da `LINE_SEEN`, solo sotto i limiti della policy | Difesa dall'abuso e dal "l'AI ha pagato al posto mio" |
| 16/10 | Backup cifrato automatico dello stash sul relay | Con RGB la mnemonica non basta |
| 16/10 | Repo nuovo `kit-ty`; il codice utile del vecchio progetto si copia da `_legacy/` | Più veloce che ristrutturare |
| 16/10 | Gate: modalità **`ln-2ch`** (canale di viaggio + canale di liquidità, pubblici) | Spike: apertura, routing in 3,4 s senza blocchi, preimage e payee verificati |
| 16/10 | Pagamenti serializzati per membro; controllo della scadenza dell'invoice prima di pagare | Limite di valore in volo; invoice scaduto = `Failed` con HTTP 200 |
| 16/10 | WDK nativo come wallet di ogni membro: `wdk-rgb-lightning` (canali, firma, VSS) + `wdk-wallet-rgb` (on-chain, emissione); `rln-rest` come fallback | Richiesta del team: WDK e VSS nativi, non aggiunti dopo; bonus WDK centrale |
| 16/10 | Firma degli eventi con l'identità del nodo (motore `wdk`); ed25519 + invoice di legame solo con `rln-rest` | `/signmessage` REST di RLN firma la stringa vuota |
| 16/10 | Backup con VSS (motore `wdk`); lock → backup → unlock solo con `rln-rest` | VSS è il meccanismo nativo; `/backup` REST richiede il nodo bloccato |
| 16/10 | Liquidità di Dave calcolata dal ledger (`liquidityPlan`) e aperta just-in-time | Il fabbisogno è deterministico: credito netto di picco più righe aperte |
| 16/10 | Canali da 1,000,000 sat in demo | 3 pagamenti in volo e 32 in uscita con 100,000 sat erano un effetto della capacità, non del protocollo |
| 16/10 | **Gate 2, opzione A di `docs/spike-wdk.md` (motore misto).** Nodi Lightning: motore **`rln-rest`** (RLN `d4762ac` via REST, modalità `ln-2ch`). `@utexo/wdk-wallet-rgb` (`2.0.3`) **solo** per emissione e on-ramp dei DUSD di Dave, nel processo che lo importa su **Node 22**. Firma degli eventi: **ed25519 + invoice di legame**. Backup: **lock → backup → unlock** sul relay. **Supera** le tre righe precedenti "WDK nativo come wallet di ogni membro…", "Firma degli eventi con l'identità del nodo…" e "Backup con VSS…" | Spike 2 con `wdk-rgb-lightning` `0.1.0-beta.15`: lo stato del firmatore VLS non sopravvive a un riavvio (chiusure bloccate, un nodo non più sbloccabile); la chiusura cooperativa non restituisce i DUSD on-chain (nessuno sweep, passi 6-7 della demo impossibili); il ripristino da VSS si blocca allo sblocco. In più il routing funziona solo in forma `ln-lsp`. Le correzioni upstream non sono su npm e richiederebbero di cambiare le versioni fissate. `rln-rest` è già verificato end to end nello spike 1 |
