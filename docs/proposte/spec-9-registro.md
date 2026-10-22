# Proposta di modifica a SPEC §9 (registro firmato): formato v2 su Nostr

> **Proposta, NON applicata.** Va approvata dal PM e registrata in SPEC §20 (riga proposta in `docs/piano-migrazione-stack-a.md` §9, "§20 Registro decisioni").
> Allineata al codice del passo 1 (PR #59, mergiata; firme Schnorr nella PR #60, in revisione dallo stream B) e a `docs/ADR-001-formato-eventi.md`. Fonte delle decisioni: `docs/stack-a-decisioni.md` e la revisione del 21/10 (`docs/piano-migrazione-stack-a.md` §0bis).
> Formato: `-` riga tolta, `+` riga aggiunta; le parti di §9 non citate restano come sono.

§9.1 Busta e firma:
```diff
-L'autore firma il contenuto; il relay lo incapsula e lo concatena.
-SignedEvent (scritto dall'autore)
-  inner = { v: 1, tripId, type, author: <nodePubkey>, nonce: <16 byte hex>, createdAt: <ISO>, body: {...} }
-  sig   = firma di canonical(inner)
-StoredEvent (scritto dal relay)
-  { seq, prevHash, signed: SignedEvent, receivedAt, hash = sha256(canonical({ seq, prevHash, signed })) }
+L'autore firma l'evento Nostr; i relay lo conservano e lo inoltrano senza ordinarlo né modificarlo.
+Evento NIP-01, kind 7345 (effimeri: 27345, mai applicati)
+  { id = sha256([0, pubkey, created_at, kind, tags, content]), pubkey = chiave del registro del membro per il viaggio (x-only),
+    created_at (solo informativo), kind: 7345,
+    tags: [["T", tripTag], ["e", <genitore>]…]   (genitori ordinati, unici, max 32; nessun altro tag; mai ["-"])
+    content = NIP-44 v2 di JCS({ v: 2, tripId, type, body }) con chiave HKDF-SHA256(tripSecret, "kitty:content:v1"),
+    sig = Schnorr BIP-340 dell'id }
+tripTag = hex(sha256("kitty:trip:v1" ‖ tripSecret)); tripSecret = 32 byte casuali, passati con l'invito.
+Genitori = le teste note all'autore, sempre compreso il suo evento precedente; solo TRIP_CREATED non ne ha.
+Eccezione: TRIP_SECRET_SHARED viaggia in chiaro (JCS senza tripId): il segreto è cifrato NIP-44 (ECDH) verso ogni destinatario.
+Limite: chi esce o viene escluso conserva il segreto e legge gli eventi successivi (rotazione in roadmap).
-- **canonical** = JSON canonico RFC 8785 (JCS); importi bigint serializzati come stringhe decimali.
+- **canonical** = JSON canonico RFC 8785 (JCS); importi bigint come stringhe decimali di **unità base dell'asset** (`amount`); un contenuto che non sia esattamente JCS, o con campi sconosciuti, si rifiuta.
-- **Chi firma (motore scelto al gate 2: `rln-rest`, §14.0 e §20):** … ed25519 dell'app (`appPubkey`) … `kitty-bind:<sha256(appPubkey)>` …
+- **Chi firma:** la chiave del registro del viaggio, NIP-06 `m/44'/1237'/<i>'/0/0` dalla stessa seed, un indice per viaggio, offline. Legame col nodo: in `MEMBER_JOINED` una fattura del nodo del membro con `description = kitty-bind:v2:<tripTag>:<pubkey>`; il suo `payee_pubkey` è il `nodePubkey` del membro. `/signmessage` di RLN resta vietato.
-- `nonce` + `tripId` + riferimenti espliciti (hash dell'evento della spesa, importi) rendono ogni firma inutilizzabile in un altro contesto (anti-replay).
+- `id` (unico), `tripId` nel contenuto, tag `T` e riferimenti espliciti (`expenseRef` = id della spesa, importi) rendono ogni firma inutilizzabile in un altro contesto (anti-replay). Il `nonce` sparisce.
+- **Ordine fisso:** si applicano solo gli eventi con tutti i genitori applicati (chiusura causale); genesi = l'evento senza genitori con id minore, gli altri senza genitori e i loro discendenti sono ignorati. Sequenza = Kahn sui genitori con spareggio sull'id minore; `created_at` non conta. `stateHash = sha256(id₁ ‖ … ‖ idₙ)`.
+- **Conflitti:** dipendono solo da "X precede Y" (X antenato di Y) e dal tipo; l'ordine tra concorrenti decide solo i casi senza vantaggio. Regole C1-C15 in `docs/ADR-001-formato-eventi.md` §5.
```

§9.2 Tipi di evento:
```diff
-| `TRIP_CREATED` | Dave | `name`, `assetId`, `params` (§15), `coordinatorPubkey` |
-| `RATE_SET` | Dave | …
-| `MEMBER_JOINED` | membro | `displayName`, `memberId`, `appPubkey`, `nodePubkey`, `bindInvoice`, `policy` |
-| `MEMBER_ADMITTED` | Dave | …
-| `CHANNELS_READY` | Dave | …
-| `EXPENSE_SUBMITTED` | pagatore | `expenseId`, `receipt`, … `rateEventHash`, `rate`, `totalUsdCents`, `payerCents`, `payerItemIndexes`, `lines: [{ debtorPubkey, cents, itemIndexes, bolt11 }]`, `fingerprint` |
-| `DISPUTE_RESOLVED` | Dave | …
-| `GUARANTEE_PAID` | Dave | …
-| `MEMBER_EXCLUDED` | Dave | …
-| `CHECKPOINT` | chiunque | `seq`, `headHash` |
-| `TRIP_CLOSED` | Dave | …
+| `TRIP_CREATED` | chi crea | `name`, `params` (immutabili: `assetId`, `assetDecimals`, `displayDecimals`, `silentAssentSeconds`, `invoiceExpirySeconds` ≥ 86400, default 172800, `rateMaxAgeSeconds`, `oracles`), `relays` |
+| `MEMBER_INVITED` | membro | `inviteId`, `inviteePubkey?`, `expiresAt` |
+| `MEMBER_JOINED` | chi entra | `inviteRef` (null solo per chi ha creato il viaggio), `displayName`, `nodePubkey`, `bindInvoice`, `policy` |
+| `TRIP_SECRET_SHARED` | membro | `recipients: [{ pubkey, ciphertext }]` |
+| `EXPENSE_SUBMITTED` | pagatore | `proposal` (`tripId`, `expenseId`, `payer`, `receipt`, `rate { pair, value, asOf, source, proof? }`, `assetId`, `assetDecimals`, `total`, `payerAmount`, `payerItemIndexes`, `lines: [{ debtor, amount, itemIndexes }]`; **nessuna fattura**), `tableSignatures: [{ signer, sig }]` (Schnorr su `sha256("kitty:share:v1" ‖ JCS(proposal))`), `invoices: [{ debtor, bolt11 }]`, `receiptImageSha256`, `fingerprint` |
+| `MEMBER_BLOCKED` / `MEMBER_UNBLOCKED` | membro | `target` |
+| `MEMBER_LEFT` | membro | — |
+| `CHECKPOINT` | membro | `frontier`, `count`, `stateHash` |
```
Negli altri tipi `expenseEventHash` → `expenseRef`, `cents` → `amount`, `debtorPubkey`/`creditorPubkey` → `debtor`/`creditor`; `POLICY_UPDATED.policy` = `{ autoPayLimit, dailyCap }` (sparisce `payUpheldDisputes`, non c'è più chi conferma una contestazione).

§9.3 Validazione:
```diff
-- firma valida per `author`; autore ammesso al viaggio (tranne `TRIP_CREATED` e `MEMBER_JOINED`); i tipi "Dave" solo da Dave;
-- `nonce` mai visto in quel viaggio;
+- `id` e firma Schnorr validi; kind 7345; tag `T` del viaggio; contenuto decifrabile, canonico e senza campi sconosciuti; tutti i genitori applicati;
+- autore membro attivo nello stato calcolato sui **soli antenati** dell'evento (tranne `TRIP_CREATED` e `MEMBER_JOINED`); nessun tipo riservato;
+- `EXPENSE_SUBMITTED`: ogni firma del tavolo valida, di un debitore della riga, sulla `proposal` identica;
+- **prima di pagare** (D2): la fattura paga il nodo legato al creditore con `kitty-bind`, importo e asset corrispondono alla quota firmata; altrimenti la riga non si paga, né in automatico né a mano;
```
Restano le regole di §9.3 sui totali, sui debitori attivi, sul `fingerprint` (con C10) e sulla preimage; le regole di invito, blocco e uscita arrivano con il passo 2 (§3.2-3.4 di questo piano).

§9.4: `CHECKPOINT { frontier, count, stateHash }` al posto di `{ seq, headHash }`; "riordino" non è più possibile (l'ordine non dipende dal relay); l'omissione si rileva con i genitori mancanti e con gli altri relay. §9.5: "catena valida" diventa "insieme chiuso, nessun evento in attesa", "uguale su N/N" confronta lo `stateHash`.
