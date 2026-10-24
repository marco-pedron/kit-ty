# ADR-001: formato degli eventi del registro (v2, Nostr)

> Stato: **accettato** il 21/10/2026 (revisione del team con i mentor, `docs/piano-migrazione-stack-a.md` §0bis). Fonte di verità: `docs/stack-a-decisioni.md`.
> Implementato nel passo 1 (branch `a/S1-nostr-envelope`; firme in `b/S1-schnorr`). Il registro della demo (`legacy-events.ts`, ed25519, relay Fastify) resta in uso fino al passo 2; `demo-finale-v1` è la demo di riserva.
> Le modifiche corrispondenti a `docs/SPEC.md` §9 sono proposte come diff in `docs/proposte/spec-9-registro.md`: vanno al PM.
> Passo 3 e app sul registro v2 (`KITTY_REGISTRY`): §10 e §11, aggiornati il 22/10.

## 1. Contesto

Il registro della demo ha un coordinatore con poteri (Dave) e un relay che assegna `seq` e `prevHash`: l'ordine lo decide il relay. Lo Stack A toglie entrambe le cose: nessun membro ha poteri, e 2-3 relay Nostr conservano e inoltrano senza ordinare. Serve quindi un formato in cui:
- ogni evento è firmato dal suo autore e verificabile da chiunque (CLAUDE.md, regola 6);
- l'ordine dipende solo dall'insieme degli eventi, non dal relay, dall'ordine di arrivo o dagli orologi;
- i relay non leggono importi, nomi e nodi;
- la firma di un debitore al tavolo sopravvive alla riemissione di una fattura.

## 2. Busta (NIP-01)

| Campo | Valore |
|---|---|
| `kind` | **7345** (regolare, conservato dai relay) per ogni evento del registro; **27345** (effimero) per presenza e richieste di eventi mancanti, mai applicati |
| `pubkey` | chiave del registro del membro **per quel viaggio** (x-only, NIP-06 `m/44'/1237'/<i>'/0/0`, passo 3) |
| `id` | `sha256` della serializzazione NIP-01 `[0, pubkey, created_at, kind, tags, content]` |
| `sig` | **Schnorr BIP-340 su secp256k1** dell'`id` (32 byte) |
| `created_at` | solo informativo: non entra mai nell'ordine |
| `tags` | `["T", tripTag]` (uno solo) e un `["e", id]` per ogni **genitore**, ordinati, senza duplicati, al massimo 32. Nessun altro tag: niente fuori dal contenuto firmato porta significato. Mai `["-"]` (NIP-70): gli eventi si devono poter ripubblicare |
| `content` | §3 |

- `tripTag = hex(sha256("kitty:trip:v1" ‖ tripSecret))`: il relay filtra per `#T` senza conoscere il viaggio.
- **Genitori:** le teste che l'autore conosce quando scrive, **sempre** compreso il suo evento precedente nel viaggio. Solo `TRIP_CREATED` non ne ha.
- **Serializzazione:** NIP-01 elenca 7 caratteri da scappare; `JSON.stringify` (usato da `nostr-tools` e da molti client) scappa anche gli altri controlli C0 e i surrogati isolati. Le due letture coincidono su ogni stringa che non li contiene, quindi **li rifiutiamo** (`NostrFormatError`): un `id` non dipende mai da quale lettura ha scelto un client.
- Codice: `packages/shared/src/nostr.ts` (serializzazione, id, tag), `packages/shared/src/crypto.ts` (`schnorrVerifier`, `schnorrSign`, stream B).

## 3. Contenuto cifrato (D1)

- `content` = **NIP-44 v2** del JSON canonico (RFC 8785, `canonical.ts`) di `{ v: 2, tripId, type, body }`.
- Chiave di conversazione = `HKDF-SHA256(ikm = tripSecret, info = "kitty:content:v1")`, 32 byte: la conoscono tutti i membri e nessun altro.
- `tripSecret`: 32 byte casuali generati da chi crea il viaggio, passati con l'invito (QR o link). Non tocca mai i soldi.
- **Una sola codifica per significato:** il contenuto decifrato deve essere esattamente quello che scriverebbe `encodeContent` (JSON canonico, nessun campo sconosciuto), altrimenti l'evento si rifiuta. Così un campo nascosto, per esempio una fattura dentro la proposta, non può passare inosservato.
- **Il segreto nel registro:** `TRIP_SECRET_SHARED { recipients: [{ pubkey, ciphertext }] }`, dove `ciphertext` = NIP-44 del segreto con la chiave di conversazione **ECDH standard** tra autore e destinatario. Ogni membro, entrando, ne scrive uno verso **sé stesso**: chi recupera la seed (passo 3) ritrova le chiavi del registro, i propri eventi e quindi il segreto. È l'unico tipo il cui `content` viaggia in chiaro (il destinatario non ha ancora la chiave del viaggio), senza `tripId`; base64 non comincia mai con `{`, quindi i due casi non si confondono. Chi lo apre controlla che `tripTagOf(segreto)` sia il tag del viaggio.
- **Limite dichiarato:** chi esce o viene escluso conserva il segreto e può leggere gli eventi successivi. La rotazione del segreto è in roadmap.
- **Cosa resta visibile ai relay:** tag `T` ed `e`, `pubkey` (una per viaggio), dimensioni, tempi, e i destinatari di `TRIP_SECRET_SHARED` (chiavi dello stesso viaggio, già visibili come autori).
- **Lunghezza: da 1 a 65.535 byte di testo in chiaro** [decisione confermata il 21/10]. NIP-44 oggi ammette testi fino a 2³² − 1 byte con un prefisso di 6 byte, ma i vettori pubblicati (il file con lo sha256 indicato in NIP-44) trattano ancora come invalidi i testi da 65.536 byte in su. Restiamo nell'intervallo classico, che ogni implementazione legge: gli eventi del registro pesano pochi KB. In pratica `nip44Encrypt` rifiuta un testo più lungo e `nip44Decrypt` rifiuta il prefisso esteso e ogni payload oltre 87.472 caratteri base64.
- Codice: `packages/shared/src/content.ts`, provato sui vettori ufficiali di NIP-44 e contro `nostr-tools` in entrambi i sensi. I vettori non stanno nel repo: il test li scarica a ogni esecuzione (`paulmillr/nip44`, `nip44.vectors.json`) e li usa solo se il loro sha256 è quello pubblicato nel testo di NIP-44 (`nostr-protocol/nips`, `44.md`). La suite sta in `content.vectors.test.ts`: senza rete salta con un avviso; un errore HTTP o uno sha256 diverso la fanno fallire.

## 4. Ordine fisso

### 4.1 Insieme chiuso
- Un telefono applica un evento solo se **tutti** i suoi genitori sono applicati. Gli altri restano "in attesa" e non contano per i saldi; gli `id` citati ma assenti sono quelli da recuperare (passo 4).
- La **genesi** è l'evento senza genitori con l'`id` minore (`TRIP_CREATED`). Ogni altro evento senza genitori, e tutto ciò che ne discende, è **ignorato**.

### 4.2 Sequenza
- Algoritmo di Kahn sul grafo dei genitori: tra gli eventi pronti si sceglie sempre quello con l'**`id` minore**. Una regola di scelta totale su `id` unici dà **una sola** sequenza per un grafo.
- Il grafo non ha cicli: un genitore si cita con il suo `id`, che è l'hash del suo contenuto; citare un evento successivo richiederebbe una seconda preimmagine di sha256. Un ciclo tra `id` non verificati semplicemente non viene mai applicato.
- `stateHash = sha256(id₁ ‖ … ‖ idₙ)` sui 32 byte di ogni `id`, nella sequenza fissa. Va in `CHECKPOINT { frontier, count, stateHash }`: stessa frontiera e `stateHash` diverso = bug da segnalare.
- `created_at` non entra mai nell'ordine. Le finestre della policy (silenzio-assenso, tetto giornaliero) restano decisioni locali dell'agente che paga, con il suo orologio.
- **Eccezione dichiarata** *(aggiornato il 22/10)*: il silenzio-assenso parte dal `created_at` del `LINE_SEEN`, cioè dall'orologio del debitore. È accettabile perché il `LINE_SEEN` lo firma solo il debitore: con il suo orologio può solo ritardare il proprio assenso (anticiparlo equivale ad approvare, cosa che può già fare). Nessun altro può spostare la scadenza.
- Codice: `packages/ledger/src/order.ts` (`fixedOrder`, `Causality`, `stateHash`). Test di proprietà su 1.000 grafi casuali: stesso insieme in qualsiasi ordine → stessa sequenza e stesso `stateHash`; `created_at` falsi senza effetto; un evento con un antenato mancante mai applicato; confronto con un'implementazione di riferimento a forza bruta.

### 4.3 "X precede Y"
- X precede Y se X è un antenato di Y (chiusura transitiva dei genitori). "Concorrenti" = nessuno dei due precede l'altro.
- **Noto** all'autore di E = tra gli antenati di E. Ogni evento cita il precedente del suo autore, quindi ciò che un autore ha visto resta antenato di tutto quello che scriverà: non lo si può dimenticare senza biforcare la propria catena (C15).

## 5. Regole di conflitto

**Lo spareggio sull'`id` si può minare.** Per questo le regole che muovono soldi guardano solo la causalità e il tipo di evento, mai l'ordine tra eventi concorrenti. L'ordine fisso decide solo i casi "primo vince" in cui vincere non porta vantaggi (duplicati, due dispositivi dello stesso membro). Ogni regola è una funzione pura in `packages/ledger/src/conflicts.ts`, con il suo test.

| # | Caso | Regola (decisa il 22/10, salvo C1 e C2 [T]) | Funzione |
|---|---|---|---|
| C1 | `approve` e `contest` concorrenti sulla stessa riga | vince `contest` [T] | `lineDecision` |
| C2 | pagamento ed `EXPENSE_VOIDED` sulla stessa spesa | vince il pagamento [T], solo per la riga pagata: le altre righe si annullano | `voidedLines` |
| C3 | lo stesso debitore decide due volte in sequenza | un'approvazione che ha tra gli antenati la contestazione dello stesso debitore la ritira; concorrenti, vince la contestazione | `lineDecision` |
| C4 | due pagamenti validi della stessa riga | paga il primo nell'ordine; gli altri sono un credito del debitore verso il creditore | `settleLine`, `overpaid` |
| C5 | pagamento e `INVOICE_REISSUED` concorrenti | valido se la preimage corrisponde a una qualsiasi fattura della riga | `paymentMatchesLine` |
| C6 | due `INVOICE_REISSUED` concorrenti | tutte valide; si paga quella non scaduta con `id` minore | `invoiceToPay` |
| C7 | blocco e sblocco dello stesso autore sullo stesso membro | concorrenti, vince il blocco; uno sblocco toglie tutti i blocchi dell'autore su quel membro che ha tra gli antenati; vale solo se firmato da chi ha bloccato | `fold.ts` (`MEMBER_UNBLOCKED`), `validateRegistryEvent` |
| C8 | spesa con un blocco tra pagatore e debitore (D6) | invalida per intero se il blocco è tra i suoi antenati; valida se è concorrente | `pairBlockRefusal`, `expenseRefusal` |
| C9 | spesa concorrente con l'uscita del debitore | entrambe valide; il debito resta, segnato "debito arrivato dopo l'uscita"; l'uscito può approvarlo o contestarlo; il silenzio-assenso non vale | `deriveRegistry` (`afterLeaving`) |
| C10 | due spese con lo stesso `fingerprint` | entrambe valide, segnate "possibile doppione" | `possibleDuplicates` |
| C11 | `EXPENSE_VOIDED` concorrente con `LINE_DECIDED` | vince l'annullamento, salvo le righe pagate (C2) | `voidedLines` |
| C12 | due `POLICY_UPDATED` concorrenti dello stesso membro | la più prudente, campo per campo | `effectivePolicy` |
| C13 | due `MEMBER_JOINED` con lo stesso invito | un invito, un ingresso: il primo nell'ordine | `fold.ts` (`join`), `validateRegistryEvent` |
| C14 | invito di un membro con un'uscita concorrente | valido (l'uscita non era nota) | `validateRegistryEvent` (sugli antenati) |
| C15 | la catena personale di un autore si biforca | entrambi validi, autore segnato "registro biforcato"; un blocco è noto se precede almeno una delle sue teste | `forkedAuthors`, `authorHeads` |

**Esclusione** *(aggiornato il 22/10)*: un membro è escluso quando più della metà degli altri membri attivi lo blocca, contati sul passato del blocco che fa scattare la maggioranza (`isExcluded`, `blockersMajority`). È **definitiva**: uno sblocco successivo non la toglie; per rientrare serve un `MEMBER_JOINED` con un nuovo invito che conosce l'esclusione. Una spesa è valida se l'esclusione non è tra i suoi antenati, come per C8. I debiti dell'escluso restano e si pagano a mano (`manual_only`, `debtor_excluded` o `creditor_excluded`); sulle righe di spese concorrenti con l'esclusione il silenzio-assenso non vale, come per C9 (`afterExclusion`). Quando qualcuno blocca, l'app avvisa che il blocco conta anche per l'esclusione (`blockWarning`). **Limite dichiarato:** dipende da D3 (Sybil), ancora aperta: con membri finti una persona sola può raggiungere la maggioranza.

**D4** *(aggiornato il 22/10)*: le quote firmate al tavolo sono un consenso esplicito e non contano nel tetto giornaliero (`decideRegistryAutoPay`). **Uscita:** anche una riga contestata è un debito noto e blocca l'uscita (conseguenza dichiarata).

**Contestazioni a maggioranza, provvisoria** *(aggiornato il 23/10)*: su una riga contestata votano con `LINE_VOTED` i membri attivi tranne creditore e debitore, con esito "dovuta" o "annullata". Decide più della metà dei votanti, contati sugli eventi che il voto decisivo conosceva, come per l'esclusione; conta un voto per votante, dato sulla contestazione in vigore; l'esito è definitivo. Finché la maggioranza non c'è la riga resta contestata: il debitore può ritirare la contestazione (C3) e il creditore può annullare la spesa (C2). Un'approvazione del debitore concorrente con l'esito "annullata" vince. Una riga dovuta per voto non si paga in automatico finché il debitore non la approva. La regola sta in un solo punto (`groupMajority`, `voidedByGroup`, `voteRefusal` in `registry/fold.ts`), perché il modello definitivo (D5) è ancora aperto. **Limiti dichiarati:** dipende da D3 (Sybil); in un gruppo di tre c'è un solo votante.

**Chiusura del viaggio** *(aggiornato il 23/10)*: non esiste un evento di chiusura e nessuno la decide. Chi esce (`MEMBER_LEFT`, senza debiti noti) chiude i propri canali con l'LSP dal proprio wallet; il viaggio è chiuso quando tutti sono usciti (`finished`).

Tutte le regole sono decise (`docs/proposte/regole-conflitto.md`, 22/10 e 23/10). Restano aperte D3 (Sybil sugli inviti), il modello definitivo delle contestazioni (D5), fazioni e cambio nel weekend. *(aggiornato il 23/10)*

## 6. Tipi e corpi

Importi in **unità base dell'asset**, come stringhe decimali (`amount`). La precisione è un parametro del viaggio: in demo DUSD con `assetDecimals = 2`, dopo la finale USDT a 6, senza cambiare il formato. Il ledger ricalcola le quote nella precisione del viaggio (`assetDecimals` di `TripParams`, `expenseShares`), non in centesimi fissi *(aggiornato il 22/10)*. Ogni riferimento a un altro evento è il suo `id` Nostr (`expenseRef`, `inviteRef`). Nessun tipo è riservato a un coordinatore.

| Tipo | Autore | `body` |
|---|---|---|
| `TRIP_CREATED` | chi crea | `name`, `params` (immutabili: `assetId`, `assetDecimals`, `displayDecimals` ≤ `assetDecimals`, `silentAssentSeconds`, `invoiceExpirySeconds` ≥ 86.400, default 172.800, `rateMaxAgeSeconds`, `oracles`), `relays` |
| `MEMBER_INVITED` | membro | `inviteId`, `inviteePubkey?`, `expiresAt` |
| `MEMBER_JOINED` | chi entra | `inviteRef` (null solo per chi ha creato il viaggio), `displayName`, `nodePubkey`, `bindInvoice` (`kitty-bind:v2:<tripTag>:<pubkey>`, passo 3), `policy` |
| `TRIP_SECRET_SHARED` | membro | `recipients: [{ pubkey, ciphertext }]` (§3) |
| `POLICY_UPDATED` | membro | `policy { autoPayLimit, dailyCap }` |
| `EXPENSE_SUBMITTED` | pagatore | `proposal`, `tableSignatures: [{ signer, sig }]`, `invoices: [{ debtor, bolt11 }]`, `receiptImageSha256`, `fingerprint` |
| `LINE_SEEN` | debitore | `expenseRef` |
| `LINE_DECIDED` | debitore | `expenseRef`, `decision`, `amount`, `reason?` |
| `PAYMENT_MADE` | debitore | `expenseRef`, `creditor`, `amount`, `rail: ln` (`paymentHash`, `preimage`) oppure `onchain` (`txid`) |
| `EXPENSE_VOIDED` | pagatore | `expenseRef` |
| `INVOICE_REISSUED` | pagatore | `expenseRef`, `debtor`, `bolt11` |
| `LINE_VOTED` | membro (né creditore né debitore della riga) | `expenseRef`, `debtor`, `outcome: due \| voided` *(aggiornato il 23/10)* |
| `MEMBER_BLOCKED` / `MEMBER_UNBLOCKED` | membro | `target` |
| `MEMBER_LEFT` | membro | nessun campo |
| `CHECKPOINT` | membro | `frontier`, `count`, `stateHash` |

Spariscono `RATE_SET`, `MEMBER_ADMITTED`, `CHANNELS_READY`, `DISPUTE_RESOLVED` (sostituito dal voto, *aggiornato il 23/10*), `GUARANTEE_PAID`, `MEMBER_EXCLUDED`, `TRIP_CLOSED`. Il `nonce` non serve più: l'unicità è data dall'`id`; `tripId` (nel contenuto) e `T` legano l'evento al viaggio.

Codice: `packages/shared/src/events.ts`, esportato come namespace `registry` finché il passo 2 non toglie `legacy-events.ts`.

## 7. Fattura fuori dalla firma del debitore (D2)

- `proposal` = `{ tripId, expenseId, payer, receipt, rate { pair, value, asOf, source, proof? }, assetId, assetDecimals, total, payerAmount, payerItemIndexes, lines: [{ debtor, amount, itemIndexes }] }`. **Nessuna fattura.**
- Al tavolo il debitore firma `proposalDigest = sha256("kitty:share:v1" ‖ JCS(proposal))` con la sua chiave del registro (Schnorr, stesso verificatore degli eventi).
- Il pagatore aggancia le fatture (`invoices`) nel proprio evento firmato e può sostituirle con `INVOICE_REISSUED` senza invalidare nessuna firma del tavolo. Motivi: senza rete il nodo non crea fatture (spike 3); le fatture scadono e si riemettono.
- **Regola di validazione (passo 2):** prima di pagare, l'app del debitore verifica che la fattura paghi il nodo legato al creditore con `kitty-bind`, e che importo e asset corrispondano alla quota firmata. Altrimenti la riga non si paga, né in automatico né a mano.

## 8. Alternative scartate

- **Tenere ed25519 accanto a Schnorr (doppia firma):** due formati da verificare per sempre; Nostr richiede Schnorr.
- **Ordine dei relay o per `created_at`:** dipende da chi consegna e da orologi falsificabili.
- **Fattura dentro la proposta firmata:** impedisce la firma offline e la riemissione (D2).
- **Contenuto in chiaro:** una chiave per viaggio non basta a non farsi collegare, perché `nodePubkey` e fatture rivelano lo stesso nodo in tutti i viaggi (D1).
- **`nostr-tools` nel ledger:** in `packages/shared` bastano poche righe su `@noble`; `nostr-tools` resta solo come oracolo nei test (e, nel passo 4, nel trasporto).

## 9. Conseguenze

- Passo 2: `deriveTrip` e `validateEvent` passano agli eventi v2 sopra `fixedOrder` e `conflicts.ts`; C8, C9, C14; regola della fattura (D2); `legacy-events.ts` sparisce.
- Passo 3: chiave NIP-06 per viaggio e `kitty-bind:v2` (§10), dietro `KITTY_REGISTRY=v2` (§11).
- Passo 4: `Transport` (`publish`, `subscribe`, `fetchMissing`) con Nostr come prima implementazione; il relay Fastify sparisce.

## 10. Chiave del registro per viaggio e `kitty-bind:v2` (passo 3) *(aggiornato il 22/10)*

- **Derivazione.** La seed BIP-39 del membro (64 byte, passphrase vuota: la stessa del nodo) e il percorso **NIP-06 `m/44'/1237'/<i>'/0/0`**, con un indice `i` per viaggio. Funziona offline, senza il nodo. Gli account sono hardened: le chiavi di due viaggi non hanno niente in comune che un relay possa collegare. Codice: `registryKey`, `seedFromMnemonic` in `packages/shared/src/registry-key.ts` (su `@scure/bip32` e `@scure/bip39`).
- **Indici.** `i` è un contatore locale: 0 per il primo viaggio, poi uno oltre il più alto in uso (`nextRegistryIndex`). Non deriva dal `tripId`: per ritrovare i viaggi basta la seed.
- **Recupero dalla seed** (`recoverTrips`). Si derivano le chiavi `i = 0, 1, 2…` e per ciascuna si chiedono ai relay gli eventi di quell'autore (`{"authors":[pk_i],"kinds":[7345]}`). Ci si ferma dopo **5 indici di fila senza eventi** (limite di gap, come BIP-44). Per ogni indice in uso, il segreto del viaggio si ritrova dal `TRIP_SECRET_SHARED` che il membro ha scritto verso sé stesso entrando (`tripSecretsOf`): si accettano solo eventi con firma valida, dell'autore stesso, che si aprono con la sua chiave e danno il segreto del tag `T` dell'evento. La parte senza rete è implementata e provata con un trasporto in memoria; la richiesta ai relay veri arriva con il passo 4. Per non collegare le chiavi tra loro, il passo 4 deve fare una richiesta per connessione, distribuite tra i relay e nel tempo.
- **Fattura di legame.** `bindInvoice` è una fattura del nodo del membro con `description = kitty-bind:v2:<tripTag>:<pubkey>`. Lega il nodo (`payee_pubkey`) alla chiave del registro di quel viaggio, quindi non si può riusare in un altro viaggio né per un'altra chiave. Non scade ai fini della prova e non si paga mai. Ogni telefono la verifica all'ingresso (`bindInvoiceRefusal`, chiamata da `validateRegistryEvent`). Da lì `nodePubkey` è il nodo che ogni fattura di quel membro deve pagare: `invoiceRefusal` lo controlla prima di ogni pagamento.
- **Scadenza delle fatture.** `invoiceExpirySeconds` vale **48 ore se il viaggio non dice altro**, e mai meno di 24. L'app crea le fatture con un margine di un'ora, perché la regola conta la durata dall'evento che le aggancia.
- **Test.** I vettori ufficiali di NIP-06 vengono scaricati da un commit fissato di `nostr-protocol/nips` e verificati con uno sha256 fissato nel test, perché NIP-06 non ne pubblica uno; senza rete la suite salta con un avviso (`registry-key.vectors.test.ts`). Gli altri test confrontano più account con `nostr-tools` e verificano che indici diversi diano chiavi diverse, che si recuperino più viaggi dalla stessa seed e che una fattura di legame con tripTag, chiave o nodo sbagliati venga rifiutata.

## 11. Le app sul registro v2: `KITTY_REGISTRY` *(aggiornato il 23/10)*

- **Flag.** `KITTY_REGISTRY=v1|v2`, predefinito `v1`. Con `v1` tutto resta com'era: registro vecchio, Dave coordinatore.
- **Con `v2` decide il registro nuovo** *(aggiornato il 23/10, sostituisce la doppia scrittura del 22/10)*. Le app leggono e scrivono **solo** il registro v2: ogni viaggiatore è un `RegistryAgent` (`apps/agent/src/flows/registry-agent.ts`) con la chiave del §10. Il registro vecchio non riceve più niente; il relay Fastify conserva solo i backup cifrati dei nodi (SPEC §12).
  - **Il ciclo dell'agente:** `LINE_SEEN`, silenzio-assenso e pagamento secondo `decideRegistryAutoPay` (con `invoiceRefusal` e `manual_only`), `PAYMENT_MADE`, riemissione delle fatture scadute, backup del nodo.
  - **Le azioni del membro:** spesa (quote calcolate dal ledger con il cambio salvato sul telefono, rifiutata prima di creare le fatture se `expenseRefusal` dice no), approvazione e contestazione (l'approvazione dopo una contestazione la ritira, C3), voto sulle contestazioni degli altri, annullamento, policy, blocco e sblocco, uscita.
  - **L'uscita:** `MEMBER_LEFT`, poi il wallet del membro chiude i propri due canali con l'LSP (`closeChannelsWith`). Se la chiusura fallisce, l'agente la ritenta.
- **Dave è solo l'LSP** *(aggiornato il 23/10)*. Non partecipa al registro (`LspAgent`, `lsp-agent.ts`): il suo nodo instrada i pagamenti e la sua liquidità si gestisce guardando solo i suoi canali (`peerChannels` del wallet: sotto 10.00 ricevibili da un membro, riapre fino a L). Le rotte di Dave come coordinatore (`resolveDispute`, `cover-and-exclude`, `rates`) rispondono `NOT_ALLOWED`.
- **Ingresso nella demo.** Il primo viaggiatore crea il viaggio v2; gli altri entrano con un suo invito. Il pacchetto dell'invito (segreto del viaggio e riferimento all'invito), che nella realtà viaggia in un QR, qui passa dentro il processo.
- **Trasporto provvisorio.** Fino al passo 4 gli eventi v2 viaggiano in un trasporto in memoria dentro il processo degli agenti (`registry-transport.ts`, interfaccia `publish`/`query`), e ogni agente li verifica uno per uno. Non c'è persistenza: a un riavvio degli agenti il registro v2 riparte da zero. Il passo 4 mette i relay Nostr dietro la stessa interfaccia e porta il confronto dei `CHECKPOINT`.
- **Limiti.**
  - L'LSP non vede le righe, quindi riapre liquidità dopo un pagamento, non prima: un rimborso più grande di quanto il creditore può ricevere fallisce finché l'LSP non ha riaperto, e l'agente del debitore ritenta.
  - Il cambio è l'ultimo salvato sul telefono (`infra/rates.json` in demo) fino al passo 5.
  - **Garanzia** *(aggiornato il 23/10)*: la copertura dell'operatore (`GUARANTEE_PAID` nel v1) non ha sostituto. Il debito di chi non paga resta, visibile a tutti, e si paga a mano; la maggioranza dei blocchi può escludere chi non paga, ma non rimborsa il creditore. In roadmap: garanzia senza custode (piano §0bis.6).
  - Il registro vecchio resta finché il passo 4 non è stabile; lo si toglie in una PR separata.

## 12. Trasporto Nostr (passo 4) *(aggiornato il 24/10)*

Vale solo con `KITTY_REGISTRY=v2`; con `v1` non cambia niente.

- **Interfaccia `Transport`** (`apps/agent/src/flows/registry-transport.ts`): `publish`, `subscribe`, `fetchMissing`, più `query` per il recupero dalla seed. Il registro non sa cosa c'è sotto: in demo `NostrTransport` (`apps/agent/src/relay/nostr-transport.ts`, NIP-01 sul `WebSocket` di Node 22, nessuna dipendenza nuova), nei test `MemoryTransport`.
- **Relay.** Tre relay strfry (`dockurr/strfry:1.1.3`) in Docker, solo regtest, porte su `127.0.0.1` (7001-7003, `KITTY_NOSTR_RELAYS`), elencati in `TRIP_CREATED.relays`. Sostituiscono, per il registro v2, il trasporto dentro il processo; il relay Fastify resta solo per i backup cifrati dei nodi. Ogni telefono ha il suo trasporto: pubblica su tutti i relay e legge da tutti. Kind 7345, contenuto NIP-44 con la chiave del viaggio (§3). Gli effimeri (27345, presenza) restano per il passo 7.
- **Relay che si ferma.** `publish` non fallisce per un relay spento: basta il primo che risponde OK. Quando il relay torna, dopo l'`EOSE` della sottoscrizione del viaggio, il telefono gli ripubblica ogni evento che il relay non gli ha restituito: così il relay recupera ciò che ha perso. Gli eventi sono firmati dai loro autori, e ripubblicarli non li altera.
- **Copia completa locale.** Ogni telefono salva su disco ogni evento verificato del viaggio, come arrivato e quindi ancora cifrato (`FileStore`, `infra/data/registry/<membro>.jsonl` in demo). A un riavvio il registro si ricostruisce da lì, anche senza rete. `demo:reset` cancella le copie e i dati dei relay.
- **Eventi mancanti** (piano §2.5, punti 1, 2 e 4). Un evento che cita un precedente assente resta in attesa e non si applica (`waiting`); il telefono chiede i genitori mancanti a tutti i relay (`fetchMissing`, `REQ {"ids": [...]}`), e li richiede ogni 5 s finché non arrivano. La richiesta effimera agli altri membri (punto 3) arriva con il passo 7.
- **Checkpoint** (piano §2.6). Li pubblica ogni membro attivo quando il suo stato è cambiato ed è fermo da 3 s, al massimo uno ogni 10 s in demo (`KITTY_CHECKPOINT_SECONDS`; in produzione 5 minuti). Il corpo dichiara esattamente ciò che cita: `frontier` = i genitori dell'evento, `count` e `stateHash` di quell'insieme. Ogni telefono verifica l'ultimo checkpoint di ciascun membro attivo:
  - **verificato** se ha tutti gli eventi citati e ricalcola lo stesso `count` e `stateHash` su di essi. Se no, un relay ha nascosto qualcosa, oppure c'è un bug;
  - **stesso stato** se, tolti i checkpoint stessi, copre esattamente gli eventi che il telefono ha.

  "Uguale su N/N" conta i checkpoint verificati e con lo stesso stato. I checkpoint si escludono dal confronto perché ogni checkpoint è a sua volta un evento: altrimenti due telefoni non coinciderebbero mai.
- **Recupero dalla seed.** `recoverTrips` scorre gli indici della chiave del viaggio finché 5 di fila restano vuoti, cercando gli eventi di ciascuna chiave nella copia locale e sui relay (`{"authors":[pk_i]}`). Il segreto si ritrova dal `TRIP_SECRET_SHARED` scritto verso sé stessi. `demo:lose-phone` con v2 reinstalla l'app sul nuovo telefono senza copia locale (`POST /api/:as/restore-from-seed`) e ritrova il viaggio dai soli relay.
- **Limite dichiarato.** I relay vedono i metadati: le chiavi del registro (una per viaggio e per membro), il tag del viaggio `T`, gli orari (`created_at`), la quantità e la dimensione degli eventi e chi è collegato quando. Non vedono il contenuto. Il recupero dalla seed fa una richiesta per chiave: in demo sulla stessa connessione, quindi un relay può collegare le chiavi di una stessa persona durante il recupero. Distribuire le richieste tra relay, connessioni e nel tempo resta da fare (§10).
