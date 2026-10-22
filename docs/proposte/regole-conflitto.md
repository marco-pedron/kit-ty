# Regole di conflitto: decisioni

> **Aggiornato il 22/10/2026.** Le regole C1-C15 vengono da `docs/piano-migrazione-stack-a.md` §2.4. Il documento del team (`docs/stack-a-decisioni.md`) fissava C1 ("vince contesto") e C2 ("vince il pagamento"). Il 22/10 sono state decise tutte le altre; per C2 (ambito) e C12 è stata scelta l'alternativa alla proposta iniziale. È stata decisa anche D6 (ambito del blocco). Resta aperta solo D3 (Sybil). Il codice è in `packages/ledger/src/conflicts.ts`, con un test per regola in `conflicts.test.ts`.

**Vincolo comune a tutte le regole.** Lo spareggio sull'id si può minare: chi scrive un evento può provare nonce diversi finché il suo id non viene "prima". Per questo una regola che muove soldi guarda solo la causalità ("X precede Y") e il tipo di evento. L'ordine fisso decide solo i casi "vince il primo" in cui vincere non dà vantaggi.

## Regole decise

| # | Caso | Decisione | Note per l'implementazione |
|---|---|---|---|
| C1 | "Approvo" e "contesto" concorrenti sulla stessa riga | Vince "contesto". [T] | Già implementata. |
| C2 | Pagamento e `EXPENSE_VOIDED` sulla stessa spesa | Vince il pagamento [T], **solo per la riga pagata**: l'annullamento toglie le altre righe, la riga pagata resta dovuta e saldata. | **Cambia** l'implementazione attuale, che salvava tutta la spesa. Si fa subito. |
| C3 | Lo stesso debitore decide due volte in sequenza | Vale la decisione successiva: il debitore ritira la contestazione approvando **dopo averla vista** (la contestazione è tra gli antenati dell'approvazione). Se sono concorrenti, vince la contestazione (C1). | In `lineDecision`. Si fa subito. |
| C4 | Due `PAYMENT_MADE` validi per la stessa riga | Il primo nell'ordine fisso salda la riga; l'altro diventa un credito del debitore verso il creditore, da rimborsare a mano. | Già implementata. |
| C5 | `PAYMENT_MADE` e `INVOICE_REISSUED` concorrenti | Il pagamento è valido se la preimage corrisponde a una qualsiasi fattura emessa per quella riga. | Già implementata. |
| C6 | Due `INVOICE_REISSUED` concorrenti per la stessa riga | Tutte valide; il debitore paga quella non scaduta con l'id minore. Qualsiasi pagamento salda la riga (C5). | Già implementata. |
| C7 | `MEMBER_BLOCKED` e `MEMBER_UNBLOCKED` concorrenti dello stesso autore sullo stesso membro | Vince il blocco. In sequenza vale l'ultimo. Uno sblocco toglie **tutti** i blocchi dello stesso autore sullo stesso membro che ha tra i propri antenati; per bloccare di nuovo si scrive un nuovo blocco. | Passo 2. L'effetto del blocco è definito da D6 (sotto): tenerlo in un solo punto del codice. |
| C8 | `EXPENSE_SUBMITTED` concorrente con un `MEMBER_BLOCKED` che la renderebbe invalida | La spesa è valida se il blocco **non** è tra i suoi antenati ("noto" = presente tra gli antenati). | Passo 2. Quali spese il blocco rende invalide è definito da D6 (sotto). |
| C9 | `EXPENSE_SUBMITTED` concorrente con il `MEMBER_LEFT` del debitore | Entrambe valide: il debito resta e chi è uscito lo vede come "debito arrivato dopo l'uscita". **Condizioni:** (1) chi è uscito può ancora contestare (`LINE_DECIDED`) le righe arrivate dopo l'uscita, e con C1 la contestazione vince: è così che si accerta se era davvero presente; (2) **limite dichiarato:** l'app non può garantire che il debito venga pagato, né dentro né fuori dal viaggio, perché non custodisce fondi. Il debito resta visibile a tutti finché non è saldato. | Passo 2. Da verificare: se una riga richiede già la firma del debitore sulla proposta, il caso si presenta solo per spese che il debitore ha firmato. |
| C10 | Due `EXPENSE_SUBMITTED` con lo stesso `fingerprint` | **Entrambe valide**, segnate come "possibile doppione". I debitori contestano quella sbagliata (C1). L'ordine fisso non ne invalida nessuna. | **Cambia** l'implementazione attuale. Motivo: chi vince diventa il creditore, quindi la vecchia regola spostava soldi con uno spareggio manipolabile. Si fa subito. |
| C11 | `EXPENSE_VOIDED` concorrente con `LINE_DECIDED` | Vince l'annullamento, salvo le righe pagate (C2). | Già implementata; verificare che resti coerente con la nuova C2. |
| C12 | Due `POLICY_UPDATED` concorrenti dello stesso membro | Vale **la più prudente** delle due: limite automatico e tetto giornaliero più bassi, campo per campo. | **Cambia** l'implementazione attuale ("vale l'ultima"). Si fa subito. |
| C13 | Due `MEMBER_JOINED` con lo stesso invito | **Un invito, un ingresso:** vale il primo nell'ordine fisso. Vincere non dà soldi, quindi l'ordine fisso va bene. | Passo 2. La questione Sybil (D3) resta aperta. |
| C14 | `MEMBER_INVITED` di un membro con un `MEMBER_LEFT` concorrente | L'invito è valido, perché l'uscita non era nota. | Passo 2. |
| C15 | La catena personale di un autore si biforca | Entrambi i rami validi; l'autore è segnato "registro biforcato". Un blocco conta come noto se precede almeno una delle sue teste. | Già implementata. Da rivedere se la biforcazione diventa un modo per "dimenticare" un blocco. |

## D6, ambito del blocco: decisa il 22/10

Il blocco vale **per coppia** e serve a non avere debiti o crediti con una persona.

- **Regola.** Se Bob blocca Alice, da quando il blocco è noto (presente tra gli antenati della spesa, C8) non può esserci una spesa in cui uno dei due è il pagatore e l'altro è debitore. Vale in entrambe le direzioni.
- **Cosa resta permesso.** Una spesa pagata da un terzo in cui Alice e Bob sono entrambi debitori resta valida: tra loro non passano soldi.
- **Spesa che viola la regola.** È **invalida per intero**. L'app di chi la registra, se conosce il blocco, non permette di crearla e spiega il motivo; la regola colpisce quindi solo un'app modificata o difettosa.
- **Debiti precedenti.** Le spese registrate prima che il blocco fosse noto restano valide, e i debiti tra i due vanno saldati normalmente.
- **Chi lo toglie.** Solo chi ha bloccato (vedi C7).

Nel codice la regola deve stare in un solo punto.

## Domande ancora aperte

- **D3, Sybil sugli inviti:** si decide insieme alla politica di esclusione.
- **Fazioni** e **cambio nel weekend:** invariati.