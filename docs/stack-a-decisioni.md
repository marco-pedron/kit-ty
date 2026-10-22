# kit+ty Stack A: decisioni e piano

> **Documento di passaggio per una nuova chat.** Riassume le decisioni prese dal team il 21 ottobre 2026 sullo Stack A (nodo WDK sul telefono, LSP Utexo, registro su Nostr, nessun operatore centrale). Sostituisce le parti dello SPEC (`marco-pedron/kit-ty`, `docs/SPEC.md`) che descrivono Dave come nodo centrale: quelle sono superate e vanno ignorate.

Lo Stack A si può costruire: le regole del gruppo sono decise, la parte che manca dipende da Utexo.

## Decisioni del team

Nessun membro ha poteri speciali: ognuno firma solo per sé, e le regole valgono uguali per tutti.

| Tema | Decisione |
| --- | --- |
| Telefono spento | Il pagamento riparte da solo quando entrambi hanno l'app aperta. Il pagamento in attesa sull'LSP va in roadmap, quando Utexo lo renderà possibile |
| Contestazioni | Da decidere. Nel frattempo la riga contestata resta bloccata: nessuno la paga in automatico |
| Ingresso | Basta l'invito di un membro |
| Cambio valuta | L'app scarica il cambio dall'oracolo quando c'è rete e lo salva. Alla spesa usa l'ultimo salvato, scritto con la sua data. Avviso se è vecchio |
| Blocco | Ognuno può bloccare un membro, in modo visibile a tutti, e sbloccarlo quando vuole. Il bloccato non entra nelle sue nuove spese e non gli addebita niente |
| Esclusione | Automatica quando i blocchi superano la metà degli altri membri. Decade se tornano sotto |
| Debiti verso chi è bloccato o escluso | Restano. Niente pagamento automatico: si paga a mano |
| Debiti di chi è bloccato o escluso | Può sempre saldarli |
| Uscita | Un messaggio firmato "esco", quando non hai più debiti. Si può uscire anche con crediti da incassare. I soldi non si muovono |
| Fine del viaggio | Quando sono usciti tutti |

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

Bob firma la proposta di Alice (righe, importi, cambio, fattura) e la firma finisce dentro la spesa che Alice pubblica.

- Alice non può cambiare niente senza rendere invalida la firma di Bob.
- Le quote firmate al tavolo sono subito "da pagare". Chi non c'era riceve la spesa e decide dopo, come oggi.
- Le fatture devono durare almeno 24 ore, perché Bob può pagare molto dopo. Se scadono, Alice ne emette una nuova.

### 4. Il cambio valuta

L'app scarica il cambio dall'oracolo ogni volta che c'è rete e salva l'ultimo.

- La spesa riporta il cambio usato e la sua data.
- Se il cambio ha più di 24 ore, l'app lo dice a chi paga e a chi accetta la quota.
- Se l'oracolo firma i suoi cambi, la spesa porta anche la firma: tutti verificano che il numero non è inventato.

### 5. Blocco, esclusione e uscita

Sono tre messaggi firmati: "blocco", "sblocco", "esco". L'esclusione non è un messaggio: ogni telefono la calcola contando i blocchi.

- Una spesa che include un membro bloccato è valida solo se è stata scritta prima che il blocco fosse noto.
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
| `POLICY_UPDATED` | il membro | Resta |
| `EXPENSE_SUBMITTED` | chi ha pagato | Resta. In più: le firme delle quote prese al tavolo, il cambio con la sua data e, se c'è, la firma dell'oracolo |
| `LINE_SEEN` | il debitore | Resta, solo per chi non ha firmato al tavolo |
| `LINE_DECIDED` | il debitore | Resta |
| `PAYMENT_MADE` | il debitore | Resta |
| `EXPENSE_VOIDED` | chi ha pagato | Resta |
| `INVOICE_REISSUED` | chi ha pagato | Resta |
| `MEMBER_BLOCKED` | un membro qualsiasi | Nuovo. Il blocco conta anche come voto per l'esclusione |
| `MEMBER_UNBLOCKED` | chi aveva bloccato | Nuovo |
| `MEMBER_LEFT` | chi esce | Nuovo. Solo senza debiti |
| `CHECKPOINT` | chiunque | Resta. Riporta gli ultimi eventi noti, così due telefoni confrontano i registri |

**Spariscono:** `RATE_SET` (il cambio sta nella spesa), `MEMBER_ADMITTED` (basta l'invito), `CHANNELS_READY` (ognuno vede da solo il suo canale), `DISPUTE_RESOLVED` (contestazioni da decidere), `GUARANTEE_PAID` (niente garanzia), `MEMBER_EXCLUDED` e `TRIP_CLOSED` (li calcola ogni telefono).

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

- [ ] Contestazioni: chi decide quando i due non si accordano?
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
