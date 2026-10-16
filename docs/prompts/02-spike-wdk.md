# Prompt 02: spike motore WDK (Dev B, venerdì pomeriggio, massimo 3 ore)

> Da incollare in una sessione Claude Code nel repo **`kit-ty`**, su un branch `spike-wdk`. Il codice va solo in `spikes/wdk/`. Lo stack regtest (bitcoind, electrs, proxy) è quello del vecchio repo **con i container RLN spenti**, oppure quello di B1 se è già pronto.

---

Stai facendo lo **spike 2** di kit+ty. Leggi `CLAUDE.md`, SPEC §9.1, §10, §12, §14.0, §19 e `docs/spike-lightning.md` (lo spike 1, con RLN via REST: ti dice cosa aspettarti da RGB su Lightning).

## Obiettivo
Capire se possiamo usare **nativamente** i moduli WDK di UTEXO come wallet di ogni membro, al posto di RLN in Docker:
- `@utexo/wdk-rgb-lightning` (versione `0.1.0-beta.15`) con la libreria nativa `@utexo/rgb-lightning-node-nodejs` (`0.1.0-beta.11`): nodo RGB Lightning in-process, canali, invoice, pagamenti, firma dei messaggi, backup VSS;
- `@utexo/wdk-wallet-rgb`: wallet RGB on-chain ed emissione degli asset.

Versioni **esatte** (niente `^`). Fonti, nell'ordine: README e definizioni TypeScript nei pacchetti installati in `node_modules`; la documentazione WDK della comunità (`docs.wdk.tether.su/sdk/community-modules/wdk-rgb-lightning/`, con le pagine Configuration, Usage, API reference, guida VSS); il repository `github.com/UTEXO-Protocol/wdk-rgb-lightning` al tag `v0.1.0-beta.15`. **Salva in `docs/vendor/wdk-rgb-lightning.md` e `docs/vendor/wdk-wallet-rgb.md`** le parti di API che usi (firme dei metodi e opzioni), così le altre sessioni non devono indovinarle. Mai inventare nomi di metodi.

## Domande (in quest'ordine; fermati alle 2h45 e scrivi i risultati)
1. **Installazione:** i pacchetti e la libreria nativa si installano sul Mac della demo (arm64 o x64) con Node ≥ 22.17? Errori di postinstall?
2. **Più nodi:** si possono creare 4 `WalletManagerRgbLightning` (alice, bob, charlie, dave) nello **stesso processo** Node, con `dataDir` e porte peer diverse? Se no, un processo per nodo funziona?
3. **Sblocco su regtest** con i servizi dello stack (bitcoind RPC, electrs, proxy RGB).
4. **Fondi:** BTC dal miner. DUSD: emettili con `wdk-wallet-rgb` (seed di dave, `dataDir` separata), poi trasferiscili on-chain ai nodi Lightning dei membri. Possono i due moduli usare **lo stesso seed** senza conflitti sugli UTXO? Se no, quale schema di derivazione o di seed separati consigliano i documenti?
5. **Canali:** canale di viaggio alice → dave (5000 DUSD) e canale di liquidità dave → alice (3000), **capacità 1,000,000 sat**; lo stesso per bob. Quanti blocchi servono?
6. **Pagamento instradato** alice → dave → bob con invoice RGB da 309 DUSD: esito, latenza, preimage lato pagatore, `payee_pubkey` dalla decodifica dell'invoice.
7. **Limite in volo:** con capacità 1,000,000 sat, quanti pagamenti possono restare in volo (`next_outbound_htlc_limit_msat` o equivalente)?
8. **Firma dei messaggi** con l'identità del nodo: due messaggi diversi danno firme diverse? La verifica rifiuta una firma alterata? **Qual è il formato** (Schnorr BIP-340, ECDSA ricuperabile in stile Lightning, altro)? Scrivi `spikes/wdk/verify.ts` che verifica la firma **in TypeScript puro** (`@noble/curves` o `@noble/secp256k1`), senza la libreria nativa: il relay deve poter verificare senza un nodo.
9. **VSS:** quale server VSS si può far girare in locale (cerca nei documenti del modulo e nel repository; l'implementazione di riferimento di LDK è `lightningdevkit/vss-server`)? Avvialo in Docker; poi `vssBackup()`: il nodo resta utilizzabile durante il backup? Ripristino: nodo nuovo con lo stesso seed, stessa `dataDir` vuota, `clearVssFence` → tornano canali e DUSD? Un pagamento funziona dopo il ripristino? Massimo 1 ora su questa domanda.
10. **Chiusura cooperativa** dave ↔ bob: dove finiscono i DUSD e quanti blocchi servono.
11. **(Facoltativa)** Un nodo `wdk` apre un canale RGB con un nodo RLN `d4762ac` in Docker? Serve solo se il motore `wdk` funziona per i viaggiatori ma non per Dave.

## Risultato
Scrivi `spikes/wdk/RESULTS.md` e copialo in `docs/spike-wdk.md`, con la stessa struttura dello spike 1:
- **Verdetto:** motore consigliato `wdk` | `rln-rest` | misto, con il motivo in una riga; e in più firma (nativa o ed25519) e backup (VSS o lock-backup).
- Tabella delle domande con esito ✅/⚠️/❌.
- Il codice minimo che funziona per ogni passo (costruttore, sblocco, apertura canale, invoice, pagamento, firma, backup, ripristino), con le opzioni esatte.
- Sorprese e trappole; parametri consigliati per il seed.

**Regola del gate 2:** domande 5 e 6 verdi tra nodi `wdk` → motore `wdk`. Firma o VSS rossi da soli non lo scartano: si usano i fallback di SPEC §9.1 e §12. Altrimenti `rln-rest`, già verificato.

Fermati quando `RESULTS.md` è scritto.
