# Proposta: regole di conflitto da confermare con il team

> **Proposta, NON decisa.** Le regole C1-C15 vengono da `docs/piano-migrazione-stack-a.md` §2.4. Il documento del team (`docs/stack-a-decisioni.md`) ne fissa solo due: C1 ("vince contesto") e C2 ("vince il pagamento"). Tutte le altre sono nostre proposte [I]. Il codice è in `packages/ledger/src/conflicts.ts`, con un test per regola in `conflicts.test.ts`.

**Vincolo comune a tutte le regole.** Lo spareggio sull'id si può minare: chi scrive un evento può provare nonce diversi finché il suo id non viene "prima". Per questo una regola che muove soldi guarda solo la causalità ("X precede Y") e il tipo di evento. L'ordine fisso decide solo i casi "vince il primo" in cui vincere non dà vantaggi.

## Regole [I] implementate, da confermare

| # | Caso | Cosa decide la proposta | Alternativa |
|---|---|---|---|
| C2 (ambito) | Pagamento e `EXPENSE_VOIDED` sulla stessa spesa | La regola [T] "vince il pagamento" vale per **tutta la spesa**: un pagamento valido di **qualsiasi** riga, in qualsiasi posizione, annulla l'annullamento. | Vale solo per la riga pagata: l'annullamento toglie le altre righe, la riga pagata resta. |
| C4 | Due `PAYMENT_MADE` validi per la stessa riga (fattura originale e riemessa, due dispositivi) | Il primo nell'ordine fisso salda la riga; l'altro diventa un **credito del debitore verso il creditore**, da rimborsare a mano. | Il credito si compensa da solo con il prossimo debito del creditore verso il debitore. |
| C5 | `PAYMENT_MADE` e `INVOICE_REISSUED` concorrenti | Il pagamento è valido se la preimage corrisponde a **una qualsiasi** fattura emessa per quella riga. | Vale solo la fattura più recente; un pagamento su una fattura sostituita diventa un credito (come C4). |
| C6 | Due `INVOICE_REISSUED` concorrenti per la stessa riga | Tutte valide; il debitore paga quella non scaduta con l'id minore. Qualsiasi pagamento salda la riga (C5), quindi la scelta non sposta soldi. | Vale solo l'ultima nell'ordine fisso; le altre sono ignorate. |
| C10 | Due `EXPENSE_SUBMITTED` con lo stesso `fingerprint` | Vale la prima nell'ordine fisso, l'altra è invalida. Se gli autori sono diversi, chi perde vede "scontrino già registrato". | Entrambe valide ma segnate "possibile doppione": i debitori decidono (contestano quella in più). |
| C11 | `EXPENSE_VOIDED` concorrente con `LINE_DECIDED` | Vince l'annullamento (salvo C2): una decisione non salva una spesa. | Una riga già approvata, anche in concorrenza, resta dovuta; l'annullamento vale solo per le righe senza decisione. |
| C12 | Due `POLICY_UPDATED` concorrenti dello stesso membro (due dispositivi) | Vale l'ultima nell'ordine fisso: la policy è una preferenza locale, vincere lo spareggio non dà niente. | Vale la più prudente delle due (limite automatico e tetto giornaliero più bassi). |
| C14 | `MEMBER_INVITED` di un membro con un `MEMBER_LEFT` concorrente | L'invito è valido, perché l'uscita non era nota. Implementazione nel passo 2. | L'invito è invalido se l'uscita è nell'insieme, ovunque stia. |
| C15 | La catena personale di un autore si biforca (due eventi suoi senza relazione causale: due dispositivi o un tentativo di "dimenticare") | Entrambi validi; nell'interfaccia l'autore è segnato "registro biforcato". Un blocco conta come noto se precede almeno una delle sue teste. | Dal punto della biforcazione gli eventi dell'autore non contano finché non scrive un evento che riunisce i due rami. |

## Regole [I] su domande aperte: TODO nel codice

Nel codice queste regole non sono implementate: c'è un TODO con il riferimento alla domanda e un test segnaposto (`it.todo`). Le domande sono in `docs/piano-migrazione-stack-a.md` §11.

| # | Caso | Domanda aperta | Proposta del piano (non applicata) |
|---|---|---|---|
| C3 | Lo stesso debitore decide due volte in sequenza | D5, contestazioni senza arbitro. Il documento dice solo "la riga contestata resta bloccata". | Vale la decisione successiva: il debitore ritira la contestazione approvando dopo averla vista. **Oggi** `lineDecision` applica solo C1: se c'è una contestazione, la riga è contestata. |
| C7 | `MEMBER_BLOCKED` e `MEMBER_UNBLOCKED` concorrenti dello stesso autore sullo stesso membro | D6, ambito del blocco (per coppia o per tutti). | Vince il blocco (prudente); in sequenza vale l'ultimo. |
| C8 | `EXPENSE_SUBMITTED` concorrente con un `MEMBER_BLOCKED` che la renderebbe invalida | D6. La base è [T]: "valida solo se scritta prima che il blocco fosse noto". | Valida: "noto" = presente tra gli antenati della spesa. Resta da decidere a chi si applica il blocco. |
| C9 | `EXPENSE_SUBMITTED` concorrente con il `MEMBER_LEFT` del debitore | D9, uscita con debiti. **Contraddice** il documento: "esco quando non ho più debiti". | Entrambe valide: il debito resta e l'uscito lo vede come "debito arrivato dopo l'uscita". Alternativa coerente col documento: l'uscita è invalida se un debito concorrente esiste. |
| C13 | Due `MEMBER_JOINED` con lo stesso invito | D3, Sybil sugli inviti. Il documento dice solo "basta l'invito di un membro". | Un invito, un ingresso: vale il primo nell'ordine fisso. |
