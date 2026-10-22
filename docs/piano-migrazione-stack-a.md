# Migrazione a "Stack A · WDK node on the phone": analisi e piano

> **Decisioni del 21/10/2026.** La fonte di verità è il documento del team **"kit+ty Stack A: decisioni e piano"** (21/10/2026), salvato in [`docs/stack-a-decisioni.md`](stack-a-decisioni.md), con l'immagine dell'architettura "Soldi e firme restano sul telefono: fuori solo relay e LSP". Dove questo piano lo contraddiceva, ha vinto il documento del team, e il piano è stato riscritto di conseguenza.
> **Revisione del 21/10 sera** (team + mentor di Bitfinex/RGB, Utexo, Kaleidoswap): decisioni confermate, correzioni e calendario in §0bis. Dove §0bis contraddice il resto del piano, vale §0bis.
> Aggiornato il 21/10/2026. Le modifiche a `docs/SPEC.md` sono **proposte come diff** (§9) e vanno al PM (registro §20).
> **[V]** = verificato su una fonte (link, sorgente letto, file del repo, chiamata HTTP). **[I]** = ipotesi o proposta nostra. **[T]** = decisione del documento del team. **[R]** = decisione della revisione del 21/10 (§0bis). **[M]** = indicazione di un mentore, non ancora verificata da noi.
> Ricerca di base su WDK/UTEXO: `docs/piano-migrazione-wdk-utexo.md` (20/10). Quello che non serve più è in appendice A ("Rimandato").

## 0. Sintesi

1. **Demo su `rln-rest`, Stack A come obiettivo** [T]. Dave resta solo l'hub (lo "LSP" della demo), non è più membro del viaggio e non ha poteri. Il motore WDK si cambia per ultimo, quando UTEXO chiude i quattro problemi (§8).
2. **Si parte dal formato degli eventi** [T]. Busta Nostr (kind regolare 7345, firma Schnorr), riferimenti ai precedenti nei tag `e`, ordine fisso per ordinamento topologico con spareggio sull'id, e regole di conflitto definite sulla **causalità**, mai sull'ordine (§2).
3. **Registro senza poteri speciali** [T]: invito, blocco ed esclusione calcolata a maggioranza, uscita, quote firmate al tavolo. "Noto" diventa "presente tra gli antenati dell'evento" (§3). Tre punti del documento del team vanno chiusi prima del codice: Sybil sugli inviti, contestazioni senza arbitro, perimetro del pagamento manuale (§11).
4. **Chiave del registro** [T]: NIP-06 `m/44'/1237'/<i>'/0/0` dalla stessa seed, un indice per viaggio. È indipendente dalla chiave del nodo, che VLS deriva dai primi 32 byte della seed [V]. Funziona offline. Una chiave per viaggio non basta però a non farsi collegare: `nodePubkey` e fatture rivelano lo stesso nodo, quindi **il contenuto va cifrato** (§4).
5. **USDT a 6 decimali** [T]: l'asset si identifica solo per asset ID e la precisione diventa un parametro del viaggio. Impatto: circa 1.100 occorrenze di `cents` in 93 file [V] (§7).
6. **Pagamento che riparte** [T]: presenza effimera su Nostr (kind 27345) più push tramite un gateway "muto" che non legge i relay e non conosce membri né importi. Le fatture da 24 h si possono fare in RLN (`expiry_sec` u32) [V] (§5).
7. **Cambio:** Pyth Core firma USD/VND ed EUR/USD (ECDSA secp256k1, 3 firme su 5) ma richiede una API key, e il feed VND è chiuso nel weekend. Fallback non firmato: ExchangeRate-API (open access) [V] (§6).
8. **`LspProvider`** ricavato dalle API pubbliche di `utexo-lsp`, senza APay: oggi lo implementa Dave su rln-rest, con test di contratto sul `get_info` reale di `lsp-signet.utexo.com` (§8).

---

## 0bis. Revisione del 21/10: decisioni confermate, correzioni, calendario [R]

### 0bis.0 Regole di lavoro
- Fonte di verità: `docs/stack-a-decisioni.md`. Le modifiche a `docs/SPEC.md` si propongono come diff (§9), senza applicarle.
- `utexo-lsp` non ha licenza: se ne leggono le API pubbliche, il codice non si copia né si esegue.
- **Demo di riserva:** tag `demo-finale-v1` sul ramo principale del 21/10 (commit `d963464`). Non si modifica più. Come rilanciarla: `docs/status/a.md`.
- **Da qui in poi una PR entra nel ramo principale solo se `pnpm demo:reset && pnpm e2e:demo` passa ancora dall'inizio alla fine.**

### 0bis.1 Infrastruttura
- **Nessun membro con poteri speciali, nemmeno Dave.** In demo Dave è solo il nodo RLN che instrada: fa la parte dell'LSP Utexo. **Esce dal registro**: non firma eventi, non ammette, non fissa cambi, non risolve contestazioni, non esclude, non chiude il viaggio, **non legge il registro**. La sua liquidità la gestisce guardando solo i suoi canali, come farà l'LSP Utexo.
- **`LspProvider`** (§8.1): interfaccia ricavata dalle API documentate di Utexo, implementata oggi da Dave su `rln-rest`. Implementa **solo** le operazioni con un equivalente reale e non custodiale: `health`, `getInfo`, apertura e attesa del canale, ricezione e invio Lightning. **Non si implementano** i ponti `onchain_send` / `lightning_receive`: non sono atomici, nell'intervallo l'LSP tiene i fondi. Vanno in Roadmap (§0bis.6), da sostituire con gli swap. App e ledger non sanno che dietro c'è Dave.
- **Canali:** in demo restano i due canali per membro di oggi. "Uno o due" resta aperto (§8.2): dipende da Utexo e dagli swap.
- APay no; `enableVirtualChannelsV0` sempre `false`. Solo regtest, relay Nostr nostri in Docker, QVAC `~0.21.0`.
- **Asset:** il codice identifica l'asset solo per asset ID. USDT a 6 decimali e rinomina delle occorrenze esistenti di `cents` **dopo la finale**, in una PR meccanica separata (§7). In demo resta DUSD (NIA, presentato come USDT finto). Gli schemi **nuovi** del passo 1 usano già `amount` in unità base con `assetDecimals` nei parametri del viaggio: non c'è niente da rinominare dopo.

### 0bis.2 Notifiche push: servizio reale, compatibile LSPS5 (sostituisce il "gateway di sveglia" di §5.4)
- Componente reale dell'architettura finale: quando l'LSP saprà trattenere i pagamenti, chiamerà un webhook secondo **LSPS5**, e dietro il webhook c'è questo servizio.
- API compatibile con LSPS5 da subito: registrazione del webhook, notifica di pagamento in arrivo. Conosce solo token dei dispositivi e identificativi opachi: niente viaggi, nomi o importi. Non può muovere fondi né scrivere o alterare eventi.
- **In demo** lo chiama l'app del debitore quando vuole pagare; più avanti lo chiamerà l'LSP Utexo, senza cambiare il servizio.
- **Limite dichiarato:** il pagamento **non** viene trattenuto dall'LSP. Il debitore attende qualche decina di secondi e ritenta quando arriva la presenza del destinatario. Non si simula il trattenimento.
- Passo 7: fuori dai 5 giorni, salvo tempo avanzato.

### 0bis.3 Formato tecnico (approvato) e D1, D2
- Kind **7345** per il registro, **27345** per gli effimeri (presenza). Firme **Schnorr secp256k1** al posto di ed25519.
- Ordine fisso: ordinamento topologico sui riferimenti ai precedenti, spareggio sull'id; `created_at` non conta mai. Le regole di conflitto dipendono solo da "X precede Y".
- Chiave del registro NIP-06 `m/44'/1237'/<i>'/0/0`, un indice per viaggio, offline. Fattura di prova `kitty-bind:v2:<tripTag>:<pubkey>`. Fatture con scadenza predefinita di 48 ore.
- **D1, cifratura del contenuto: sì** (era già deciso: "cifratura del registro su Nostr: obbligatoria"). NIP-44 con la chiave del viaggio. Il segreto del viaggio si salva nel registro, cifrato verso la chiave di ogni membro; chi entra lo riceve con l'invito. **Limite:** chi esce o viene escluso conserva il segreto e legge gli eventi successivi. Rotazione del segreto in Roadmap.
- **D2, fattura fuori dalla firma del debitore: sì.** Il debitore firma righe, importi e cambio. Il pagatore aggancia la fattura alla spesa nel proprio evento firmato e può sostituirla con `INVOICE_REISSUED` senza invalidare la firma del debitore. **Nuova regola di validazione:** prima di pagare, l'app del debitore verifica che la fattura paghi il nodo legato al creditore con `kitty-bind` e che importo e asset corrispondano alla quota firmata; altrimenti la riga non si paga, né in automatico né a mano.
- Formato in dettaglio: `docs/ADR-001-formato-eventi.md`.

### 0bis.4 Regole del gruppo ancora aperte
Sybil sugli inviti (D3), contestazioni senza arbitro (D5), ambito del blocco (D6), fazioni (D10), cambio nel weekend (D11) restano **aperti**: non si decide niente. Nel passo 2 le regole si implementano come sono scritte nel documento del team; dove sono ambigue, un TODO con il riferimento alla domanda aperta e un test segnaposto; ogni regola si cambia in un solo punto.

### 0bis.5 Aggiunte
1. **Watchtower e transazione di punizione** (nuovo rischio, §8.3). [M] Una watchtower standard funziona se riceve la transazione di punizione già firmata, con dentro il commitment RGB. Ma la PR RGB-Tools/rgb-lightning-node#172 mostra che oggi, nella punizione, gli asset RGB dell'onesto vengono **bruciati** invece di tornargli (collegata, nel fork UTEXO: `rgb-lightning-node#210`, §10). Nel diagramma: l'LSP non può prendere i fondi, ma una sua frode oggi farebbe perdere gli asset (§13, punto 9).
2. **Interfaccia `Transport`** (`publish`, `subscribe`, `fetchMissing`), con Nostr come prima implementazione (passo 4). Il registro non sa cosa c'è sotto. Holepunch (Hypercore + Autobase) in Roadmap come alternativa da provare.
3. **Pagamenti asincroni RGB:** dipendono dal supporto RGB in BOLT12 (RGB-Tools/rgb-lightning-node#130) [M], senza date. Il modello resta "presenza + notifica + nuovo tentativo".
4. **Domande per Utexo:** aggiunte in §10, domande 6-9.
5. **Spike su beta.5** (task S3b, prima di mandare le domande a Utexo): lo spike 3 era su `wdk-rgb-lightning` `0.2.0-beta.4`, il riferimento è beta.5. Verificare su beta.5: firmatore strict, ripristino VSS, chiusura forzata. Massimo mezza giornata, nessun cambio di versione fissata nel codice dell'app.

### 0bis.6 Roadmap dopo la finale
- **Kaleidoswap** (spostato dall'appendice A): modulo `Swapper` accanto a `Wallet`, senza toccare registro e ledger. Punti di integrazione:
  1. caricare il canale (submarine verso la fattura del proprio nodo);
  2. ritirare a fine viaggio (reverse);
  3. pagare un esercente che accetta Lightning in BTC.

  1 e 2 sostituiscono i ponti fidati di Utexo e permetterebbero un canale solo per membro, ma funzionano solo se il maker supporta USDT anche sul lato Lightning (oggi solo BTC). 3 funziona già con il modello di oggi. Condizioni da chiarire con le risposte di Kaleidoswap e con lo spike 4 (`spike/swaps`, prompt separato). Nel frattempo niente che presupponga un modo specifico di finanziare i canali.
- Ponti `onchain_send` / `lightning_receive` di `LspProvider`: solo se diventano atomici, altrimenti sostituiti dagli swap.
- Rotazione del segreto del viaggio (limite di D1).
- Holepunch (Hypercore + Autobase) come `Transport` alternativo.
- Passo 5 (oracolo), passo 6 (QR), passo 7 (presenza e notifiche LSPS5), USDT a 6 decimali, `LspProvider` completa, passo 8 (motore WDK).

### 0bis.7 Calendario: 5 giorni
| Giorno | Cosa |
|---|---|
| 1-2 | Passo 1: formato degli eventi (§12) |
| 3 | Passo 2 ridotto: nuovi eventi (invito, ingresso, blocco, sblocco, uscita), Dave fuori dal registro, quote firmate al tavolo, regola della fattura (D2), righe da pagare a mano |
| 4 | Passo 3 (chiave del registro per viaggio, `kitty-bind:v2`) e passo 4 (2-3 relay Nostr in Docker al posto del relay Fastify, copia completa locale, recupero dei mancanti). Obiettivo: la demo "spengo un relay e il gruppo continua" |
| 5 | Margine, integrazione, prova completa della demo |

**Decisione finale:** il giorno prima della finale si sceglie quale demo presentare. Se la nuova non è stabile, si presenta `demo-finale-v1`.

---

## 1. Ordine di lavoro [T]

| # | Passo | Cosa produce | Dove (stream) | Complessità | Fatto quando |
|---|---|---|---|---|---|
| 1 | Formato degli eventi | Busta Nostr, tag dei precedenti, ordine fisso, regole di conflitto, firme Schnorr | `packages/shared` (A), `crypto.ts` (B) | M | Test di determinismo: stesso insieme di eventi in qualsiasi ordine di arrivo → stessa sequenza e stesso hash di stato (§2.7) |
| 2 | Regole del ledger | Nuovi eventi, blocco ed esclusione, uscita, quote del tavolo, righe "solo a mano" | `packages/ledger` (A) | L | Un test per regola (§3.6) più proprietà fast-check sui DAG concorrenti |
| 3 | Chiave del registro | Derivazione NIP-06 per viaggio, fattura di prova `kitty-bind:v2` | `packages/shared` (A), `apps/agent/src/wallet` (B) | S | Vettori di test NIP-06; fattura di prova verificata e rifiutata nei casi sbagliati |
| 4 | Trasporto Nostr | Pubblicazione su 2-3 relay, copia completa, recupero dei mancanti, `CHECKPOINT` | `apps/agent/src/relay` (C), `infra` (B) | M | Demo "spengo un relay e il gruppo continua"; un evento con un genitore mancante viene recuperato |
| 5 | Cambio | Oracolo, ultimo cambio salvato, avviso oltre 24 h, firma nella spesa | `apps/agent/src/flows` (A), UI (C) | S-M | Spesa con cambio salvato e firmato verificata da un altro telefono |
| 6 | Al tavolo senza internet | Proposta e firma via QR (multi-frame), poi Bluetooth | `packages/shared` (codifica pura), UI (C) | M | Bob firma offline; la firma finisce in `EXPENSE_SUBMITTED` e la riga è "da pagare" |
| 7 | Pagamento che riparte | Presenza, push, nuovo tentativo | flussi (A), gateway (B), UI (C) | M | Alice chiusa → push → Alice apre → Bob paga entro N s, senza azioni manuali di Bob se ha l'app aperta |
| 8 | Motore WDK | `KITTY_WALLET_ENGINE=wdk`, spike rifatto | `apps/agent/src/wallet` (B) | L | Le quattro condizioni di §10 sono verdi |

I passi 1-7 girano tutti su rln-rest e sulla UI web attuale; l'app mobile (Expo + Bare) arriva con il passo 8 o dopo. I diff di SPEC che servono a ogni passo sono in §9.

---

## 2. Passo 1: formato e ordine degli eventi

### 2.1 Busta Nostr [V NIP-01, I proposta]
- **Un solo kind regolare per tutto il registro: `7345`** (intervallo 1000-9999, "regular… expected to be stored by relays", NIP-01). Non risulta nella tabella dei kind del repo `nostr-protocol/nips` letta oggi. I kind 7374-7376 sono di Cashu (NIP-60).
- Evento NIP-01: `id = sha256([0, pubkey, created_at, kind, tags, content])`, `sig` = **Schnorr BIP-340 su secp256k1**. `pubkey` = chiave del registro del membro **per quel viaggio** (§4).
- **Tag** (solo quelli a una lettera sono indicizzati dai relay, NIP-01):
  - `["T", <tripTag>]`: indirizzo del viaggio, con `tripTag = hex(sha256("kitty:trip:v1" ‖ tripSecret))`. Il relay filtra per `#T` senza conoscere `tripId`.
  - `["e", <id>]`, uno per ogni **genitore**: tutte le teste che l'autore conosce al momento della scrittura, **sempre** compreso il suo evento precedente nel viaggio. Massimo 32 genitori [I].
  - Facoltativo `["expiration", …]` solo sugli effimeri (NIP-40).
  - **Mai** `["-"]` (NIP-70): gli eventi devono poter essere ripubblicati da altri membri per il recupero.
- **`content`** = JSON canonico (RFC 8785, già in `packages/shared/src/canonical.ts`) di `{ v: 2, tripId, type, body }`, **cifrato** con NIP-44 v2 usando una chiave di conversazione `HKDF(tripSecret, "kitty:content:v1")` [I]. La cifratura è proposta come default, con un interruttore per la demo (decisione D1, §11). Senza cifratura relay e osservatori vedono importi, nomi e il `nodePubkey` di ogni membro, che lega i viaggi della stessa persona (§4.4).
- `created_at`: solo informativo (§2.3).
- `tripSecret`: 32 byte casuali generati da chi crea il viaggio, passati nell'invito (QR o link). Non sono una chiave dei soldi.

### 2.2 Corpo degli eventi [T sull'elenco, I sui campi]
Spariscono `RATE_SET`, `MEMBER_ADMITTED`, `CHANNELS_READY`, `DISPUTE_RESOLVED`, `GUARANTEE_PAID`, `MEMBER_EXCLUDED`, `TRIP_CLOSED` [T].

Importi in **unità base dell'asset** come stringhe decimali (`"3090000"` = 3.09 USDT), campo `amount` invece di `cents` (§7).

| Tipo | Autore | `body` |
|---|---|---|
| `TRIP_CREATED` | chi crea | `name`, `params` (immutabili: `assetId`, `assetDecimals`, `displayDecimals`, `silentAssentSeconds`, `invoiceExpirySeconds` ≥ 86400, `rateMaxAgeSeconds` 86400, `oracles` ammessi), `relays` iniziali. È l'unico evento senza genitori. |
| `MEMBER_INVITED` | un membro | `inviteId`, `inviteePubkey?` (se noto), `expiresAt` |
| `MEMBER_JOINED` | il nuovo membro | `inviteRef` (id del `MEMBER_INVITED`), `displayName`, `nodePubkey`, `bindInvoice` (§4.3), `policy` |
| `POLICY_UPDATED` | membro | `policy` |
| `EXPENSE_SUBMITTED` | pagatore | `expenseId`, `proposal` (sotto), `tableSignatures: [{ signer, sig }]`, `lines: [{ debtor, amount, bolt11 }]`, `receiptImageSha256`, `fingerprint` |
| `LINE_SEEN` | debitore che non ha firmato al tavolo | `expenseRef` |
| `LINE_DECIDED` | debitore | `expenseRef`, `decision: approve \| contest`, `amount`, `reason?` |
| `PAYMENT_MADE` | debitore | `expenseRef`, `creditor`, `amount`, `rail`, `paymentHash` + `preimage` (o `txid`) |
| `EXPENSE_VOIDED` | pagatore | `expenseRef` |
| `INVOICE_REISSUED` | pagatore | `expenseRef`, `debtor`, `bolt11` |
| `MEMBER_BLOCKED` / `MEMBER_UNBLOCKED` | un membro | `target` |
| `MEMBER_LEFT` | il membro che esce | nessun campo (la validità dipende dagli antenati, §3.4) |
| `CHECKPOINT` | chiunque | `frontier: [id…]` (teste note), `count`, `stateHash` (§2.6) |

`expenseRef` = id Nostr dell'`EXPENSE_SUBMITTED` (32 byte hex): sostituisce `expenseEventHash`.

**`proposal` (il pezzo firmato al tavolo)** = `{ tripId, expenseId, payer, receipt (strutturato), items, assignment, rate, lines: [{ debtor, amount }], assetId, assetDecimals }`.
- `rate = { pair: "USD/VND", value: "<decimale>", asOf, source, proof? }` (§6). `proof` = blob firmato dell'oracolo, se c'è.
- `tableSignatures[i].sig` = Schnorr del membro `signer` su `sha256("kitty:share:v1" ‖ JCS(proposal))`, con la sua chiave del registro per il viaggio.

**Proposta che si discosta dal documento del team** [I]: la fattura (`bolt11`) **non** entra nella parte firmata, ma accanto (in `lines[].bolt11`, firmata solo dal pagatore come parte dell'evento). I motivi sono tre:
1. per creare una fattura il nodo di Alice deve essere sbloccato, e lo sblocco richiede la rete (spike 3, H [V]); se al tavolo non ha internet nessuno, la fattura non esiste ancora;
2. le fatture scadono e vengono riemesse (`INVOICE_REISSUED`), e la firma di Bob deve sopravvivere alla riemissione;
3. la sicurezza non cambia: la validazione controlla che ogni fattura sia intestata al nodo del pagatore e per l'importo e l'asset della riga.

Va confermato dal team (D2, §11).

### 2.3 Regola di ordinamento fissa [I, con dimostrazione]
**Insieme chiuso.** Un telefono applica solo gli eventi validi i cui genitori sono **tutti** presenti (chiusura causale). Gli altri restano "in arrivo" e non contano per i saldi.

**Ordine.** Algoritmo di Kahn sul DAG dei genitori. Tra gli eventi "pronti" (tutti i genitori già emessi) si sceglie sempre quello con **`id` lessicograficamente minore**. Si parte da `TRIP_CREATED`, che dev'essere unico: se ce ne fossero due con lo stesso `tripTag`, vale quello con id minore e l'altro è ignorato.

**Perché è deterministica:**
1. Il risultato dipende solo dall'insieme di eventi: non dall'ordine di arrivo, dal relay o da `created_at`.
2. Il grafo non può avere cicli: un evento cita un genitore tramite il suo `id`, che è l'hash del genitore. Per citare un evento successivo bisognerebbe conoscere in anticipo un hash che a sua volta dipende da chi lo cita, cioè una seconda preimmagine di sha256.
3. Kahn con una regola di scelta totale (l'ordine sugli `id`, che sono unici) produce **una sola** sequenza per un DAG dato.

Quindi due telefoni con lo stesso insieme chiuso calcolano la stessa sequenza e, se la derivazione è una funzione pura della sequenza, gli stessi saldi.

**`created_at` falsi o sbagliati.** Non entrano mai nell'ordine. Servono per la UI (data mostrata) e per due controlli "morbidi", che segnano l'evento nella UI senza invalidarlo:
- `created_at` più vecchio del massimo dei genitori di oltre 1 h;
- `created_at` nel futuro di oltre 10 minuti rispetto all'orologio locale.

Unica eccezione: le finestre temporali della policy (silenzio-assenso, tetto giornaliero) sono **decisioni locali** dell'agente che paga, con il suo orologio, come oggi. Non sono stato condiviso.

**Attenzione allo spareggio sull'id.** Un autore può "minare" l'id del proprio evento per vincere uno spareggio. Per questo **nessuna regola che cambia i saldi può dipendere dall'ordine tra eventi concorrenti**: le regole di conflitto (§2.4) guardano solo la causalità ("X è antenato di Y?") e il tipo di evento. L'ordine serve per la cronologia e per i pochi casi "primo vince" in cui vincere non porta vantaggi (duplicati, §2.4).

### 2.4 Regole di conflitto
"Concorrente" = nessuno dei due è antenato dell'altro.

| # | Caso | Regola | Fonte |
|---|---|---|---|
| C1 | `approve` e `contest` sulla stessa riga, concorrenti | vince `contest` | [T] |
| C2 | Pagamento ed `EXPENSE_VOIDED` sulla stessa spesa | vince il pagamento: un `EXPENSE_VOIDED` è ignorato se nell'insieme c'è un `PAYMENT_MADE` valido per una riga di quella spesa, in qualunque posizione | [T] |
| C3 | Lo stesso debitore decide due volte in sequenza causale (prima `contest`, poi `approve`, o viceversa) | vale la decisione causalmente successiva; con C1 la contestazione si ritira solo scrivendo dopo averla vista | [I] da confermare |
| C4 | Due `PAYMENT_MADE` validi per la stessa riga (fattura originale e riemessa, due dispositivi) | la riga è pagata dal primo in ordine; l'eccedenza diventa un **credito del debitore verso il creditore** (rimborso da fare a mano). I soldi si sono mossi davvero: non si ignora nulla | [I] |
| C5 | `PAYMENT_MADE` e `INVOICE_REISSUED` concorrenti | il pagamento è valido se la preimage corrisponde a **una qualsiasi** fattura emessa per quella riga | [I] |
| C6 | Due `INVOICE_REISSUED` concorrenti per la stessa riga | tutte valide; l'agente paga quella non scaduta con id minore | [I] |
| C7 | `MEMBER_BLOCKED` e `MEMBER_UNBLOCKED` concorrenti dello stesso autore sullo stesso membro | vince il blocco (prudente); in sequenza causale vale l'ultimo | [I] |
| C8 | `EXPENSE_SUBMITTED` concorrente con un `MEMBER_BLOCKED` che la renderebbe invalida | valida, perché il blocco non era noto (§3.2) | [T] + definizione [I] |
| C9 | `EXPENSE_SUBMITTED` concorrente con il `MEMBER_LEFT` di un debitore | la spesa è valida e il debito resta; l'uscita resta valida. L'uscito vede "hai un debito arrivato dopo l'uscita" e può saldarlo | [I] |
| C10 | Due `EXPENSE_SUBMITTED` con lo stesso `fingerprint`, concorrenti | vale il primo in ordine, l'altro è invalido; se sono dello stesso autore la differenza non conta, se di autori diversi chi perde vede l'avviso "scontrino già registrato" | [I] |
| C11 | `EXPENSE_VOIDED` concorrente con `LINE_DECIDED` | vince l'annullamento (salvo C2) | [I] |
| C12 | Due `POLICY_UPDATED` concorrenti dello stesso membro (due dispositivi) | vale l'ultimo in ordine; la policy è una preferenza locale, il vantaggio è nullo | [I] |
| C13 | Due `MEMBER_JOINED` con lo stesso invito | vale il primo in ordine, l'altro è invalido (un invito, un ingresso) | [I] |
| C14 | `MEMBER_INVITED` da un membro che ha un `MEMBER_LEFT` concorrente | valido (non era noto) | [I] |
| C15 | Evento di un autore la cui catena personale si biforca (due eventi dello stesso autore senza relazione causale tra loro: due dispositivi o un tentativo di "dimenticare") | entrambi validi; nella UI l'autore è segnato con "registro biforcato". Il blocco resta noto se è antenato di **almeno una** delle due teste dell'autore al momento della spesa (§3.2) | [I] |

### 2.5 Recupero degli eventi mancanti [I]
1. Un telefono riceve E con un genitore P sconosciuto: E entra tra gli eventi in arrivo.
2. Chiede `REQ {"ids":[P]}` a **tutti** i relay del viaggio, compresi quelli elencati in `TRIP_CREATED` e negli ultimi `CHECKPOINT`.
3. Se dopo T secondi nessun relay ha P, pubblica un **effimero** di richiesta (kind 27345, `type: "need"`, `ids: [P]`, cifrato). Un membro online che ha P lo **ripubblica** tale e quale: l'evento è firmato dal suo autore, ripubblicarlo non lo altera. Per questo niente NIP-70.
4. E diventa applicabile solo quando tutta la sua catena di antenati è presente.

### 2.6 Ruolo di `CHECKPOINT` [I]
- `frontier` = teste dell'insieme chiuso dell'autore. `stateHash = sha256(id₁ ‖ … ‖ idₙ)` nella sequenza fissa di §2.3.
- Un telefono che riceve un checkpoint con una testa sconosciuta sa che gli manca qualcosa e la recupera (§2.5). Se ha la stessa frontiera ma un `stateHash` diverso, c'è un bug: lo segnala.
- In UI resta "uguale su N/N telefoni" (SPEC §9.5), confrontando lo `stateHash` dell'ultimo checkpoint di ciascuno.
- Ogni agente ne pubblica uno quando cambia la frontiera, al massimo uno ogni 5 minuti.

### 2.7 Migrazione da ed25519 a Schnorr secp256k1 [V codice, I proposta]
- Oggi: `packages/shared/src/crypto.ts` (stream B) verifica ed25519 con `@noble/curves/ed25519.js`. La chiave dell'app deriva con HKDF dalla mnemonica (`apps/agent/src/wallet/rln-wallet.ts:123`). Il relay assegna `seq` e `prevHash` (`apps/relay/src/log.ts:65-72`), e `validateEvent` li controlla (`packages/ledger/src/validate.ts:61-65`).
- Dopo:
  - `SignatureVerifier.verify(pubkey, message, sig)` resta come interfaccia; l'implementazione diventa `schnorr.verify` di `@noble/curves/secp256k1` (stessa libreria, già dipendenza) sull'`id` NIP-01;
  - `StoredEvent` sparisce: l'evento Nostr **è** l'evento memorizzato, senza `seq`, `prevHash` o `receivedAt` del relay;
  - `validateEvent(event, closedSet, deps)` riceve l'insieme degli antenati invece della testa.
- `nostr-tools` 2.25.2 (Unlicense) per serializzazione, firma e pool; in alternativa solo `@noble` per non aggiungere dipendenze al ledger. **Proposta:** `nostr-tools` solo in `apps/agent/src/relay` (trasporto); in `packages/shared` le ~30 righe di serializzazione NIP-01 con `@noble`, testate sui vettori di NIP-01.
- La busta ed25519 non si conserva in parallelo (niente doppia firma): le firme del registro diventano tutte Nostr. La regola "ogni evento è firmato dal suo autore" (CLAUDE.md, regola 6) resta vera.
- **Task del passo 1:** elenco in §12.

---

## 3. Passo 2: regole del ledger

### 3.1 Stato dei membri, calcolato dagli eventi [T → regole I]
Per ogni membro m, sulla sequenza fissa:
- **attivo**: ha un `MEMBER_JOINED` valido e nessun `MEMBER_LEFT` valido;
- **bloccato da a**: l'ultimo evento tra `MEMBER_BLOCKED(a→m)` e `MEMBER_UNBLOCKED(a→m)` è un blocco (C7);
- **escluso**: `|{a ≠ m : a attivo, a blocca m}| > (|attivi| − 1) / 2`. È calcolato, non è un evento [T], e decade se i blocchi scendono sotto la soglia [T]. [I] **Contano i blocchi di tutti i membri attivi, anche se esclusi a loro volta**, per evitare la circolarità (A esclude B che esclude A…). Lo scenario "due fazioni" porta a esclusioni reciproche: è deterministico, ma va mostrato.
- **viaggio finito**: tutti i membri hanno `MEMBER_LEFT` [T]; calcolato.

### 3.2 Cosa significa "noto" in un registro senza ordine globale [I]
**Definizione:** l'evento X è **noto** all'autore di E se X è tra gli antenati di E (chiusura transitiva dei tag `e`).

**Regola di validazione:** un `EXPENSE_SUBMITTED` di a che addebita d (oppure, in senso opposto, una spesa di d che addebita a) è **invalido** se tra i suoi antenati c'è un blocco a→d (o d→a) ancora in vigore nello stato calcolato sui soli antenati. Lo stesso vale con "d escluso" calcolato sui soli antenati.

**Perché è difficile da aggirare.** Ogni evento di un autore deve citare il suo evento precedente (§2.1), quindi ciò che un autore ha visto una volta resta antenato di tutto quello che scriverà dopo: non lo si può "dimenticare". Per ignorare un blocco bisogna non averlo mai citato e non citare nessun evento che lo discende, cioè isolarsi dal resto del registro, e questo si vede (C15).

**Se qualcuno lo aggira comunque** (spesa scritta "prima" in modo artificioso), il danno è limitato da due regole del team: il debito verso chi è bloccato o escluso **non si paga in automatico** [T], e la riga si può contestare.

### 3.3 Righe "solo a mano" e pagamento automatico [T → I]
`decideAutoPay` restituisce `pay: false` con un motivo nuovo nei casi seguenti:
- `creditor_blocked`: il debitore blocca il creditore. [I] Il blocco di un **terzo** non conta: il documento del team non è chiaro su questo punto (§11);
- `creditor_excluded`;
- `line_contested`.

Il pagamento **manuale** resta sempre possibile [T], anche su una riga contestata [I]: un `PAYMENT_MADE` su una riga contestata è valido e la chiude.

Le quote **firmate al tavolo** sono subito `due` [T], senza `LINE_SEEN` né silenzio-assenso. [I] La firma al tavolo vale come **approvazione esplicita**: si pagano in automatico anche sopra `autoPayLimit`, ma restano sotto il tetto giornaliero (D4, §11).

### 3.4 Uscita [T → I]
`MEMBER_LEFT` di m è valido se, **nello stato calcolato sui suoi antenati**, m non ha debiti aperti. [I] Contano come debiti aperti anche le righe contestate in cui m è debitore. Le righe `paid`/`voided` non contano.

Si può uscire con crediti da incassare [T]. L'uscito deve però riaprire l'app per incassare, perché il pagamento richiede che il destinatario sia online (§5). I debiti arrivati in concorrenza dopo l'uscita restano e possono essere saldati (C9).

### 3.5 Stati di una riga (nuovi)
| Stato | Ingresso | Uscita |
|---|---|---|
| `submitted` | `EXPENSE_SUBMITTED` senza firma al tavolo del debitore | `awaiting_decision` con `LINE_SEEN` |
| `awaiting_decision` | `LINE_SEEN` | `due`, `contested`, `awaiting_explicit` (come oggi) |
| `awaiting_explicit` | silenzio-assenso non applicabile | `due`, `contested` |
| `due` | firma al tavolo, approvazione o silenzio-assenso | `paid` |
| `manual_only` | `due` ma il creditore è bloccato dal debitore o escluso (**stato derivato, reversibile**) | `due` (sblocco), `paid` |
| `contested` | `LINE_DECIDED{contest}` (C1) | `due` (C3, se il debitore approva dopo), `paid` (a mano), `voided` (annullamento del pagatore) |
| `paid` | `PAYMENT_MADE` valido | finale |
| `voided` | `EXPENSE_VOIDED` (C2, C11) | finale |

Spariscono `overdue` e `guaranteed` [T, niente garanzia]. [I] La scadenza `PAYMENT_DEADLINE` resta solo come etichetta di UI ("in ritardo da 3 giorni"), senza effetti sullo stato.

### 3.6 Cosa cambia in `packages/ledger` e nei test [V file, I modifiche]
| File | Cambiamento |
|---|---|
| `src/kitty.ts` (432 righe) | `deriveTrip(events, now)` riceve un insieme di eventi Nostr: chiusura causale, ordine di §2.3, poi la riduzione come oggi. `MemberState` + `invitedBy`, `blocks: Set`, `left`; `excluded` calcolato. Tolti i casi `RATE_SET`, `MEMBER_ADMITTED`, `CHANNELS_READY`, `DISPUTE_RESOLVED`, `GUARANTEE_PAID`, `MEMBER_EXCLUDED`, `TRIP_CLOSED`. `head` diventa `frontier` + `stateHash`. |
| `src/validate.ts` (376 righe) | Via `seq`/`prevHash` (righe 61-65); nuove regole: invito, `MEMBER_JOINED` con fattura di prova, "noto" sugli antenati, `MEMBER_LEFT` senza debiti, `tableSignatures` (firma valida, firmatario = debitore della riga, proposta identica), cambio (età e firma dell'oracolo, §6), fatture ≥ `invoiceExpirySeconds`; tolte le regole "solo Dave". |
| `src/autopay.ts` | Motivi nuovi (§3.3); tolti `guaranteed`/`overdue`; quote del tavolo. |
| `src/asset.ts`, `src/money.ts`, `src/fx.ts`, `src/shares.ts`, `src/expense.ts` | Precisione come parametro (§7). |
| `src/liquidity.ts` | `liquidityPlan` esce dal ledger del viaggio: Dave non è più membro e non legge il registro. Diventa logica dell'hub (`LspProvider`, §8), alimentata dalla richiesta dei membri di inbound [I] (D7). |
| Test | `test/kitty.test.ts`, `examples.test.ts`, `properties.test.ts` (nuove proprietà: invarianza rispetto all'ordine di arrivo su DAG casuali con rami concorrenti; esclusione a soglia; C1-C15 uno per uno), `validate-real.test.ts` del relay (da spostare: il relay non valida più). |
| `packages/shared/src/events.ts`, `domain.ts`, `views.ts`, `api.ts` | Schemi zod dei nuovi eventi; `TripParams` nuovi; viste senza Dave (contestazioni e insolvenze di Dave spariscono). |

I diff di SPEC per §5, §6, §7, §8, §9 sono in §9.

---

## 4. Passo 3: chiave del registro

### 4.1 Derivazione [V NIP-06 e codice WDK, I scelta]
- **Seed:** BIP-39 → 64 byte, passphrase vuota. È la stessa che riceve `WalletManagerRgbLightning` (`@tetherto/wdk-wallet` `WalletManager` accetta la frase e fa `mnemonicToSeedSync`) e, oggi, il nodo RLN.
- **Chiave del nodo:** WDK beta.5 passa a VLS i **primi 32 byte** della seed (`wdkSeedToNodeSeedHex`, `src/wallet-manager-rgb-lightning.js`, modalità `wdk-seed-v2`). VLS ne deriva la chiave del nodo con lo stile LDK, che lo spike 3 ha riprodotto in TS puro come BIP-32 `m/0'` su quei 32 byte (`spikes/wdk-lsp/02b-derive-node-key.ts`).
- **Chiave del registro per il viaggio i:** BIP-32 sui **64 byte** della seed, percorso **NIP-06 `m/44'/1237'/<i>'/0/0`** (l'account di NIP-06 = indice del viaggio). Radici diverse (64 byte contro 32 byte) e soli passi hardened: la chiave del registro non rivela quella del nodo, né il contrario.
- **Offline:** solo JS (`@scure/bip32`, già dipendenza di `wdk-wallet-rgb`, oppure `@noble`). Non serve il nodo sbloccato.
- **Con WDK su mobile:** la seed sta nel worklet (secret manager). Il worklet espone due sole chiamate, `registryPubkey(i)` e `registrySign(i, eventId)`, senza mai restituire la seed. Così la firma degli eventi non dipende dallo sblocco del nodo e il codice che firma eventi non può pagare (§5.6).
- NIP-06 è segnato "unrecommended" nel repo dei NIP ("prefer a single nsec"): l'avviso riguarda l'uso generico; per noi servono proprio più chiavi dalla stessa seed [V testo, I valutazione].

### 4.2 Indici e recupero [I]
- Indice `i` = contatore locale: 0 per il primo viaggio, poi +1. **Non** derivato da `tripId`, altrimenti chi ripristina dalla seed dovrebbe conoscere gli id dei viaggi.
- **Recupero dalla seed:** si derivano le chiavi `i = 0, 1, 2…` e per ciascuna si interroga un relay (`{"authors":[pk_i], "kinds":[7345], "limit":1}`), fino a 5 indici consecutivi senza risultati (limite di gap, come BIP-44). Per non collegare le chiavi: una richiesta per connessione, distribuite tra i relay e nel tempo.
- **Ma per decifrare i contenuti serve `tripSecret`**, che non sta nella seed. Proposta: ogni membro, all'ingresso, pubblica un evento personale "chiave del viaggio" con `tripSecret` cifrato verso **sé stesso** (NIP-44, chiave del registro i) [I]. Chi recupera la seed ritrova così sia gli eventi sia il segreto. Il team scrive "chi recupera la seed recupera tutto" [T]: questo è il pezzo che lo rende vero.

### 4.3 Fattura di prova all'ingresso [V oggi, I nuovo formato]
- **Oggi:** `MEMBER_JOINED.bindInvoice` = invoice del nodo con `description = kitty-bind:<sha256(appPubkey)>`; Dave verifica `payee_pubkey` prima di `MEMBER_ADMITTED` (SPEC §9.1).
- **Nuovo:** `bindInvoice` = BOLT11 creato dal **nodo del membro** (`/lninvoice` su rln-rest; `createInvoice` su WDK), con `amt_msat` = `rgb_htlc_min_msat` o nullo, `expiry_sec` qualsiasi e `description = "kitty-bind:v2:" ‖ tripTag ‖ ":" ‖ registryPubkey`.
- **Validazione (ogni telefono):** firma BOLT11 valida; `payee_pubkey` = `nodePubkey` dichiarato; `description` esatta (lega chiave, viaggio e nodo, quindi nessun riuso in un altro viaggio). **Non conta la scadenza** della fattura: serve solo come firma. Non va mai pagata; la UI non la mostra.
- Si crea online (il nodo dev'essere sbloccato), ma l'ingresso avviene comunque online.
- Alternative scartate: `/signmessage` di RLN `d4762ac` firma la stringa vuota [V]; `sign()` di WDK funziona [V], ma non con rln-rest; BIP-322 (beta.5) firma con l'indirizzo on-chain, non con l'identità del nodo. La fattura vale per entrambi i motori.

### 4.4 Cosa ottiene davvero "una chiave per viaggio" [I]
Le chiavi diverse impediscono ai relay di collegare i viaggi **solo se il contenuto è cifrato**. `nodePubkey` (in `MEMBER_JOINED`) e ogni `bolt11` (che contiene il `payee_pubkey`) sono gli stessi in tutti i viaggi della persona, perché il nodo è uno solo. Restano visibili ai relay: tag `T`, tag `e`, dimensioni e tempi. Da qui la proposta di cifrare `content` (§2.1, D1).

---

## 5. Passo 7: pagamento che riparte, presenza e notifiche push

### 5.1 Perché serve [T, V]
Niente APay [T]. Un pagamento Lightning richiede che **pagatore, hub e destinatario** siano online insieme. Con il destinatario offline l'hub rimanda indietro l'HTLC in circa 5 s, senza perdite (spike 3, G [V]).

### 5.2 Messaggio di presenza (effimero) [V NIP-01, I design]
- Kind **27345** (intervallo 20000-29999: "ephemeral… not expected to be stored by relays", NIP-01), non registrato nella tabella dei NIP.
- Tag: `["T", tripTag]`, `["expiration", now+120]` (NIP-40, per i relay che non buttano subito gli effimeri). Firmato con la chiave del registro, ma **non** è un evento del registro: nessun tag `e`, mai citato, mai applicato da `deriveTrip`.
- `content` cifrato come il registro: `{ type: "presence", until: <unix>, canReceive: true, pendingIn: n }` oppure `{ type: "need", ids: […] }` (§2.5).
- Inviato all'apertura dell'app, ogni 60 s mentre l'app è in primo piano, e subito prima della chiusura con `until = now`. Gli altri telefoni tengono in memoria l'ultima presenza di ciascuno.

### 5.3 Notifiche push: flusso [I]
- **Il debitore vuole pagare, il creditore è chiuso:**
  1. L'agente di Bob ha una riga `due` verso Alice e nessuna presenza recente di Alice.
  2. Bob mette il pagamento in coda e chiede al gateway una **sveglia** per Alice (§5.4).
  3. Alice riceve "kit+ty: c'è un aggiornamento nel tuo gruppo" e tocca.
  4. L'app di Alice si apre, sblocca il nodo (secondi), si collega all'hub e pubblica la presenza.
  5. L'agente di Bob, se l'app di Bob è aperta, vede la presenza e paga. Se intanto Bob ha chiuso l'app, l'app di Alice manda una sveglia a Bob ("pagamenti in attesa").
  6. Bob tocca: la sua app si apre, vede Alice presente e paga.
- **Il creditore apre e il debitore è chiuso:** all'apertura l'agente di Alice vede le righe `due` a suo favore e manda una sveglia a ciascun debitore la cui presenza è assente. L'app di Alice mostra "In attesa di 2 pagamenti, resta aperta" con un conto alla rovescia.
- **Finestra di incontro:** chi si apre per una sveglia resta "pronto a ricevere" per 10 minuti in primo piano [I]. Su iOS non si può tenere vivo il nodo in background: il worklet viene sospeso e l'app con socket aperti viene chiusa "usually within a few seconds" [V, Holepunch]. La notifica non può far pagare o ricevere da sola, serve il tocco dell'utente.

### 5.4 Notifiche push: architettura [V Expo, I design]
> **Superato da §0bis.2 [R]:** il servizio di notifiche ha un'API compatibile **LSPS5** (registrazione del webhook, notifica di pagamento in arrivo); in demo lo chiama l'app del debitore, poi lo chiamerà l'LSP. Il resto di questa sezione (cosa conosce, testo fisso, limiti di frequenza, Expo/FCM/APNs) resta valido come requisito.

- **Gateway di sveglia** (servizio nostro o dell'operatore, piccolo, sostituibile). Due API:
  - `PUT /tokens/:pushId`: il telefono registra il token push del dispositivo con un `pushId` casuale **per viaggio** e un segreto `wakeSecret`.
  - `POST /wake/:pushId` con `HMAC(wakeSecret, ts)`: manda una notifica senza contenuto a quel token.
- `pushId` e `wakeSecret` viaggiano **dentro il registro cifrato** (campo di `MEMBER_JOINED` o un `POLICY_UPDATED`), quindi li conoscono solo i membri.
- **Cosa conosce il gateway:** token del dispositivo, `pushId` (opaco), orari delle sveglie, IP di chi chiede. **Non conosce:** viaggi, chiavi del registro, nomi, importi, eventi.
- **Perché non un servizio che ascolta i relay** (l'idea del team): dovrebbe filtrare gli eventi per destinatario, quindi conoscere le chiavi del registro di tutti e il grafo dei pagamenti. Il modello "a sveglia diretta" vede meno. Esiste un precedente open source del modello "ascolta i relay" (Nopu, server di sottoscrizione + server push [V ricerca, non letto il codice]).
- **Trasporto:**
  - **Expo Push**: gratuito, limite di 600 notifiche al secondo per progetto; Expo non conserva il contenuto "any longer than it takes to deliver" [V, Expo FAQ].
  - In produzione: FCM e APNs diretti dal gateway, con le credenziali dell'app (Expo lo permette con `getDevicePushTokenAsync`) [V].
  - Senza account Apple developer non ci sono push su iOS [I noto].
- **Coerenza:** il gateway non vede né firma eventi e non parla con nodi o LSP. Il peggio che può fare è non svegliare (UX) o svegliare troppo (fastidio, mitigato dal limite di frequenza). Non decide nulla: il pagamento parte sempre dall'agente del debitore, dopo `validateEvent` + `decideAutoPay`.

### 5.5 Contenuto, affidabilità e UX [I]
- **Testo fisso, senza nomi né importi:** "kit+ty: c'è un aggiornamento nel tuo gruppo". Nessun dato nel payload, a parte un `kind: "wake"` costante.
- **Limiti:** al massimo una sveglia per coppia (mittente, destinatario) ogni 30 minuti, e 6 al giorno. Il gateway rifiuta oltre soglia (HTTP 429).
- **Notifica persa o ignorata:** il pagamento resta in coda. Ogni apertura di uno dei due rimette in moto il giro; l'agente riprova con backoff (1, 5, 30 minuti) finché l'app è aperta.
- **Cosa vede il pagatore:** "Pronto a pagare 3.09 ad Alice: aspetto che apra kit+ty (avvisata 12 minuti fa)". Il destinatario vede "Bob vuole pagarti: tieni aperta l'app".
- **Fattura scaduta nel frattempo:** l'agente del creditore riemette (`INVOICE_REISSUED`) appena è online e il debitore riprova.

### 5.6 La garanzia "l'AI non paga mai" con le presenze [I]
Aggiornata rispetto alla versione del 20/10:
- **Capacità:** l'AI ha solo tool di lettura e proposta (QVAC `tools` o MCP con trasporto in memoria). Un test verifica che nessun tool raggiunga `Wallet.pay` o `registrySign`.
- **Processi:** nel worklet WDK, `pay()` e `registrySign()` sono chiamate separate. Il loop dei pagamenti è l'unico chiamante di `pay()` e rifà `validateEvent` + `decideAutoPay` sullo stato derivato.
- **Policy:** `decideAutoPay` resta l'unico punto che autorizza un pagamento automatico.
- Presenze e push innescano solo un **nuovo tentativo** di decisioni già prese dal ledger, mai una decisione nuova.

### 5.7 Fatture da 24 ore su RLN [V]
- In RLN `d4762ac` `LNInvoiceRequest.expiry_sec` è `u32` (`src/routes.rs:892`) e finisce in `Bolt11InvoiceParameters.invoice_expiry_delta_secs` di LDK 0.2 (`routes.rs:3016`). La scadenza è salvata in `expires_at` (`routes.rs:3043`).
- In LDK (`lightning/src/ln/inbound_payment.rs`) la scadenza assoluta è `highest_seen_timestamp + invoice_expiry_delta_secs + 7200` e deve stare in 48 bit: **nessun limite pratico** sotto i 136 anni. 86.400 s vanno bene. L'OpenAPI non fissa un massimo.
- Limiti reali:
  1. la fattura non rende il pagamento asincrono: Alice dev'essere online quando Bob paga;
  2. con un HTLC minimo di 3.000.000 msat per pagamento (SPEC §10.1), le fatture aperte non bloccano liquidità finché nessuno le paga;
  3. [I] su WDK il percorso è lo stesso (stesso RLN), ma con `wdk-rgb-lightning` non l'abbiamo provato.
- **Default proposto:** `invoiceExpirySeconds = 172800` (48 h, come la "produzione" di SPEC §15), minimo 86.400 [T].

---

## 6. Passo 5: cambio valuta

| Oracolo | Copertura [V] | Firma [V] | Costo e limiti | Fonte |
|---|---|---|---|---|
| **Pyth Core** (Hermes) | `FX.USD/VND` (orario Asia/Ho_Chi_Minh 08:00-17:00 nei giorni feriali, chiuso nel weekend e nelle festività elencate), `FX.EUR/USD` e altri 5 EUR/x | **ECDSA secp256k1, quorum 3 di 5 router** su una radice Merkle; il prezzo si prova con una prova Merkle. Prima dell'upgrade del 26/08/2026: 13 su 19 guardiani Wormhole | **API key obbligatoria dal 26/08/2026** (la richiesta senza chiave risponde `unauthorized`, provato oggi). Prezzo non pubblicato. Verifica off-chain in TS non documentata [I fattibile con `@noble`] | [catalogo Hermes](https://hermes.pyth.network/v2/price_feeds?query=VND&asset_type=fx), [upgrade](https://docs.pyth.network/price-feeds/core/upgrade), [how it works](https://docs.pyth.network/price-feeds/core/upgrade/how-it-works) |
| **ExchangeRate-API, open access** (`open.er-api.com`) | USD base con VND ed EUR (oggi 25.846,20 VND e 0,89075 EUR per 1 USD, aggiornato 21/10 00:02 UTC) | **nessuna** | Gratuito senza chiave, aggiornato una volta al giorno, `cache-control: max-age=3600`, attribuzione richiesta [I sui termini, non letti] | [exchangerate-api.com](https://www.exchangerate-api.com) |
| **fawazahmed0/currency-api** (jsDelivr) | VND, EUR e altre (oggi 25.888,92 VND) | nessuna | Gratuito via CDN, giornaliero | [jsDelivr](https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json) |
| Frankfurter / BCE | EUR, USD e altre ~30 | nessuna | Gratuito, **niente VND** [V] | [frankfurter.dev](https://api.frankfurter.dev/v1/latest?base=USD) |

**Proposta** [I]:
- **Pyth come fonte firmata** (se la chiave si ottiene a costo zero o basso, domanda D6). Nella spesa va il blob firmato (`rate.proof`). I telefoni verificano firma e quorum con le chiavi pubbliche dei router: va chiesto a Pyth dove sono pubblicate.
- **ExchangeRate-API come riserva non firmata.** La spesa riporta `source` e `asOf`, e la UI mostra "cambio non firmato".
- **Attenzione:**
  1. il feed USD/VND di Pyth è fermo nel weekend, quindi il lunedì mattina il cambio ha più di 24 h e l'avviso del team scatta sempre. [I] Va scritto "più vecchio di 24 ore di mercato", oppure il limite passa a 72 h per i feed con orario.
  2. il blob di Pyth può pesare qualche KB: al tavolo va nel QR multi-frame, oppure Bob verifica dopo, online [I].
  3. un cambio firmato impedisce di **inventare** un tasso, non di scegliere **tra i tassi firmati** quello più comodo. L'età massima e la contestazione restano le difese.

---

## 7. Asset USDT a 6 decimali [T, V impatto]

- **Oggi:** `packages/ledger/src/asset.ts` fissa `ASSET_PRECISION = 2` e la conversione cent ↔ unità 1:1. `infra/treasury/seed.ts:58-62` emette `ticker: 'DUSD', precision: 2`. `cents`/`Cents` compare **1.094 volte in 93 file** (packages, apps, treasury) [V, grep di oggi].
- **L'asset ID è già l'unico identificatore nel codice:** `seed-state.json` → `assetId` → `RlnWalletOptions.assetId`. Il ticker compare solo nei log e nei commenti [V grep]. La regola "solo asset ID" è quasi già rispettata; restano log e testi.

**Proposta** [I]:
1. **Parametri del viaggio** (in `TRIP_CREATED.params`, immutabili): `assetId`, `assetDecimals` (6), `displayDecimals` (2). Il ticker viene dai metadati dell'asset (`/listassets`) e serve solo per la visualizzazione.
2. **Unità del ledger** = unità base dell'asset (`bigint`). **Arrotondamento delle quote** al passo `10^(assetDecimals − displayDecimals)` = 10.000 unità (un "cent"), così le quote restano leggibili e il resto dell'arrotondamento va con la regola attuale. Le funzioni `fx.ts`, `shares.ts`, `allocate.ts` e `rational.ts` diventano generiche sul passo; la proprietà fast-check "Σ righe + quota pagatore = totale" resta.
3. **Rinomina** `cents` → `amount` (eventi, viste, API) con un passo meccanico separato; i test esistenti restano validi moltiplicando per 10⁴ nelle fixture.
4. **UI:** `apps/web/src/ui/Money.tsx` formatta con `displayDecimals` e il ticker dai metadati.
5. **Tesoreria e seed:** `seed.ts` emette `name: 'Tether USD (regtest)', ticker: 'USDT', precision: 6` (il nome è libero su regtest, la UI non lo usa come identità). Gli importi passano a micro-unità (D 50 USDT = 50.000.000, L 30 USDT, on-ramp 100 USDT, emissione 10.000 USDT = 10¹⁰ unità). I numeri JSON verso RLN restano sotto 2⁵³.
6. **SPEC §15:** "La cena" diventa 3,09 / 3,09 / 3,50 USDT = 3.090.000 / 3.090.000 / 3.500.000 unità.
7. **Rischio [V fonti UTEXO, I conseguenza]:** l'USDT reale su RGB potrebbe non essere **NIA**:
   - l'LSP pubblico usa **LNUSDT con schema IFA**;
   - per Utexo "Mainnet IFA is rejected by the current upstream library" e su mainnet servono asset **BFA** con bridge (`PRODUCTION-GATES.md` S04 di beta.5);
   - "cambia solo la configurazione" vale solo se il codice usa API indipendenti dallo schema (oggi `/lninvoice` e `/sendrgb` lo sono [V], `listAssets` raggruppa per schema [V]). Va verificato con UTEXO (§10, domanda 5).

---

## 8. LSP e canali

### 8.1 `LspProvider` (interfaccia proposta, `apps/agent/src/lsp/types.ts`, stream B) [V forme, I interfaccia]
Ricavata **solo** dalla documentazione pubblica di `utexo-lsp` (README) e dai tipi Apache-2.0 di `@utexo/wdk-rgb-lightning` beta.5 (`LspClient`, `UtexoLsp`, `LspInfo`). Nessun codice di `utexo-lsp` viene copiato o eseguito, perché il repo non ha licenza [T].

```ts
interface LspProvider {
  health(): Promise<{ ok: boolean }>                                  // GET /health
  getInfo(): Promise<LspInfo>                                         // GET /get_info (u64 come stringhe; campi extra ignorati)
  connect(): Promise<void>                                            // connectpeer a pubkey@host:port di getInfo
  waitForChannel(assetId: string, o?: { timeoutMs?: number }): Promise<ChannelReadyInfo>   // UtexoLsp.waitForChannel
  waitForOutboundLiquidity(minMsat: bigint, o?: { timeoutMs?: number }): Promise<void>
  lightningSend?(p: { invoice: string; payWithAssetId?: string }): Promise<LightningSendQuote>          // POST /lightning_send (404 se non abilitato)
  lightningSendStatus?(paymentHash: string): Promise<{ status: LightningSendStatus; reason?: string }>
}
```
- **Esclusi:**
  - **ponti `onchain_send` / `lightning_receive`** [R]: non atomici, nell'intervallo l'LSP tiene i fondi. Roadmap, da sostituire con gli swap (§0bis.6);
  - APay: `apayNew`, canali virtuali [T];
  - **Lightning Address**: in `utexo-lsp` `/pay/callback/{username}` restituisce un invoice HODL preso dal pool di hash APay [V, README + docs APay di `rgb-sdk-rn`], quindi con APay escluso anche la Lightning Address resta fuori. Il documento del team la cita tra le API da coprire: va confermato (§11).
- **`DaveLsp` (oggi, su rln-rest):**
  - `health` e `getInfo` costruiti da `/nodeinfo` di Dave + configurazione (asset USDT, limiti dai parametri di SPEC §15);
  - `waitForChannel` usa i canali aperti da Dave nel seed o da `openLiquidity`;
  - ricezione e invio Lightning: le operazioni RLN già nel codice (`/lninvoice`, `/sendpayment`, `/getpayment`);
  - niente ponti (§0bis.1).
- **`UtexoLsp` (domani):** adattatore su `LspClient` / `UtexoLsp` di `@utexo/wdk-rgb-lightning`.
- **Test di contratto:**
  - fixture = il JSON di `GET https://lsp-signet.utexo.com/get_info` letto il 20/10/2026 (`api_version: 1`, `pubkey 02a621de…`, `network: signet`, `host`, `port: 9735`, `supported_assets` = LNUSDT IFA precisione 6, limiti come stringhe), validato da uno schema zod di `LspInfo` ricavato dai `.d.ts` di beta.5;
  - `DaveLsp.getInfo()` deve passare lo stesso schema;
  - casi negativi: u64 come numero, `schema` sconosciuto, campo in più (da accettare: "Additive only… Clients MUST ignore fields they do not recognize", README).
  - Facoltativo: lo stesso test sull'istanza live, dietro `KITTY_LSP_LIVE=1`.

### 8.2 Un canale o due (domanda aperta: pro e contro, nessuna decisione)
**Perché oggi sono due** [V]:
- `infra/treasury/seed.ts` ("ln-2ch: travel channel + liquidity channel per traveller"): ogni apertura usa `push_msat: 0` e **nessun `push_asset_amount`**;
- il viaggiatore apre il canale di viaggio con i propri D, Dave apre il canale di liquidità con i propri L;
- SPEC §10.4 spiega il motivo: `/openchannel` accetta solo i fondi di chi apre (niente doppio finanziamento), e `push` è un regalo all'altra parte.

**RLN permette di spostare asset all'altro lato all'apertura?** Sì [V]: `OpenChannelRequest.push_asset_amount` (OpenAPI di RLN `d4762ac`). Lo spike 2 l'ha usato (`asset_amount: 8000, push_asset_amount: 5000`). È però un **regalo** di chi apre: per non perdere, Dave dovrebbe prima ricevere D dal membro (modalità `ln-lsp`).

| Opzione | Come | Pro | Contro |
|---|---|---|---|
| **A. Due canali (oggi)** | membro → Dave con D; Dave → membro con L | nessuna fiducia; già verificato end to end; ognuno apre coi propri fondi | 2 aperture on-chain per membro; Dave immobilizza L per membro; non è il modello UTEXO |
| **B. Uno, con push dopo pagamento on-chain** (`ln-lsp`) | il membro paga D on-chain a Dave; Dave apre con D + L e `push_asset_amount = D` | 1 apertura | **custodia** di D tra il pagamento e l'apertura (minuti) |
| **C. Uno, con swap (modello UTEXO)** | Dave apre con L verso il membro (come il cron di `utexo-lsp`, che apre "auto `openchannel`" con l'asset dell'operatore [V]); il membro carica D con uno swap on-chain → Lightning, come `lightning_receive` ("user provides LN invoice → service creates RGB invoice → once RGB transfer settles, service executes `sendpayment`" [V]) | 1 apertura; allineato a UTEXO (cambiare motore e provider cambia poco); Dave recupera D on-chain | il ponte **non è atomico**: tra la conferma on-chain e il `sendpayment` il membro si fida dell'LSP (custodia breve); serve L ≥ D sul lato di Dave all'apertura; esiste uno swap RGB atomico? UTEXO ha un repo `thunder-swap` ("Submarine swaps") [V nome, non letto] |

Dipende anche da come UTEXO apre i canali verso i client (capacità e asset fissi dell'operatore: sul signet pubblico 75.000 sat e 100 LNUSDT [V]). Le domande sono in §10. [R] L'opzione C con il ponte fidato non si implementa; la variante con swap atomici (Kaleidoswap, §0bis.6) è la candidata. In demo resta A.

### 8.3 Rischi dello Stack A [R, M]
| Rischio | Stato | Mitigazione |
|---|---|---|
| **Punizione che brucia gli asset RGB.** Una watchtower standard funziona se riceve la transazione di punizione già firmata con il commitment RGB [M]. Ma nella punizione, oggi, gli asset RGB dell'onesto vengono bruciati invece di tornargli (RGB-Tools/rgb-lightning-node#172 [M]; nel fork UTEXO `rgb-lightning-node#210`, "Penalty sweep does not settle the honest peer's RGB" [V titolo]) | aperto upstream | L'LSP **non può prendere** i fondi, ma una sua frode (stato vecchio pubblicato) oggi farebbe **perdere** gli asset all'onesto. Si dice nel pitch; watchtower RGB in roadmap; domanda 7 a Utexo |
| Pagamenti asincroni RGB | dipende da RGB in BOLT12 (RGB-Tools/rgb-lightning-node#130 [M]), senza date | presenza + notifica + nuovo tentativo (passo 7) |
| Firmatore strict, ripristino VSS, chiusura forzata su WDK | rossi su beta.4 (spike 3) | task S3b su beta.5 prima delle domande a Utexo (§0bis.5) |
| Maturità per mainnet | RLN non pronto per mainnet per diversi mesi [M] | solo regtest; domanda 9 a Utexo |

---

## 9. Proposte di modifica a `docs/SPEC.md` (diff, NON applicati)

> Da approvare dal PM e da registrare in §20. Sono estratti: le sezioni non citate restano come sono. Formato `-` riga tolta, `+` riga aggiunta.

**§1 In una frase**
```diff
-Se qualcuno non paga, l'operatore copre il buco e lo esclude dal gruppo.
+Nessun membro ha poteri speciali: ognuno firma solo per sé e le regole valgono uguali per tutti. Chi non paga può essere bloccato dagli altri ed è escluso quando lo blocca più della metà del gruppo.
-- **certezza del rimborso** fino a un tetto, garantita dall'operatore, che conosce i suoi clienti, invece che dai soldi altrui;
+- **niente garanzia**: il rischio di un debitore che non paga resta al creditore; il blocco e l'esclusione lo rendono visibile a tutti.
```

**§4 I concetti**
```diff
-| **DUSD** | Asset NIA demo, precisione 2 (1 centesimo = 1 unità), al posto di USDT. …
+| **USDT (demo)** | Asset emesso da noi su regtest con nome e ticker USDT e **6 decimali**. Il codice lo identifica **solo tramite l'asset ID** (parametro del viaggio); passare all'USDT reale cambia solo la configurazione. |
-| **Garanzia dell'operatore** [D] | …
-| **Esclusione** [D] | Un membro disonesto viene escluso da Dave: …
+| **Blocco** [D] | Ogni membro può bloccare un altro (`MEMBER_BLOCKED`) e sbloccarlo (`MEMBER_UNBLOCKED`). Il bloccato non entra nelle nuove spese di chi lo blocca e non gli addebita niente. |
+| **Esclusione** [D] | Calcolata da ogni telefono: un membro è escluso quando lo bloccano più della metà degli altri membri attivi; decade se i blocchi scendono sotto la soglia. Non è un evento. |
+| **Hub / LSP** | Il nodo che instrada i pagamenti e fornisce liquidità. Obiettivo: LSP UTEXO. Demo: il nodo di Dave su rln-rest. Non è membro del viaggio e non ha poteri sul registro. |
-| **Registro firmato** | Elenco append-only di eventi firmati dai rispettivi autori, ospitato da un **relay** (il "postino") che non può falsificare nulla (§9). |
+| **Registro firmato** | Grafo di eventi Nostr firmati dai rispettivi autori; ogni evento cita i precedenti che il suo autore conosceva. 2-3 relay Nostr conservano e inoltrano; ogni telefono ne tiene una copia completa e li ordina con una regola fissa (§9). |
```

**§5 Ruoli e poteri**
```diff
-| **Dave (coordinatore/operatore)** | Instradare i pagamenti; pubblicare il tasso del giorno; risolvere le contestazioni …; coprire le insolvenze con la garanzia; escludere un membro. | …
+| **Hub (Dave in demo, LSP UTEXO come obiettivo)** | Instradare i pagamenti; aprire canali di liquidità. | Muovere i fondi dei membri; scrivere o firmare eventi del registro. |
-| **Relay (postino)** | Ricevere, validare, ordinare e consegnare eventi; conservare backup cifrati. | …
+| **Relay Nostr (2-3)** | Conservare e inoltrare eventi. | Creare, modificare, ordinare o validare eventi. Può solo non consegnare, e lo si rileva con i `CHECKPOINT` e con gli altri relay. |
+| **Ogni membro** | Invitare; bloccare e sbloccare; uscire senza debiti. | Approvare righe altrui; escludere da solo un membro. |
```

**§6 Ciclo di vita** (sintesi delle sottosezioni)
```diff
-### 6.1 Onboarding … 3. Dave pubblica `TRIP_CREATED` … e `MEMBER_ADMITTED` per ogni membro.
+### 6.1 Ingresso: chi crea il viaggio pubblica `TRIP_CREATED` (parametri immutabili). Ogni membro può invitare (`MEMBER_INVITED`); l'invitato pubblica `MEMBER_JOINED` con la chiave del registro del viaggio e la fattura di prova del suo nodo.
-### 6.2 … 3. Dopo le conferme, Dave pubblica `CHANNELS_READY` …
+### 6.2 Canali con l'hub: i canali sono un fatto tra membro e hub, non eventi del registro.
+### 6.3bis Al tavolo: i debitori presenti firmano la proposta (righe, importi, cambio) via QR o Bluetooth; le firme entrano in `EXPENSE_SUBMITTED` e le loro quote sono subito "da pagare".
-### 6.6 Contestazione … 3. Dave decide con `DISPUTE_RESOLVED` …
+### 6.6 Contestazione: la riga contestata resta bloccata e nessuno la paga in automatico. Resolver: da decidere.
-### 6.7 Insolvenza, copertura, esclusione …
+### 6.7 Blocco ed esclusione: vedi §4. I debiti verso chi è bloccato o escluso restano, ma si pagano solo a mano; chi è bloccato o escluso può sempre saldare i propri.
-### 6.8 Fine viaggio … Dave pubblica `TRIP_CLOSED`.
+### 6.8 Uscita e fine: `MEMBER_LEFT` solo senza debiti (si può uscire con crediti). Il viaggio finisce quando sono usciti tutti (calcolato).
+### 6.10 Pagamento che riparte: se il destinatario è offline, il pagamento resta in coda; presenza su Nostr e notifica push; riparte quando entrambi hanno l'app aperta.
```

**§7 Stati di una riga**
```diff
-| `overdue` | … | `guaranteed` (copertura), `paid` (paga tardi) |
-| `guaranteed` | `GUARANTEE_PAID` valido | stato finale (credito dell'operatore) |
+| `manual_only` | `due` ma il creditore è bloccato dal debitore o escluso (derivato, reversibile) | `due`, `paid` |
-| `contested` | `LINE_DECIDED{contest}` | `due` (confermata da Dave, nuova scadenza), `voided` |
+| `contested` | `LINE_DECIDED{contest}` (vince su un `approve` concorrente) | `due` (il debitore approva dopo), `paid` (a mano), `voided` |
-| `due` | approvata, assentita o confermata | `paid`, `overdue` |
+| `due` | firmata al tavolo, approvata o assentita | `paid`, `manual_only` |
```

**§8 Policy**
```diff
+L'agente **non paga in automatico**: righe verso un creditore che il debitore blocca o che è escluso; righe contestate. Le quote firmate al tavolo contano come approvazione esplicita (si pagano anche sopra `autoPayLimit`, entro `dailyCap`).
```

**§9 Registro**: diff completo in [`docs/proposte/spec-9-registro.md`](proposte/spec-9-registro.md) (passo 1).

**§10 Pagamenti**
```diff
-- Instradamento: canale di viaggio del debitore → Dave → canale di liquidità del creditore.
+- Instradamento: canale del debitore → hub → canale del creditore. Hub = `LspProvider` (Dave su rln-rest in demo).
+- Se il creditore è offline il pagamento resta in coda e riparte quando entrambi hanno l'app aperta (presenza Nostr + push). Il pagamento in attesa sull'LSP (APay) è in roadmap.
-### 10.5 Quanta liquidità deve mettere Dave [D] …
+### 10.5 Liquidità dell'hub: logica dell'hub, non del ledger del viaggio (l'hub non legge il registro).
```

**§12 Backup**
```diff
+La chiave del registro si ricava dalla seed (NIP-06). Il segreto del viaggio è salvato nel registro, cifrato verso la chiave del membro: chi recupera la seed recupera gli eventi e il segreto.
```

**§13 Attacchi**: tolte le righe 7, 8, 10, 11, 17 nella forma "Dave"; aggiunte:
- **21** Sybil sugli inviti per pilotare l'esclusione;
- **22** contestazione senza arbitro come rifiuto di pagare;
- **23** relay che censura in modo selettivo (difesa: 2-3 relay, `CHECKPOINT`, ripubblicazione);
- **24** `created_at` falsi (non entrano nell'ordine);
- **25** spareggio sull'id "minato" (nessuna regola che cambia i saldi dipende dall'ordine tra concorrenti);
- **26** metadati visibili ai relay (contenuto cifrato, chiave per viaggio);
- **27** gateway push (non vede contenuti, limite di frequenza).

**§15 Parametri**
```diff
-| D, canale di viaggio | 50.00 DUSD (5000 unità) |
+| D, canale di viaggio | 50.00 USDT (50.000.000 unità, 6 decimali) |
-| `INVOICE_EXPIRY_SECONDS` | 3600 | 48 ore |
+| `INVOICE_EXPIRY_SECONDS` | 172800 (minimo 86400) | 48 ore |
-| G, garanzia per membro | 50.00 |
-| Tasso | 26,350 VND per 1 USD (`infra/rates.json` …) |
+| Cambio | ultimo cambio salvato dall'oracolo, con data; avviso se ha più di 24 ore |
```

**§16 Demo**, **§17 Reale/simulato**: da riscrivere dopo il passo 2 (niente "Copri ed escludi"; nuova storia: tavolo offline, relay spento, pagamento che riparte).

**§20 Registro decisioni**, nuova riga proposta:
```diff
+| 21/10 | **Stack A come obiettivo, demo su rln-rest.** APay e canali virtuali no; LSP UTEXO come obiettivo (Dave come hub in demo); asset identificato solo per asset ID (DUSD in demo, USDT a 6 decimali dopo la finale); push con servizio compatibile LSPS5; `LspProvider` senza ponti non atomici; Kaleidoswap in roadmap dopo la finale. Registro su Nostr (kind 7345, Schnorr, contenuto cifrato NIP-44, fattura fuori dalla firma del debitore) senza poteri speciali: invito, blocco, esclusione calcolata, uscita, quote firmate al tavolo; niente garanzia. Chiave del registro NIP-06 per viaggio. **Supera** le righe su garanzia, esclusione di Dave, `ln-2ch` come scelta definitiva (diventa domanda aperta) e firma ed25519. | `docs/stack-a-decisioni.md`; revisione del 21/10 (§0bis); `docs/piano-migrazione-stack-a.md`; `docs/ADR-001-formato-eventi.md` |
```

---

## 10. Domande per UTEXO [T]

1. **Firmatore in modalità strict.** I canali non si aprono e i pagamenti in uscita si bloccano. Qual è il motivo, e la policy controllerà anche gli importi in USDT (asset RGB), oltre ai sat?
   - Fonti [V]:
     - `tests/regtest/QUALIFICATION.md` di `wdk-rgb-lightning` al tag `v0.2.0-beta.5`, "Unresolved Runtime Blockers" n. 1 (righe 58-63: "signer-pending commitment updates and monitor-update-in-progress… not a complete root-cause proof") e tabella (righe 39-40, 48-49);
     - README di `rgb-lightning-node-bare` beta.5 ("Strict outgoing signing and same-process reopen remain blockers");
     - `RELEASE-0.15-TRACKER.md:367` nel tarball npm 0.2.0-beta.5;
     - spike 3 B (`spikes/wdk-lsp/calls.log:15-18, 41-42, 211`).
   - Sugli importi RGB le docs dicono solo "a VLS core patched for RGB channels" (`docs.utexo.com/security/rln-remote-signer.md`, riga 24).
2. **Ripristino del backup.** Al primo pagamento dopo il ripristino il canale si chiude. Qual è la correzione, e il backup contiene già tutti i dati RGB?
   - Fonti [V]:
     - CHANGELOG 0.2.0-beta.5, "Known limitations", riga 116: "VSS does not replicate the mnemonic, separate VLS signer database or application journals";
     - README di `rgb-lightning-node-bare`: "seed-only or VSS-only recovery is not complete open-channel recovery";
     - spike 3 D (`calls.log:177, 197-209`: `Failed to validate our commitment`).
   - Il README di `wdk-rgb-lightning` dice che VSS "mirror[s] LDK channel state and RGB wallet data": da confermare se include le consignment.
3. **Chiusura forzata.** La transazione viene rifiutata e i soldi restano nel canale. Qual è la correzione, e come si recuperano i fondi nel frattempo?
   - Fonte precisa [V]: `tests/regtest/QUALIFICATION.md` di `UTEXO-Protocol/wdk-rgb-lightning` al tag `v0.2.0-beta.5`, **righe 80-88**, blocker 4 "RGB force-close commitment rejection": Core risponde `-26 mempool-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)`, "No upstream fix is included". Tabella alle righe 147-148 (anche con firmatore strict).
   - Conferme nel tarball npm 0.2.0-beta.5: `RELEASE-0.15-TRACKER.md:368` e `:456`, `UPGRADE-TRACKER.md:68`, `PRODUCTION-GATES.md:713` (S01).
   - Nostra riproduzione: spike 3 C (`spikes/wdk-lsp/calls.log:73-86`, 8.000 DUSD bloccati dopo 161 blocchi).
   - **Nessuna issue GitHub dedicata** (ricerca nell'org `UTEXO-Protocol`). Collegate: `rgb-lightning-node#210` (aperta, "Penalty sweep does not settle the honest peer's RGB") e `#207` (chiusa, chiusura cooperativa con output trimmed).
4. **LSP per l'ultima versione.** Il nodo RLN `v0.17.0-beta.3` richiede i repository privati `rgb-consensus-s-bfa`, `rgb-ops-s-bfa`, `rgb-schemas-s-bfa` (spike 3, e README di `rgb-lightning-node-bare`: "Source builds need access to three private upstream BFA repositories"). L'immagine GHCR di `utexo-lsp` risponde `unauthorized`. Possiamo avere accesso, oppure un'immagine pubblica? E una licenza per `utexo-lsp`?
5. **Date e termini.** USDT su Lightning e su signet (con quale schema: NIA, IFA o BFA, §7); pagamento in attesa sull'LSP (APay con RGB, qualificato); termini di accesso all'LSP per un'integrazione commerciale (token, limiti, SLA, asset ammessi, canali su misura).

Aggiunte della revisione [R] (da mandare **dopo** lo spike S3b su beta.5, che potrebbe chiudere o cambiare le domande 1-3):

6. **Strict e VLS.** La modalità strict fallisce per gli stessi controlli che la guida VLS di RGB-OS nella issue RGB-Tools/rgb-lightning-node#43 imposta solo come avviso (`policy-chain-validated`, `policy-unapproved-destination`)? È perché VLS non riconosce gli output colorati RGB?
7. **Punizione.** Il WDK ha lo stesso comportamento della PR RGB-Tools/rgb-lightning-node#172 (asset bruciati nella punizione)? È prevista una watchtower compatibile con RGB?
8. **LSPS5 e destinatario offline.** L'LSP supporta, o supporterà, LSPS5 e la sospensione dei pagamenti verso un destinatario offline?
9. **Mainnet.** Ci è stato detto che RLN non sarà pronto per mainnet ancora per diversi mesi. Vale anche per il WDK?

---

## 11. Punti da chiudere nel documento del team (proposte, non decisioni)

[R] D1 e D2 sono chiusi. **D3, D5, D6, D10 e D11 restano aperti**: nel passo 2 le regole si implementano come sono scritte nel documento del team, con TODO e test segnaposto dove sono ambigue (§0bis.4). D12 è superato da §0bis.2 (servizio compatibile LSPS5).

| # | Punto | Problema | Proposta |
|---|---|---|---|
| D1 | Contenuto in chiaro sui relay | Senza cifratura, una chiave per viaggio non impedisce di collegare i viaggi (`nodePubkey`, `bolt11`) e i relay leggono importi e nomi | **Chiuso [R]: sì**, NIP-44 con la chiave del viaggio; segreto nel registro cifrato verso ogni membro (§0bis.3) |
| D2 | Fattura dentro la proposta firmata | Senza rete nessuno crea fatture; la riemissione invaliderebbe la firma | **Chiuso [R]: sì**, fattura fuori dalla firma del debitore, con la regola di validazione prima di pagare (§0bis.3) |
| D3 | **Sybil sugli inviti** | Basta un invito per entrare e la soglia di esclusione è a maggioranza: chi invita 3 "amici" può escludere chiunque, o impedire un'esclusione | Varianti: contano solo i blocchi di membri entrati **prima** della prima spesa che coinvolge il bloccato; tetto di inviti per membro; ingresso con approvazione di chi c'è già |
| D4 | Quote firmate al tavolo e limiti | "Subito da pagare" con o senza `autoPayLimit` e tetto giornaliero? | Approvazione esplicita: niente `autoPayLimit`, sì tetto giornaliero |
| D5 | **Contestazioni senza arbitro** | "Vince contesto" + nessun arbitro = rifiutarsi di pagare senza costo | Finché non si decide: la contestazione è visibile, il pagatore può annullare e riemettere, gli altri possono bloccare; dopo N contestazioni rifiutate, avviso nel gruppo |
| D6 | Blocco: "il bloccato non entra nelle spese di chi lo blocca" e "debiti verso chi è bloccato solo a mano" | Non è chiaro se "bloccato" sia per coppia o per tutti | Per coppia (vale per chi blocca); per tutti solo se escluso |
| D7 | Liquidità dell'hub | `liquidityPlan` oggi legge il registro; l'hub non è più nel viaggio | Il membro chiede inbound all'hub con `LspProvider` (o l'hub dimensiona a richiesta); niente accesso dell'hub al registro |
| D8 | Lightning Address nell'interfaccia LSP | In `utexo-lsp` la Lightning Address si basa sul pool di hash APay | Fuori finché APay è fuori |
| D9 | Uscita con righe contestate | "Senza debiti": una riga contestata conta? | Sì, conta come debito aperto |
| D10 | Esclusione e fazioni | Blocchi reciproci tra due metà portano a esclusioni reciproche | Accettare (deterministico) e mostrarlo; oppure contare solo i blocchi di non esclusi con punto fisso (più complesso, non sempre convergente) |
| D11 | Cambio nel weekend | Il feed VND di Pyth è chiuso nel weekend: l'avviso a 24 h scatta sempre il lunedì | Età misurata in ore di mercato, o soglia di 72 h |
| D12 | Notifiche: chi gestisce il gateway | Il documento del team dice "servizio di notifiche", ma serve un operatore con account Apple/Google | L'operatore (o noi in demo), con il modello "a sveglia diretta" (§5.4) |
| D13 | Uscito con crediti | Deve riaprire l'app per incassare | Va detto in UI all'uscita |

---

## 12. Task del passo 1 (formato degli eventi), approvato [R]

Stream A, salvo dove indicato. Branch `a/S1-nostr-envelope`, solo `packages/shared` e `packages/ledger`; `crypto.ts` in una PR separata (stream B). Nessuna modifica al motore né al trasporto. Le regole del ledger (passo 2) restano quelle di oggi finché il formato non è mergiato. D1 e D2 approvati: la cifratura (5) si fa, la fattura sta fuori dalla parte firmata dal debitore (4). La PR entra solo se `pnpm e2e:demo` passa (§0bis.0).

1. **ADR del formato** in `docs/` (breve): kind 7345 e 27345, tag `T` ed `e`, `content` JCS e cifratura (D1), `proposal` e `tableSignatures` (D2), id, ordine, regole C1-C15. Decide il PM su D1 e D2.
2. **Serializzazione NIP-01** in `packages/shared/src/nostr.ts`: `serializeForId`, `eventId`, verifica degli `id`, con i vettori di test di NIP-01 e quelli di `nostr-tools` come oracolo nei test (dipendenza solo di test).
3. **Firme Schnorr** in `packages/shared/src/crypto.ts` (**stream B**, B4): `SignatureVerifier` su `schnorr.verify` di `@noble/curves/secp256k1`; firma (helper di test); casi: valida, alterata, altra chiave, id non corrispondente.
4. **Schemi zod dei nuovi eventi** in `packages/shared/src/events.ts`: corpi di §2.2 (compresi `MEMBER_INVITED`, `MEMBER_BLOCKED`, `MEMBER_UNBLOCKED`, `MEMBER_LEFT` e il nuovo `CHECKPOINT`), `amount` come stringa di unità base, `TripParams` con `assetId`, `assetDecimals`, `displayDecimals`, `invoiceExpirySeconds ≥ 86400`. I vecchi schemi restano in un file `legacy-events.ts` finché il passo 2 non li toglie.
5. **Cifratura del contenuto** (se D1 approvata) in `packages/shared/src/content.ts`: NIP-44 v2 con chiave di conversazione `HKDF(tripSecret)`; vettori di NIP-44.
6. **Ordine fisso** in `packages/ledger/src/order.ts` (funzione pura): chiusura causale (eventi in arrivo e mancanti), Kahn con spareggio sull'id, `stateHash`; antenati (`isAncestor`, `ancestorsOf`) con memoizzazione.
7. **Regole di conflitto come funzioni pure** in `packages/ledger/src/conflicts.ts`: C1-C15, ognuna con il suo test. Le regole che dipendono dagli stati del passo 2 (C8, C9, C14) restano come test `todo` collegati al passo 2.
8. **Test di proprietà** (fast-check) in `packages/ledger/src/order.test.ts`:
   - DAG casuali con rami concorrenti, consegnati in ordini casuali → stessa sequenza e stesso `stateHash`;
   - `created_at` casuali o falsi → nessun effetto sull'ordine;
   - un evento con un genitore mancante non viene mai applicato.
9. **Diff di SPEC §9** (già in §9 di questo piano) da far approvare al PM, poi aggiornamento di `docs/status/a.md`.

**Fatto quando:** i task 2-8 hanno test verdi (`pnpm typecheck && pnpm lint && pnpm test`); il test di determinismo (8) passa su almeno 1.000 DAG; nessun file fuori da `packages/shared` e `packages/ledger` è toccato (`crypto.ts` nella PR di stream B).

---

## 13. Correzioni al diagramma

1. **Manca il proxy RGB.** Lo sblocco del nodo richiede `proxy_endpoint`; ogni trasferimento on-chain (on-ramp, sweep, ponti `onchain_send`/`lightning_receive`) passa da lì. Va aggiunto ai "Servizi Utexo" (oggi c'è solo "indexer e backup VSS"), ospitabile da UTEXO (`rgb-proxy.utexo.com`) o da noi. [V]
2. **"Canale USDT":** corretto come obiettivo, ma in demo è un nostro asset chiamato USDT, a 6 decimali, identificato per asset ID. L'LSP pubblico oggi ha LNUSDT (IFA), e l'USDT reale potrebbe avere uno schema diverso da NIA (§7). [T, V]
3. **Niente APay.** L'LSP non trattiene pagamenti: il pagamento riparte quando entrambi hanno l'app aperta. [T]
4. **Mancano presenza e push.** Va aggiunto un **gateway di sveglia** (push) tra i servizi online, collegato solo ai telefoni, e la presenza effimera tra i messaggi Nostr. [T, I design]
5. **"Chiave del registro" = una per viaggio,** derivata dalla seed (NIP-06), indipendente dalla chiave del nodo. Per non collegare i viaggi il contenuto dev'essere cifrato. [T, I]
6. **Manca l'oracolo dei cambi** tra i servizi online (letto quando c'è rete, poi salvato). [T]
7. **"Fuori solo relay e LSP"** non è esatto: fuori ci sono anche indexer, proxy RGB, VSS, oracolo e gateway push. Nessuno di questi custodisce soldi o firma eventi. [V, I]
8. **In demo** l'LSP UTEXO è sostituito dal nodo di Dave su rln-rest; lo Stack A con nodo WDK sul telefono è l'obiettivo. [T]
9. **L'LSP non può prendere i fondi, ma una sua frode oggi farebbe perdere gli asset RGB:** nella punizione gli asset dell'onesto vengono bruciati (§8.3). Va scritto accanto all'LSP. [R, M]
10. **Push:** il servizio di notifiche (LSPS5) sta tra i servizi online, collegato ai telefoni e, in futuro, all'LSP; non vede contenuti. [R]

---

## 14. Matrici di fattibilità (aggiornate)

Legenda: ✅ fattibile con open source / self-hosted · ⚠️ con rischi · 🔒 dipende da UTEXO · ❌ non fattibile oggi.

### 14.1 Box
| Box | Classe | Motivo |
|---|---|---|
| App + AI locale | ⚠️ | Web in demo; mobile con il passo 8; QVAC `~0.21.0` [T] |
| Ledger | ✅ | TS puro; regole nuove (§3) |
| Chiave del registro | ✅ | NIP-06 in JS, offline (§4) |
| Nodo WDK | ❌ oggi → ⚠️ | Quattro problemi UTEXO (§10); in demo rln-rest |
| Relay Nostr (2-3) | ✅ | `nostr-rs-relay` (MIT) o strfry (GPL-3.0); nostri in demo [T] |
| LSP Utexo | 🔒 | Demo: Dave su rln-rest dietro `LspProvider` (§8) |
| Servizi Utexo (indexer, VSS) + proxy RGB | 🔒 / ✅ | Nostri in demo (electrs, esplora, `rgb-proxy-server`) |
| Oracolo dei cambi | ⚠️ | Pyth firmato con API key; riserva non firmata (§6) |
| Gateway push | ✅ / ⚠️ | Expo Push gratuito; iOS richiede account Apple (§5.4) |

### 14.2 Connessioni
| Connessione | Classe | Motivo |
|---|---|---|
| QR / Bluetooth | QR ✅ / BLE ⚠️ | `react-native-ble-plx` non collega due telefoni; `expo-nearby-connections` non collega Android e iOS [V]; QR multi-frame |
| Eventi firmati ↔ relay | ✅ | Passi 1 e 4 |
| Canale USDT ↔ LSP | ✅ demo (rln-rest) / 🔒 obiettivo | Un canale o due: aperto (§8.2) |
| Nodo ↔ servizi | ✅ demo / 🔒 obiettivo | Proxy da aggiungere al diagramma |
| Telefono ↔ gateway push | ✅ | Nuovo |

### 14.3 Flusso (scenario A + B) sul nuovo modello
| Step | Classe | Note |
|---|---|---|
| 1-2 Foto, proposta, quote | ✅ | QVAC + ledger; la fattura si crea se il pagatore è online, altrimenti dopo (D2) |
| 3-5 Proposta e firma al tavolo | ✅ QR / ⚠️ BLE | Passo 6 |
| 6-7 Pubblicazione su 2-3 relay e verifica | ✅ | Passi 1 e 4 |
| 8-9 Ricezione e `decideAutoPay` | ✅ | Passo 2 |
| 10-14 Pagamento con Alice offline | ✅ con "riparte" / ❌ APay | Niente pagamento in attesa sull'LSP [T]; presenza + push + nuovo tentativo (passo 7) |
| 15 `PAYMENT_MADE` | ✅ | Preimage e `payee_pubkey` come oggi |

---

## Appendice A: Rimandato (con la condizione che lo riapre)

| Tema | Cosa era nel piano | Si riapre quando |
|---|---|---|
| **APay** (pagamento in attesa sull'LSP) | Pool di hash attestati, invoice HODL dell'LSP, consegna quando il destinatario torna; supportato con asset nel codice di `utexo-lsp`/RLN ma non qualificato (`RELEASE-0.15-TRACKER.md:375` di beta.5); CLTV in ingresso di 144 blocchi di default; invoice intestato all'LSP con `ApayInvoiceProof` | UTEXO lo rende possibile e qualificato con RGB/USDT **su canali standard** (domanda 5) |
| **Canali virtuali** (`trusted_no_broadcast`) | Richiesti dal README di WDK per APay "against a production LSP"; il saldo dipende dall'LSP | Mai senza una via di recupero unilaterale del saldo; `enableVirtualChannelsV0` resta `false` [T] |
| **Lightning Address** | Basata sul pool APay in `utexo-lsp` | Insieme ad APay |
| **Garanzia dell'operatore** (`GUARANTEE_PAID`, copertura fino a G, "Copri ed escludi") | SPEC §4, §6.7 | Se il team reintroduce un ruolo di garante, con un evento firmato e regole uguali per tutti |
| **Poteri di Dave** (`MEMBER_ADMITTED`, `DISPUTE_RESOLVED`, `MEMBER_EXCLUDED`, `RATE_SET`, `TRIP_CLOSED`) | SPEC §5, §9.2 | Non si riapre: sostituiti da invito, blocco, esclusione calcolata, oracolo e uscita [T] |
| **Bluetooth subito** | `munim-bluetooth` (peripheral + Multipeer, giovane) | Dopo il QR (passo 6) [T] |
| **MCP server in-app** | QVAC accetta `tools`/`mcp`; il trasporto stdio non esiste su mobile | Se serve esporre gli stessi tool a un agente esterno |

## Appendice B: ricerca di riferimento (21/10/2026)
- Nostr:
  - NIP-01 (kind regolari 1000-9999, effimeri 20000-29999, tag a una lettera indicizzati, `id` e firma), NIP-06 (`m/44'/1237'/<account>'/0/0`, "unrecommended"), NIP-40 (scadenza), NIP-44, NIP-49, NIP-70 (eventi protetti: non usarli): https://github.com/nostr-protocol/nips;
  - kind 7345/27345 non presenti nella tabella del README dei NIP letta oggi;
  - `nostr-tools` 2.25.2 (Unlicense), `nostr-rs-relay` (MIT), strfry (GPL-3.0), khatru (archiviato).
- RLN `d4762ac`: `src/routes.rs` righe 892, 3016, 3043 (scadenza invoice); OpenAPI `docs/vendor/rln-openapi.yaml` (`OpenChannelRequest.push_asset_amount`, `LNInvoiceRequest.expiry_sec`). LDK `lightning/src/ln/inbound_payment.rs` (`calculate_absolute_expiry`, limite 48 bit).
- WDK beta.5 (tarball npm): `src/wallet-manager-rgb-lightning.js` (`wdkSeedToNodeSeedHex`: primi 32 byte), `index.d.ts` (`LspInfo`, `LspClient`, `UtexoLsp`, `ChannelReadyInfo`), CHANGELOG, `PRODUCTION-GATES.md`, `RELEASE-0.15-TRACKER.md`, `UPGRADE-TRACKER.md`; `tests/regtest/QUALIFICATION.md` al tag `v0.2.0-beta.5`.
- `utexo-lsp` README (solo lettura delle API pubbliche: `/health`, `/get_info` con il suo contratto, `/onchain_send`, `/lightning_receive`, `/lightning_send`, LNURL).
- Pyth: catalogo Hermes (`FX.USD/VND` con orari, `FX.EUR/USD`), upgrade Core del 26/08/2026 con API key, firma 3 su 5 ECDSA secp256k1. ExchangeRate-API open access (`open.er-api.com`), fawazahmed0 currency-api, Frankfurter (niente VND).
- Expo Push: FAQ (gratuito, 600 al secondo, contenuto non conservato, FCM/APNs diretti possibili). Holepunch, sospensione dei worklet. Nopu (push su Nostr, da ricerca web).
- GitHub UTEXO: nessuna issue sul blocker 4; `rgb-lightning-node#210` (aperta), `#207` (chiusa).
