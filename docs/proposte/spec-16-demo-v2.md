# Proposta per SPEC §16: la demo guidata dal registro v2 (`KITTY_REGISTRY=v2`)

> **Proposta, NON applicata** a `docs/SPEC.md`. Decisioni del 23/10: Dave solo LSP, nessuna chiusura decisa da qualcuno, contestazioni ritirate (C3) o a maggioranza. La demo v1 (SPEC §16 come è oggi) resta quella di `pnpm e2e:demo` e del tag `demo-finale-v1`.
> Lo script senza UI è `apps/agent/src/e2e/demo-v2.e2e.ts` (`pnpm demo:reset && pnpm e2e:demo:v2`). Ogni passo qui sotto è un test di quello script.

## La storia (circa 3 minuti)

Prima di salire sul palco: `pnpm demo:reset`, poi gli agenti con `KITTY_REGISTRY=v2`. Alice crea il viaggio nel registro e invita Bob e Charlie; Dave è solo l'LSP: non è nel gruppo.

1. **Viaggio:** "Ognuno ha 50.00 nel suo canale con l'LSP. Solo lui può spenderli. Nel gruppo non c'è un capo: Alice, Bob e Charlie, ognuno con la sua chiave."
2. **Alice** fotografa lo scontrino → l'AI sul dispositivo legge le righe → scrive la frase → quote 3.09 / 3.09 / 3.50 calcolate dal ledger con il cambio salvato sul telefono → Invia.
3. **Charlie** contesta: "Ho preso solo acqua". Bob vede la contestazione: è l'unico che può votare (né creditore né debitore).
4. **Bob** non tocca nulla: dopo il silenzio-assenso il suo agente paga 3.09 ad Alice; pannello Prova verificato, nessun blocco minato.
5. **Charlie** rivede la riga e la approva: la contestazione è ritirata (C3) e il suo agente paga 3.50. Nessuno decide per lui: le rotte di Dave come coordinatore rispondono `NOT_ALLOWED`.
6. **Alice:** "Rimborsata 6.59: 3.09 da Bob, 3.50 da Charlie". Registro verificato, lo stesso stato su 3/3 telefoni.
7. **Fine viaggio:** Bob, Charlie e Alice escono uno dopo l'altro; ognuno chiude dal proprio wallet i propri canali con l'LSP e riceve i suoi DUSD on-chain. Quando sono usciti tutti, il viaggio risulta chiuso su ogni telefono.

Chiusura: **"Nessuno ha custodito i soldi di nessuno, e nessuno ha deciso per gli altri. Chi contestava ha ritirato da solo; ognuno è uscito chiudendo i propri canali."**

Saldi attesi dopo il passo 6: Alice 56.59 nel canale (50.00 + 6.59 ricevuti), Bob 46.91, Charlie 46.50. Dopo il passo 7: canali chiusi, gli stessi importi tornati on-chain a ciascuno.

## Differenze con la demo v1, passo per passo

| Passo | v1 (`e2e:demo`) | v2 (`e2e:demo:v2`) |
|---|---|---|
| Preparazione | Dave crea il viaggio, pubblica il cambio, ammette i membri e attesta i canali (`TRIP_CREATED`, `RATE_SET`, `MEMBER_ADMITTED`, `CHANNELS_READY`) | Alice crea il viaggio nel registro v2 e invita Bob e Charlie (`MEMBER_INVITED`, `MEMBER_JOINED` con `kitty-bind:v2`); Dave non è nel registro |
| 1 | 50.00 a testa | Uguale; in più: tre membri attivi, nessun coordinatore, Dave senza viaggio |
| 2 | AI, frase, quote con il cambio del giorno di Dave | AI e frase uguali; quote con il cambio salvato sul telefono di Alice, firmato nella proposta |
| 4 | Charlie contesta | Uguale; in più Bob risulta l'unico votante della contestazione |
| 3 | Bob paga dopo il silenzio-assenso | Uguale |
| 5 | Dave vede la contestazione e conferma la riga (`DISPUTE_RESOLVED`) | Nessun coordinatore: le rotte di Dave rispondono `NOT_ALLOWED`. Charlie ritira la contestazione approvando (C3) e il suo agente paga 3.50 |
| 6 | Charlie non paga; Dave copre 3.50 con la liquidità dell'operatore ed esclude Charlie chiudendogli i canali | Non serve: Charlie ha pagato. Nessuna garanzia e nessuna esclusione (sarebbe la maggioranza dei blocchi) |
| 6 | I 50.00 di Charlie tornano a lui on-chain dopo l'esclusione | Ognuno riavrà i propri DUSD on-chain al passo 7, uscendo |
| 7 | Alice: 3.09 da Bob e 3.50 garantiti dall'operatore | Alice: 3.09 da Bob e 3.50 da Charlie, entrambi pagati dal debitore |
| B6 | Backup cifrato dei tre nodi sul relay | Uguale |
| 7 | "Registro verificato, uguale su 4/4" (catena di hash e `CHECKPOINT`, Dave compreso) | "Lo stesso stato su 3/3": `stateHash` uguale sui tre telefoni, nessun evento rifiutato, nessun genitore mancante; i `CHECKPOINT` arrivano con il passo 4 |
| — | — | Nuovo: ognuno esce e chiude i propri canali con l'LSP; i DUSD tornano on-chain; il viaggio risulta chiuso |
| 8 (P1) | `demo:lose-phone bob` | Non provato con v2: il registro v2 vive in memoria fino al passo 4, e dopo un riavvio degli agenti riparte da zero |

## Limiti da dire

- Fino al passo 4 il registro v2 viaggia dentro il processo degli agenti, senza relay e senza persistenza; l'invito (il QR) passa da un agente all'altro nel processo.
- La regola delle contestazioni è provvisoria; in un gruppo di tre c'è un solo votante.
- L'LSP gestisce la liquidità guardando solo i propri canali: riapre dopo un pagamento, non prima.
