# ADR-001: formato degli eventi del registro (v2, Nostr)

> Stato: **accettato** il 21/10/2026 (revisione del team con i mentor, `docs/piano-migrazione-stack-a.md` §0bis). Fonte di verità: `docs/stack-a-decisioni.md`.
> Implementato nel passo 1 (branch `a/S1-nostr-envelope`; firme in `b/S1-schnorr`). Il registro della demo (`legacy-events.ts`, ed25519, relay Fastify) resta in uso fino al passo 2; `demo-finale-v1` è la demo di riserva.
> Le modifiche corrispondenti a `docs/SPEC.md` §9 sono proposte come diff in `docs/proposte/spec-9-registro.md`: vanno al PM.

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
- Codice: `packages/ledger/src/order.ts` (`fixedOrder`, `Causality`, `stateHash`). Test di proprietà su 1.000 grafi casuali: stesso insieme in qualsiasi ordine → stessa sequenza e stesso `stateHash`; `created_at` falsi senza effetto; un evento con un antenato mancante mai applicato; confronto con un'implementazione di riferimento a forza bruta.

### 4.3 "X precede Y"
- X precede Y se X è un antenato di Y (chiusura transitiva dei genitori). "Concorrenti" = nessuno dei due precede l'altro.
- **Noto** all'autore di E = tra gli antenati di E. Ogni evento cita il precedente del suo autore, quindi ciò che un autore ha visto resta antenato di tutto quello che scriverà: non lo si può dimenticare senza biforcare la propria catena (C15).

## 5. Regole di conflitto

**Lo spareggio sull'`id` si può minare.** Per questo le regole che muovono soldi guardano solo la causalità e il tipo di evento, mai l'ordine tra eventi concorrenti. L'ordine fisso decide solo i casi "primo vince" in cui vincere non porta vantaggi (duplicati, due dispositivi dello stesso membro). Ogni regola è una funzione pura in `packages/ledger/src/conflicts.ts`, con il suo test.

| # | Caso | Regola | Funzione |
|---|---|---|---|
| C1 | `approve` e `contest` concorrenti sulla stessa riga | vince `contest` | `lineDecision` |
| C2 | pagamento ed `EXPENSE_VOIDED` sulla stessa spesa | vince il pagamento, ovunque stia | `expenseVoided` |
| C3 | lo stesso debitore decide due volte in sequenza | vale la decisione successiva; la contestazione si ritira solo approvando dopo averla vista | `lineDecision` |
| C4 | due pagamenti validi della stessa riga | paga il primo nell'ordine; gli altri sono un credito del debitore verso il creditore | `settleLine`, `overpaid` |
| C5 | pagamento e `INVOICE_REISSUED` concorrenti | valido se la preimage corrisponde a una qualsiasi fattura della riga | `paymentMatchesLine` |
| C6 | due `INVOICE_REISSUED` concorrenti | tutte valide; si paga quella non scaduta con `id` minore | `invoiceToPay` |
| C7 | blocco e sblocco concorrenti dello stesso autore sullo stesso membro | vince il blocco; in sequenza vale l'ultimo | `isBlocked` |
| C8 | spesa concorrente con un blocco che la invaliderebbe | valida (il blocco non era noto) | passo 2 (TODO) |
| C9 | spesa concorrente con l'uscita del debitore | entrambe valide, il debito resta | passo 2 (TODO) |
| C10 | due spese con lo stesso `fingerprint` | vale la prima nell'ordine; l'altra è invalida, con l'avviso "scontrino già registrato" se l'autore è diverso | `duplicateFingerprints` |
| C11 | `EXPENSE_VOIDED` concorrente con `LINE_DECIDED` | vince l'annullamento (salvo C2) | `expenseVoided` |
| C12 | due `POLICY_UPDATED` concorrenti dello stesso membro | l'ultima nell'ordine | `effectivePolicy` |
| C13 | due `MEMBER_JOINED` con lo stesso invito | il primo nell'ordine | `joinsByInvite` |
| C14 | invito di un membro con un'uscita concorrente | valido (l'uscita non era nota) | passo 2 (TODO) |
| C15 | la catena personale di un autore si biforca | entrambi validi, autore segnato "registro biforcato"; un blocco è noto se precede almeno una delle sue teste | `forkedAuthors`, `authorHeads` |

C8, C9 e C14 dipendono dagli stati dei membri, che arrivano con il passo 2: oggi sono test `todo`.

## 6. Tipi e corpi

Importi in **unità base dell'asset**, come stringhe decimali (`amount`). La precisione è un parametro del viaggio: in demo DUSD con `assetDecimals = 2`, dopo la finale USDT a 6, senza cambiare il formato. Ogni riferimento a un altro evento è il suo `id` Nostr (`expenseRef`, `inviteRef`). Nessun tipo è riservato a un coordinatore.

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
| `MEMBER_BLOCKED` / `MEMBER_UNBLOCKED` | membro | `target` |
| `MEMBER_LEFT` | membro | nessun campo |
| `CHECKPOINT` | membro | `frontier`, `count`, `stateHash` |

Spariscono `RATE_SET`, `MEMBER_ADMITTED`, `CHANNELS_READY`, `DISPUTE_RESOLVED`, `GUARANTEE_PAID`, `MEMBER_EXCLUDED`, `TRIP_CLOSED`. Il `nonce` non serve più: l'unicità è data dall'`id`; `tripId` (nel contenuto) e `T` legano l'evento al viaggio.

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
- Passo 3: chiave NIP-06 per viaggio e `kitty-bind:v2`.
- Passo 4: `Transport` (`publish`, `subscribe`, `fetchMissing`) con Nostr come prima implementazione; il relay Fastify sparisce.
