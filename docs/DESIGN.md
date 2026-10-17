# kit+ty: identità visiva e regole di interfaccia

> Fonte per tutto ciò che si vede in `apps/web`. I flussi stanno in `docs/FLOWS.md`; qui c'è solo l'aspetto.
> Testi della UI in **inglese**. Questo documento è in italiano.

## 1. L'idea: +ty

**kit+ty** si legge "kitty" (la cassa comune) oppure "kit plus thank you". Tutta l'esperienza gira intorno a **+ty**:

- soldi che **arrivano** → **+ty**: un grazie;
- debito **saldato** → **-ty**: un conto chiuso.

Il "+" del nome è il segno distintivo: rosa nel logo, e ricorre come segno degli importi in entrata.

## 2. Tono

Giocoso ma chiaro. Una battuta al massimo per schermata; gli importi e le azioni sono sempre detti in modo esplicito.

| Momento | Testo |
|---|---|
| Pagamento ricevuto (notifica/toast) | `+ty! 3.09 DUSD from Bob` |
| Debito saldato | `-ty! You settled 3.50 DUSD with Alice` |
| Nuova spesa da approvare | `Alice paid for Taxi. Your part: 17.44 DUSD` |
| Auto mode attivo | badge `Auto mode` |
| Saldo | sotto il saldo: `Only you can spend it` |
| Caricamento AI | `Reading the receipt on your phone…` + tempo trascorso |
| Attesa agente | `Waiting for Bob's agent…` + tempo trascorso |
| Errore | frase umana + azione: `Bob's node is not answering. Try again in a few seconds.` |

Mai "quota" o "threshold" nella UI: si dice **your part** e **limit**.

## 3. Palette

Stile **plain**: colori opachi, base neutra calda, accenti dalla palette. Niente ombre, gradienti, bagliori o trasparenze.

Variabili da mettere in `apps/web/src/index.css` (tutto il resto del CSS usa solo queste):

```css
:root {
  /* base neutra (bianco caldo, tinto verso il rosa della palette) */
  --bg:         #F7F1EE;  /* sfondo dell'app */
  --surface:    #FFFBF8;  /* card */
  --line:       #EADDE0;  /* bordi e divisori */
  --ink:        #2B1B28;  /* testo principale (prugna quasi nera) */
  --ink-muted:  #7D6A78;  /* testo secondario, date */

  /* palette del progetto */
  --plum:       #81366F;  /* primario: pulsanti principali, barra in basso, titoli forti */
  --pink:       #F25481;  /* accento: il "+" del logo, notifiche, cose che chiedono attenzione */
  --mint:       #9CE7AB;  /* successo: Auto mode, active, pagato */
  --teal:       #42848A;  /* informazione: importi in entrata, link, limite, avanzamento */

  /* tinte chiare per sfondi di badge e banner (stessa tinta, più chiara) */
  --plum-soft:  #EBD9E5;
  --pink-soft:  #FDDCE6;
  --mint-soft:  #DDF6E3;
  --teal-soft:  #D6E8E9;
}
```

**Ruoli fissi**

| Cosa | Colore |
|---|---|
| Pulsante primario (Approve, Send, Confirm) | fondo `--plum`, testo `--surface` |
| Pulsante secondario (Dispute, Cancel) | bordo `--plum`, testo `--plum`, fondo trasparente |
| Importo in entrata `+3.09` | `--teal`, grassetto |
| Importo in uscita `−3.50` | `--pink`, grassetto |
| Card da approvare / insolvenza | bordo `--pink`, fondo `--pink-soft` |
| Conto alla rovescia | `--pink` sotto i 10 s, altrimenti `--ink-muted` |
| Barra di avanzamento | `--teal` su `--teal-soft` |

Contrasto: rosa e menta **non** si usano per testo piccolo su fondo chiaro; per i testi piccoli c'è sempre `--ink` su una tinta `-soft`.

## 4. Font

- **Titoli, saldo e importi:** **Zilla Slab** (il font slab di Mozilla, su Google Fonts). Pesi 500 e 700. Gli importi con `font-variant-numeric: tabular-nums`.
- **Testo e pulsanti:** **Fira Sans** (famiglia nata per Mozilla). Pesi 400 e 600.
- **ID, hash, chiavi (Registro, Prova, QR):** **Fira Mono** 400.

```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Mono&family=Fira+Sans:wght@400;600&family=Zilla+Slab:wght@500;700&display=swap');
```

> Da confermare dal PM: "il font di Mozilla, mono con le grazie" → interpretato come **Zilla Slab** (slab con l'aria da macchina da scrivere). Se si intendeva un mono vero, si sostituisce con un mono slab (es. Courier Prime) solo nelle variabili qui sotto.

| Token | Uso | Font, dimensione |
|---|---|---|
| `--fs-balance` | saldo in Home | Zilla Slab 700, 40px |
| `--fs-title` | titoli di schermata | Zilla Slab 700, 22px |
| `--fs-amount` | importi nelle righe | Zilla Slab 500, 17px |
| `--fs-body` | testo | Fira Sans 400, 15px |
| `--fs-small` | date, didascalie, badge | Fira Sans 600, 12px |

## 5. Forme e spazi

- Raggi: card **16px**, pulsanti **12px**, badge e barra in basso **pillola** (999px).
- Bordi: **1.5px** `--line`. Le card si distinguono dal fondo per colore e bordo, mai per ombra.
- Spaziatura a multipli di 4: 4 / 8 / 12 / 16 / 24 / 32.
- Margine laterale dello schermo **16px**; padding interno delle card **16px**; spazio tra card **12px**.
- Larghezza massima 420px, centrata (tre finestre affiancate in demo).
- Il contenuto scorre **dietro** la barra in basso: padding inferiore della pagina 96px.

## 6. Layout delle schermate

**Home viaggiatore**, dall'alto:
1. Barra in alto: avatar a sinistra, logo `kit+ty` a destra (apre il Profilo).
2. **Card Balance**: etichetta `Balance`, importo grande al centro, sotto `Only you can spend it`; fila di chip azione (occhio per nascondere il saldo).
3. **Card del gruppo**: titolo del gruppo + badge del limite (tocco → slider). In cima le card da approvare (bordo rosa), poi lo storico.
4. Righe dello storico: avatar tondo con l'iniziale (fondo `-soft` del membro), nome in grassetto, descrizione sotto in `--ink-muted`, a destra importo `+/−` e data piccola.
5. **Barra flottante**: pillola con **tre pulsanti tondi della stessa dimensione** (Groups · 📷 · QR), stesso stile, icona + etichetta piccola. Fondo `--plum`, icone `--surface`.

**QR**: schermo intero; in basso uno switch a pillola `Scan | Show`. Apre su **Show**.

**Dave**: stessa struttura (wireframe `docs/design/wireframe-dave.pdf`); la barra ha Members · Home · Log.

## 7. Componenti

**Badge** (pillola, 12px Fira Sans 600, padding 4×10, testo sempre `--ink`):

| Badge | Fondo |
|---|---|
| `Auto mode` | `--mint` |
| `Limit 10.00` | `--teal-soft` |
| `Always ask` | `--line` |
| `active` | `--mint-soft` |
| `insolvent` | `--pink-soft` (bordo `--pink`) |
| `excluded` | `--line`, testo barrato |
| `operator` | `--plum-soft` |

**Toast +ty / -ty**: pillola in alto, fondo `--mint-soft` per `+ty`, `--plum-soft` per `-ty`; il prefisso `+ty!` / `-ty!` in Zilla Slab 700. Resta 3 secondi.

**Slider del limite**: binario `--line`, parte riempita `--teal`, pomello tondo `--plum`. A fine corsa l'etichetta diventa il badge `Auto mode`.

## 8. La mascotte: il gattino +ty

Un **maneki-neko** (il gattino cinese che saluta con la zampa): solo **contorno** `--ink`, interno **bianco caldo** `--surface`, dettagli (orecchie interne, guance, collarino, campanella) in `--pink` e `--plum`. Niente ombre, tratto uniforme 2px.

- **Caricamenti**: compare il gattino e **muove la zampa** (rotazione avanti e indietro di circa 20°, perno sulla spalla, 0,8 s, infinito), con sotto il testo dell'attesa.
- Con `prefers-reduced-motion` la zampa sta ferma.
- Un solo SVG inline (`apps/web/src/Mascot.tsx`), con la zampa in un gruppo separato per l'animazione. Va bene una prima versione semplice disegnata in codice; il PM può sostituirla.
- Dove compare: caricamento iniziale, lettura dello scontrino, attesa di pagamenti, "Cover and exclude". Piccolo (48px) nei toast di `+ty`.

## 9. Cosa capisce un giudice in 3 secondi

- **Home viaggiatore**: "ho X dollari che solo io posso spendere, sono in Auto mode in questo gruppo, c'è una spesa che aspetta me (bordo rosa)".
- **Home Dave**: "c'è una contestazione e un insolvente: io decido".
- **Ogni pagamento**: un `+ty!` che arriva in tempo reale sull'altra finestra.

## 10. Cosa non si fa

Ombre, gradienti, effetti vetro, animazioni oltre alla zampa del gattino, colori fuori palette, testo piccolo rosa o menta su fondo chiaro, più di un accento forte per card.
