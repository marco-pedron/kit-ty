# Prompt 00: spike Lightning RGB (Dev B, venerdì 10:45-13:30)

> Da incollare come primo messaggio in una sessione Claude Code **nel vecchio repository**, dove lo stack regtest funziona già. Prima copia lì `docs/SPEC.md` del nuovo repo come `spikes/kitty-SPEC.md`, così Claude può leggerlo.

---

Stai facendo uno **spike a tempo** per un nuovo progetto, kit+ty. Le fasi e le regole di prodotto del vecchio `PROMPT-hackathon.md` **non si applicano** a questa sessione; valgono le regole tecniche del vecchio `CLAUDE.md` (niente API inventate, solo regtest, niente segreti nei commit, fermati dopo 3 fallimenti uguali).

Leggi `spikes/kitty-SPEC.md`, in particolare §4, §10 e §19, e `docs/STATUS.md` per sapere come funziona lo stack.

## Obiettivo
Rispondere con prove alle 10 domande di SPEC §19, per decidere alle 13:30 se kit+ty usa Lightning (`ln-2ch` o `ln-lsp`) o la modalità `onchain`. **Non scrivere codice di prodotto.** Script e note vanno in `spikes/ln/`, su un branch `spike-ln`.

## Vincoli
- Solo endpoint e campi presenti in `docs/vendor/rln-openapi.yaml`. Per i flag del demone (per esempio la porta peer di LDK) controlla il README upstream o l'`--help` del binario nell'immagine; non indovinarli.
- Usa `curl` o un piccolo script TypeScript. Salva ogni richiesta che funziona, con il body esatto.
- **Ore 13:00:** smetti di sperimentare e scrivi i risultati.

## Passi
0. Stack su con **4 nodi** (alice, bob, charlie, dave). Se `rln-dave` non è nel compose, aggiungilo (porta API 3004). Verifica che ogni nodo abbia una porta peer LN raggiungibile dagli altri nella rete docker. Tutti i nodi sbloccati e con BTC; DUSD distribuiti in modo che alice, bob, charlie **e dave** ne abbiano almeno 200.00 on-chain (va bene trasferirli da chi li ha emessi).
1. `/connectpeer` tra ogni viaggiatore e dave.
2. **D1** canale alice → dave con DUSD: `/openchannel` con `asset_id`, `asset_amount` 5000, capacità adeguata (≥ `rgb_channel_capacity_min_sat` da `/nodeinfo`; prova 100000), `push_msat` 0, commissioni 0. Mina i blocchi necessari, poi `/listchannels` finché `ready` e `is_usable`. Annota quanti blocchi servono.
3. **D2** secondo canale **dave → alice** con 3000 DUSD di dave. Funziona con un canale già aperto nella stessa coppia?
4. Ripeti 2-3 per bob.
5. **D3** bob crea `/lninvoice` con `asset_id`, `asset_amount` 309, `amt_msat` = `rgb_htlc_min_msat`, `description` "kitty:test:1:alice", `expiry_sec` 3600. Alice paga con `/sendpayment`. Interroga `/getpayment` su alice e su bob finché `Succeeded` o `Failed`. Annota la latenza. Prova sia con canali `public: true` sia `false` se il primo tentativo fallisce.
6. **D4** la `preimage` è presente su `/getpayment` del **pagatore**? Verifica `sha256(preimage) == payment_hash`.
7. **D5** `/decodelninvoice` sull'invoice di bob, chiamato dal nodo di alice: `payee_pubkey` coincide con `/nodeinfo.pubkey` di bob?
8. **D6** `/signmessage` su alice con un messaggio di prova. Descrivi il formato di `signed_message`. Scrivi `spikes/ln/verify-sig.ts` che verifica la firma con la pubkey di alice (prova lo schema Lightning: firma ricuperabile su `sha256d("Lightning Signed Message:" + msg)` codificata zbase32; usa `@noble/secp256k1` e `@noble/hashes`). Massimo un'ora; se non ci riesci, scrivi cosa hai osservato.
9. **D7** apri i due canali per charlie, poi chiudi in modo **cooperativo** da dave (`/closechannel`, `force: false`). Mina. Dove finiscono i DUSD di charlie? Li vede `/assetbalance` di charlie come `settled`? Servono `/refreshtransfers` o `/sync`?
10. **D8** (solo se c'è tempo) `/backup` su un nodo sbloccato: errore o file? Dove scrive nel container? Prova `/restore` su un nodo nuovo.
11. **D9** `local_balance_sat` dei canali prima e dopo il pagamento del passo 5: quanti sat si spostano? Quanti pagamenti regge un canale da 100000 sat?
12. **D10** paga un invoice con `expiry_sec` 5 dopo 10 secondi: che errore restituisce?

## Risultato
Scrivi `spikes/ln/RESULTS.md` con questa struttura, poi copialo nel nuovo repo come `docs/spike-lightning.md`:

```
# Spike Lightning RGB: risultati
Data, commit RLN, durata.
## Verdetto
Modalità consigliata: ln-2ch | ln-lsp | onchain, con il motivo in una riga.
## Domande
| # | Domanda | Esito ✅/⚠️/❌ | Note |
## Richieste che funzionano
Per ogni passo: endpoint, nodo, body JSON esatto, risposta abbreviata, blocchi minati.
## Sorprese e trappole
## Parametri consigliati per il seed
capacity_sat, push_msat, public, with_anchors, fee, blocchi per la conferma, amt_msat degli invoice.
```

Fermati quando `RESULTS.md` è scritto.
