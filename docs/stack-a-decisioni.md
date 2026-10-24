# kit+ty Stack A: decisioni e piano

> **Documento di passaggio per una nuova chat.** Riassume le decisioni prese dal team il 21 ottobre 2026 sullo Stack A (nodo WDK sul telefono, LSP Utexo, registro su Nostr, nessun operatore centrale). Sostituisce le parti dello SPEC (repository `kit-ty`, `docs/SPEC.md`) che descrivono Dave come nodo centrale: quelle sono superate e vanno ignorate.
>
> **Aggiornato il 22/10/2026** con i punti 1-7 di `docs/proposte/aggiornamenti-documento-team.md`; ogni punto è segnato con "aggiornato il 22/10".
>
> **Aggiornato il 23/10/2026** con le decisioni del 23/10 (Dave solo LSP, chiusura del viaggio, contestazioni a maggioranza); ogni punto è segnato con "aggiornato il 23/10".

Lo Stack A si può costruire: le regole del gruppo sono decise, la parte che manca dipende da Utexo.

## Decisioni del team

Nessun membro ha poteri speciali: ognuno firma solo per sé, e le regole valgono uguali per tutti.

| Tema | Decisione |
| --- | --- |
| Telefono spento | Il pagamento riparte da solo quando entrambi hanno l'app aperta. Il pagamento in attesa sull'LSP va in roadmap, quando Utexo lo renderà possibile |
| Contestazioni | A maggioranza, regola provvisoria: su una riga contestata votano i membri attivi tranne creditore e debitore, con esito "dovuta" o "annullata". Decide più della metà dei votanti, contati su ciò che il voto decisivo conosceva, come per l'esclusione; l'esito è definitivo. Finché la maggioranza non c'è la riga resta contestata e nessuno la paga in automatico: il debitore può sempre ritirare la contestazione e il creditore può annullare la spesa. Se il debitore approva in concorrenza con "annullata", vale l'approvazione. Una riga dovuta per voto si paga solo quando il debitore la approva o la paga a mano. Limiti dichiarati: dipende da D3 (Sybil); in un gruppo di tre c'è un solo votante. Il modello definitivo è ancora da decidere. *(aggiornato il 23/10)* |
| Ingresso | Basta l'invito di un membro. Ogni invito vale per un solo ingresso. *(aggiornato il 22/10)* |
| Cambio valuta | L'app scarica il cambio dall'oracolo quando c'è rete e lo salva. Alla spesa usa l'ultimo salvato, scritto con la sua data. Avviso se è vecchio |
| Blocco | Se Bob blocca Alice, da quel momento non possono esserci spese in cui uno dei due paga e l'altro è debitore, in nessuna delle due direzioni. Una spesa pagata da un terzo con entrambi tra i debitori resta possibile. I debiti precedenti al blocco restano e si saldano normalmente. *(aggiornato il 22/10)* Il blocco è visibile a tutti; lo toglie solo chi l'ha messo, quando vuole. *(aggiornato il 22/10)* |
| Esclusione | Automatica quando più della metà degli altri membri attivi blocca qualcuno. Definitiva: resta anche se poi qualcuno sblocca; per rientrare serve un nuovo invito. Una spesa resta valida se l'esclusione non era nota a chi l'ha scritta, come per il blocco. Quando qualcuno blocca, l'app avvisa che il blocco conta anche per l'esclusione. Limite dichiarato: la regola dipende da D3 (Sybil), ancora aperta: con membri finti una persona sola può raggiungere la maggioranza. *(aggiornato il 22/10)* |
| Debiti verso chi è bloccato o escluso | Restano. Niente pagamento automatico: si paga a mano |
| Debiti di chi è bloccato o escluso | Può sempre saldarli. I debiti dell'escluso restano e si pagano a mano; sulle righe arrivate dopo l'esclusione il silenzio-assenso non vale, come dopo l'uscita. *(aggiornato il 22/10)* |
| Uscita | Un messaggio firmato "esco", quando non hai più debiti noti. *(aggiornato il 22/10)* Si può uscire anche con crediti da incassare. I soldi non si muovono. Conseguenza dichiarata: anche una riga contestata è un debito noto, quindi finché la contestazione resta aperta non si esce. *(aggiornato il 22/10)* Conseguenza dichiarata: chi esce con crediti ancora aperti li incassa fuori dall'app, perché i suoi canali vengono chiusi; prima dell'uscita l'app elenca quei crediti, da chi e quanto. *(aggiornato il 23/10)* |
| Fine del viaggio | Quando sono usciti tutti. Non esiste un evento di chiusura e nessuno la decide: quando un membro esce, chiude i propri canali con l'LSP dal proprio wallet, e il viaggio è chiuso quando sono usciti tutti. *(aggiornato il 23/10)* |
| LSP | Dave non è un membro, come deciso il 21/10: non viene invitato, non firma eventi e non legge il registro. Il suo nodo instrada i pagamenti come LSP e la sua liquidità si gestisce guardando solo i suoi canali; l'app e il ledger non sanno che dietro c'è Dave. I membri della demo sono Alice, Bob e Charlie. *(aggiornato il 23/10)* |

## Come funziona

Ogni membro ha tutto sul telefono: app, AI, ledger, chiave del registro e nodo con i soldi. Fuori ci sono solo servizi che si possono sostituire.

```
┌──────────── Telefono di ogni membro ────────────┐
│ App + AI locale (QVAC): chat, OCR, divisione    │◄── QR / Bluetooth ──► altri telefoni
│ Ledger: calcola le quote, valida ogni evento    │    (firme, mai soldi, senza internet)
│ Chiave del registro: firma anche offline        │◄── eventi firmati ──► Relay Nostr (2-3)
│ Nodo WDK RGB-LN: canale e chiavi dei soldi      │◄── canale USDT ─────► LSP Utexo
│                                                 │◄── indexer, backup ─► Servizi Utexo (VSS)
└─────────────────────────────────────────────────┘
```

Tra i telefoni, al tavolo, passano solo proposte e firme: mai soldi. I soldi passano solo dal canale con l'LSP, che non può prenderli.

## Cosa costruiamo

Sei pezzi, tutti nostri e tutti fattibili oggi. Nessuno richiede un server che decide.

### 1. Il registro su Nostr

Ogni evento è firmato da chi lo scrive e dice quali eventi precedenti conosceva. Così due membri offline possono scrivere nello stesso momento: le due strade si riuniscono da sole appena tornano online.

- I relay conservano e inoltrano, non controllano niente. Ne usiamo 2-3.
- Ogni telefono tiene una copia completa e controlla firme e regole da solo.
- Tutti i telefoni mettono gli eventi nello stesso ordine con una regola fissa, quindi calcolano gli stessi saldi.
- Se un evento cita un precedente che il telefono non ha, lo chiede agli altri relay o a un altro membro.
- Pochi casi si scontrano davvero, e hanno una regola fissa: tra "approvo" e "contesto" sulla stessa riga vince "contesto"; tra pagamento e annullamento vince il pagamento.

### 2. La chiave del registro

È diversa dalla chiave dei soldi, ma nasce dalla stessa seed: chi recupera la seed recupera tutto.

- È una chiave Nostr normale, quindi firma anche senza nodo acceso e senza rete.
- Una chiave diversa per ogni viaggio: i relay non possono collegare i gruppi della stessa persona.
- Quando entra in un gruppo, il membro dimostra che chiave e nodo sono suoi con una fattura di prova firmata dal nodo.

### 3. La quota firmata al tavolo

Bob firma la proposta di Alice (righe, importi, cambio). La fattura non è firmata da Bob: Alice la aggancia alla spesa e può riemetterla se scade. Prima di pagare, l'app di Bob controlla che la fattura paghi il nodo di Alice per l'importo e l'asset della quota firmata; altrimenti non paga. *(aggiornato il 22/10)*

- Alice non può cambiare niente senza rendere invalida la firma di Bob.
- Le quote firmate al tavolo sono subito "da pagare". Chi non c'era riceve la spesa e decide dopo, come oggi.
- Le quote firmate al tavolo sono un consenso esplicito: non contano nel tetto giornaliero dei pagamenti automatici. *(aggiornato il 22/10)*
- Le fatture devono durare almeno 24 ore, perché Bob può pagare molto dopo. Se scadono, Alice ne emette una nuova.

### 4. Il cambio valuta

L'app scarica il cambio dall'oracolo ogni volta che c'è rete e salva l'ultimo.

- La spesa riporta il cambio usato e la sua data.
- Se il cambio ha più di 24 ore, l'app lo dice a chi paga e a chi accetta la quota.
- Se l'oracolo firma i suoi cambi, la spesa porta anche la firma: tutti verificano che il numero non è inventato.

### 5. Blocco, esclusione e uscita

Sono tre messaggi firmati: "blocco", "sblocco", "esco". L'esclusione non è un messaggio: ogni telefono la calcola contando i blocchi.

- Una spesa che include un membro bloccato è valida solo se è stata scritta prima che il blocco fosse noto.
- Se Bob blocca Alice, da quel momento non possono esserci spese in cui uno dei due paga e l'altro è debitore, in nessuna delle due direzioni. Una spesa pagata da un terzo con entrambi tra i debitori resta possibile. I debiti precedenti al blocco restano e si saldano normalmente. *(aggiornato il 22/10)*
- Uno sblocco toglie tutti i blocchi che chi sblocca aveva messo su quella persona. Per bloccarla di nuovo serve un nuovo blocco. *(aggiornato il 22/10)*
- L'esclusione scatta quando più della metà degli altri membri attivi blocca qualcuno, ed è definitiva: per rientrare serve un nuovo invito. I debiti dell'escluso restano e si pagano a mano; sulle righe arrivate dopo l'esclusione il silenzio-assenso non vale. Dipende da D3 (Sybil), ancora aperta. *(aggiornato il 22/10)*
- Su una riga contestata votano gli altri membri attivi (non creditore e debitore): più della metà decide "dovuta" o "annullata", per sempre. Regola provvisoria. *(aggiornato il 23/10)*
- Uscendo, il membro chiude i propri canali con l'LSP dal proprio wallet: i suoi soldi tornano a lui on-chain. Il viaggio è chiuso quando sono usciti tutti. *(aggiornato il 23/10)*
- Si esce quando non si hanno più debiti noti. Se nel frattempo arriva una spesa registrata da qualcuno che non sapeva dell'uscita, il debito resta: chi è uscito lo vede, può contestarlo se non era presente, e lo paga a mano. L'app non può garantire che venga pagato. Sulle righe arrivate dopo l'uscita il silenzio-assenso non vale: restano da decidere finché chi è uscito non le approva o le contesta. *(aggiornato il 22/10)*
- Chi esce o è escluso continua a incassare i suoi crediti e a poter saldare i suoi debiti.

### 6. Il pagamento che riparte

Se Alice è offline, il debito resta "da pagare" e l'app di Bob ritenta quando la riapre.

- Quando Alice apre l'app, lo segnala con un messaggio Nostr di presenza, che non resta nel registro.
- Le app dei debitori che sono aperte in quel momento pagano subito.
- Se nessuno dei due ha l'app aperta allo stesso momento, il pagamento parte alla prima occasione.

## Gli eventi del registro

Ogni evento lo firma solo la persona che agisce per sé. Nessun evento richiede un ruolo speciale.

| Evento | Chi lo firma | Cosa cambia |
| --- | --- | --- |
| `TRIP_CREATED` | chi crea il gruppo | Resta. I parametri non cambiano più dopo la creazione |
| `MEMBER_INVITED` | un membro qualsiasi | Nuovo. Sostituisce l'ammissione |
| `MEMBER_JOINED` | chi entra | Resta. Porta la chiave del registro e la fattura di prova del nodo |
| `TRIP_SECRET_SHARED` | un membro | Porta il segreto del viaggio cifrato per ciascun destinatario; chi entra ne scrive uno per sé, per ritrovarlo dalla seed *(aggiornato il 22/10)* |
| `POLICY_UPDATED` | il membro | Resta |
| `EXPENSE_SUBMITTED` | chi ha pagato | Resta. In più: le firme delle quote prese al tavolo, il cambio con la sua data e, se c'è, la firma dell'oracolo |
| `LINE_SEEN` | il debitore | Resta, solo per chi non ha firmato al tavolo |
| `LINE_DECIDED` | il debitore | Resta |
| `PAYMENT_MADE` | il debitore | Resta |
| `EXPENSE_VOIDED` | chi ha pagato | Resta |
| `INVOICE_REISSUED` | chi ha pagato | Resta |
| `LINE_VOTED` | un membro che non è né creditore né debitore della riga | Nuovo. Voto su una riga contestata: "dovuta" o "annullata" *(aggiornato il 23/10)* |
| `MEMBER_BLOCKED` | un membro qualsiasi | Nuovo. Il blocco conta anche come voto per l'esclusione |
| `MEMBER_UNBLOCKED` | chi aveva bloccato | Nuovo |
| `MEMBER_LEFT` | chi esce | Nuovo. Solo senza debiti noti *(aggiornato il 22/10)* |
| `CHECKPOINT` | un membro attivo (non uscito e non escluso) *(aggiornato il 22/10)* | Resta. Riporta gli ultimi eventi noti, così due telefoni confrontano i registri |

Limite dichiarato: chi esce o viene escluso conserva il segreto e può leggere gli eventi successivi. La rotazione del segreto è in roadmap. *(aggiornato il 22/10)*

**Spariscono:** `RATE_SET` (il cambio sta nella spesa), `MEMBER_ADMITTED` (basta l'invito), `CHANNELS_READY` (ognuno vede da solo il suo canale), `DISPUTE_RESOLVED` (sostituito dal voto a maggioranza, *aggiornato il 23/10*), `GUARANTEE_PAID` (niente garanzia), `MEMBER_EXCLUDED` e `TRIP_CLOSED` (li calcola ogni telefono).

## Cosa dipende da Utexo

Quattro cose non funzionano oggi e non possiamo sistemarle noi. Finché restano aperte, la demo gira su `rln-rest` e lo Stack A si presenta come obiettivo.

| Problema | Cosa succede oggi | Cosa chiediamo |
| --- | --- | --- |
| Firmatore in modalità sicura | In modalità strict i canali non si aprono e i pagamenti si bloccano | Il motivo, e se controllerà anche gli importi in USDT |
| Ripristino del backup | Al primo pagamento dopo il ripristino il canale si chiude | La correzione, e se il backup contiene già tutti i dati RGB |
| Chiusura forzata | La transazione viene rifiutata e i soldi restano nel canale | La correzione, e come recuperare i fondi nel frattempo |
| LSP per l'ultima versione | Serve un accesso a repository privati | Accesso, oppure un'immagine pubblica |

In roadmap, sempre da Utexo: il pagamento che resta in attesa sull'LSP finché il destinatario torna online.

## Ordine di lavoro

Si parte dal formato degli eventi, perché tutto il resto ci si appoggia. Il motore del wallet si cambia per ultimo.

1. **Formato degli eventi:** busta Nostr, riferimenti agli eventi precedenti, ordine fisso, regole per i casi in conflitto.
2. **Regole del ledger:** nuovi eventi, blocco ed esclusione, uscita, quote firmate al tavolo, righe da pagare a mano.
3. **Chiave del registro:** derivazione dalla seed, una per viaggio, fattura di prova del nodo.
4. **Trasporto Nostr:** pubblicazione su 2-3 relay, copia completa sul telefono, recupero degli eventi mancanti. Demo: "spengo un relay e il gruppo continua".
5. **Cambio:** scelta dell'oracolo, salvataggio dell'ultimo cambio, avviso se è vecchio.
6. **Al tavolo senza internet:** scambio della proposta e della firma via QR, poi Bluetooth.
7. **Pagamento che riparte:** messaggio di presenza e nuovo tentativo automatico.
8. **Motore WDK:** quando Utexo chiude i quattro problemi, si cambia `KITTY_WALLET_ENGINE` e si rifà lo spike.

## Domande aperte

- [ ] Contestazioni: chi decide quando i due non si accordano? Dal 23/10 vale la regola provvisoria a maggioranza; il modello definitivo resta da decidere. *(aggiornato il 23/10)*
- [ ] Quale oracolo per il cambio: deve coprire le valute del viaggio (dong, euro, dollari) e, se possibile, firmare i cambi.
- [ ] Dopo quante ore un cambio salvato è "vecchio": proposta 24.
- [ ] Quanto può durare una fattura RGB: serve almeno un giorno.
- [ ] Un canale con l'LSP o due (uno per verso): dipende da Utexo, non cambia l'architettura.
- [ ] Swap di Kaleidoswap: per ora fuori. Si riapre se supportano USDT su Lightning e non solo BTC.

## Modello di business

kit+ty è gratis per i gruppi e il protocollo è aperto. Guadagniamo in tre modi:

1. **Partnership con Utexo:** commissioni zero o liquidità gratis per gli utenti kit+ty, in cambio dei nuovi utenti (B2C e B2B) che portiamo su USDT RGB. Le commissioni dell'LSP le paga il nodo dell'utente, non noi: la richiesta a Utexo va formulata così. Serve un accordo scritto con una durata.
2. **Commissione su entrata e uscita dei soldi**, in entrambi i modelli. Entrata: euro → USDT tramite un fornitore con licenza (MiCA, KYC: non lo facciamo noi), poi il ponte Utexo verso RGB. Si può aggirare (chi ha già USDT li manda direttamente). Parte quando USDT è on-chain e l'LSP ha liquidità.
3. **Servizi di comodità per le aziende:** notifiche push, archivio, report e note spese, eventualmente la garanzia sui debiti offerta da un operatore senza poteri sul ledger. È l'unico ricavo disponibile da subito.

Da verificare: se la commissione su entrata e uscita copre i costi dei server (relay, notifiche) anche per gli utenti B2C.

Frase per il pitch: "Gratis per i gruppi, pagano le aziende per i servizi, e prendiamo una piccola commissione quando i soldi entrano o escono. Utexo ci dà la rete, noi gli portiamo gli utenti."

## Stato di USDT su RGB (verificato il 21/10/2026)

- **On-chain:** Utexo ha annunciato il lancio sulla rete Bitcoin per ottobre 2026, con licenza per emettere USDT con il marchio Tether. Al 21/10 non è stato possibile confermare che sia già attivo.
- **Lightning:** previsto dopo il lancio on-chain, senza data. Tecnicamente RGB Lightning accetta qualsiasi asset RGB senza permessi; quello che manca è la liquidità in USDT sull'LSP (oggetto della partnership). Da verificare con Utexo: tipo di asset di USDT (NIA come DUSD o un altro schema) e compatibilità di versione con il nodo WDK.
- **Rampa da euro:** nessun exchange annunciato per USDT-RGB. Strada indiretta già possibile: euro → USDT su un'altra rete → ponte Utexo (mint.utexo.com) → RGB.
- In demo resta DUSD su regtest.

## Privacy

Il contenuto resta privato, ma l'LSP vede i pagamenti.

| Chi | Vede | Non vede |
| --- | --- | --- |
| LSP Utexo | Chi paga chi, quanto e quando (Bob e Alice sono sullo stesso LSP, quindi vede entrambi i capi) | Perché: scontrino, spesa, gruppo, chat |
| Relay Nostr, con contenuto cifrato | Che una chiave ha pubblicato, e quando | Il contenuto, e chi c'è dietro (chiave diversa per viaggio) |
| Servizi Utexo (backup VSS) | Niente, è cifrato | — |
| Nessuno fuori dai telefoni | — | Foto, AI, divisioni, chat |

Mitigazioni:
1. **Cifratura del registro su Nostr: obbligatoria.**
2. Pagare il saldo netto meno spesso (per esempio una volta al giorno) invece di ogni spesa: l'LSP vede meno e si risparmia sulle commissioni, ma il rimborso arriva più tardi.
3. Più LSP in futuro (oggi per RGB c'è solo Utexo).
4. Per le aziende, LSP proprio (il server LSP di Utexo è open source).

Paragone per il pitch: l'LSP vede quello che una banca vede in un bonifico, ma senza la causale. Splitwise o Tricount vedono tutto.

Da decidere: per kit+ty deve restare segreto solo il contenuto, o anche chi paga chi?

## Pitch: Lugano Cypher Tank 2026

- 3 minuti, in inglese, massimo 3 slide in PDF, sfondo scuro. Consegna entro il 22/10/2026.
- Giudice ospite: un rappresentante di Utexo. Può aprire una conversazione su grant, investimento o partnership.
- I testi delle slide per il grafico sono in un documento separato ("kit+ty pitch: testi per le slide"). Mancano i contatti del team e la scelta tra "common fund" e "kitty" nella frase sotto il logo.
