# kit+ty: pitch e risposte alle domande difficili

> Bozza da rifinire domenica mattina (task T2). Le risposte sono brevi apposta: si dicono in 15 secondi.

## Il messaggio in una riga
**La cassa comune dei viaggi di gruppo, senza custode: l'AI sul telefono divide lo scontrino, il tuo agente rimborsa chi ha pagato in pochi secondi, e nessuno tiene i soldi di nessuno.**

## Scaletta (3 minuti)
1. **Una persona** (20 s): Alice, italiana, in Vietnam con un tedesco e un'americana che non conosceva una settimana fa. Ha pagato la cena per tutti.
2. **Oggi** (20 s): o la busta di contanti del coordinatore, opaca e in mano a uno solo; o Splitwise, che calcola ma non paga. Chi anticipa finisce in credito con degli sconosciuti.
3. **kit+ty** (20 s): ognuno impegna i suoi dollari digitali in un canale Lightning RGB verso l'operatore. Restano suoi.
4. **Demo** (90 s): SPEC §16, passi 2-7.
5. **Perché RGB e perché AI locale** (20 s): un dollaro nativo di Bitcoin uguale per tutte le nazionalità, istantaneo su Lightning, privato per costruzione; lo scontrino e le abitudini di spesa non lasciano il telefono.
6. **Business** (10 s): B2B2C con i tour operator di viaggi di gruppo; il concorrente è la busta di contanti.
7. **Chiusura**: "Nessuno ha custodito i soldi di nessuno. Alice è stata rimborsata in pochi secondi. Charlie se n'è andato con i suoi soldi, e l'operatore, che lo conosce, ha coperto il buco."

## Domande difficili

**"Perché non Revolut?"**
Revolut funziona se tutti hanno Revolut. Il nostro gruppo è italiano, tedesco e americano: tre banche, due valute, nessun IBAN comune. Con kit+ty tutti tengono lo stesso dollaro digitale e il rimborso arriva in secondi. Con un gruppo tutto italiano, Satispay basta: lo diciamo.

**"Allora è Splitwise con un bottone Paga?"**
Splitwise calcola e spera. Noi paghiamo, in secondi, tra persone senza un sistema di pagamento comune, con un agente che rispetta limiti fissati dall'utente e una garanzia dell'operatore se qualcuno sparisce. E senza custode.

**"Dove gira il nodo di Bob?"**
Nella demo su questo portatile: un `rgb-lightning-node` per persona, pilotato via REST dal suo agente. WDK c'è dove oggi è solido: `@utexo/wdk-wallet-rgb` è la tesoreria on-chain dell'operatore, che emette i DUSD e fa l'on-ramp ai viaggiatori. Il nodo Lightning di WDK (`@utexo/wdk-rgb-lightning`, che gira anche su mobile, con `@utexo/rgb-sdk-rn` per iOS e Android) l'abbiamo provato: instrada pagamenti RGB, ma nella beta pubblicata su npm il firmatore non sopravvive a un riavvio, la chiusura del canale non restituisce i DUSD on-chain e il ripristino dal backup VSS si blocca. Le correzioni sono già upstream ma non ancora su npm: è il primo passo della roadmap. Il wallet sta dietro un'unica interfaccia, quindi il passo verso l'app è un cambio di motore, non di architettura.

**"Lightning sul telefono non è self-custody vera: serve essere online, servono watchtower."**
Vero. Per il rischio di stati vecchi: watchtower indipendente dall'operatore (roadmap). Per chi riceve offline: il pagamento riparte quando torna online; gli invoice durano 48 ore. Nessuno perde fondi nell'attesa.

**"Quanti soldi deve immobilizzare l'operatore?"**
Il giusto: il ledger sa in anticipo quanto ogni viaggiatore deve ricevere, quindi l'agente dell'operatore apre liquidità solo quando serve, prima che il pagamento arrivi. E torna tutta a lui a fine viaggio.

**"Il coordinatore può rubare?"**
No. Può instradare, decidere una contestazione, coprire un debito con i soldi dell'operatore ed escludere qualcuno. Non può muovere i fondi di un viaggiatore. Dave può essere fastidioso, ma non può rubare.

**"E se il coordinatore non instrada o è offline?"**
I pagamenti aspettano, nessuno perde nulla. Il viaggiatore può chiudere il canale e uscire, oppure pagare con un trasferimento RGB on-chain diretto.

**"Chi sparisce lascia un buco."**
L'operatore lo copre fino a un tetto, pagando lo stesso invoice, e recupera dal cliente che conosce per nome e ha già fatturato. È il modello delle carte di credito: chi conosce il cliente si prende il rischio. Oltre il tetto resta un credito: lo diciamo.

**"La garanzia non è custodia mascherata?"**
No: l'operatore paga con i soldi suoi e non tocca mai quelli dei viaggiatori.

**"Come comprano USDT su RGB i viaggiatori?"**
Alla prenotazione, insieme al viaggio, tramite l'operatore o un partner di emissione. Nella demo, il seed simula questo passaggio.

**"Le fee on-chain si mangiano i debitucci."**
I canali non si aprono per ogni viaggio: restano aperti con l'operatore e servono anche per i successivi. Il singolo rimborso viaggia su Lightning, senza blocchi. Limite onesto: ogni pagamento RGB su Lightning porta con sé 3000 sat (il minimo perché il pagamento in sospeso esista come output Bitcoin); non sono commissioni, passano a chi riceve, ma chi paga deve averli nel canale.

**"E se l'AI sbaglia lo scontrino?"**
L'AI propone, le persone approvano. Le righe sono modificabili, i totali vengono controllati dal codice, i soldi li calcola il ledger e non il modello. Ogni debitore vede e approva il proprio importo.

**"L'AI ha pagato al posto mio."**
Solo sotto il limite che hai scelto, solo se non hai obiettato dopo aver visto la riga, e con un tetto giornaliero. Sopra il limite approvi tu. L'agente ti dice sempre perché ha pagato o perché no.

**"E se qualcuno scrive una frase studiata per fregare l'AI?"**
L'output è vincolato ai membri e alle righe esistenti, e il debitore approva l'importo che gli arriva, non la frase.

**"Chi garantisce che il registro non sia truccato?"**
Nessuno deve garantirlo. Ogni spesa è firmata da chi la fa, ogni approvazione da chi approva, ogni pagamento ha la sua ricevuta crittografica Lightning, e la catena di hash è la stessa su tutti i telefoni. Il server è solo un postino.

**"Se perdo il telefono?"**
Con RGB la mnemonica non basta: serve lo stato dei dati lato client. Per questo l'agente fa un backup cifrato automatico del nodo dopo ogni cambiamento di stato, appena il nodo è inattivo (lo blocca per un istante, esporta, sblocca) e lo carica sul relay, che lo conserva senza poterlo leggere; il ripristino su un nodo nuovo riporta la stessa identità e gli stessi canali. Il backup nativo di WDK (VSS, senza fermare il nodo) è in roadmap: nello spike il salvataggio funzionava ma il ripristino si bloccava, e le correzioni upstream non sono ancora su npm. [Se pronto: lo mostriamo.]

**"Un operatore che gestisce stablecoin dei clienti in UE è regolamentato."**
L'operatore non custodisce i fondi dei clienti, e questo cambia molto la posizione. La garanzia è un impegno commerciale da inquadrare con un legale; il prodotto funziona con qualunque stablecoin su RGB. (Non va nelle slide; risposta prudente, non siamo avvocati.)

**"Chi paga?"**
L'operatore: niente contanti da gestire per il coordinatore, meno dispute a fine viaggio, recensioni migliori. Una quota per viaggiatore per viaggio.

## Limiti da dire prima che li dicano loro
- Nodi e agenti girano su un portatile; il prodotto è su mobile.
- La certezza del rimborso è garantita fino al tetto dell'operatore.
- Dave, come hub, vede i pagamenti del gruppo.
- On-ramp simulato; DUSD al posto di USDT.
