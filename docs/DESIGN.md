# kit+ty: identità visiva e regole di interfaccia

> Fonte per tutto ciò che si vede in `apps/web`. Flussi: `docs/FLOWS.md`. Layout: `docs/design/wireframe-traveler.pdf`, `docs/design/wireframe-dave.pdf` (posizioni vincolanti). Mascotte: `docs/design/kitty-mascot.svg`.
> Testi della UI in **inglese**. Questo documento è in italiano.

## 0. In una riga

**Un'app iPhone pulita** (linguaggio delle Human Interface Guidelines di Apple), con l'identità di kit+ty: bianco che respira, accento rosa, il gattino +ty. Gira nel browser a larghezza telefono (in demo tre finestre affiancate), quindi niente sidebar desktop.

## 1. L'idea: +ty

**kit+ty** si legge "kitty" (la cassa comune) oppure "kit plus thank you":

- soldi che **arrivano** → **+ty!** (un grazie);
- debito **saldato** → **-ty!** (un conto chiuso).

## 2. Tono

Giocoso ma chiaro: una battuta al massimo per schermata; importi e azioni sempre espliciti.

| Momento | Testo |
|---|---|
| Pagamento ricevuto | `+ty! 3.09 DUSD from Bob` |
| Debito saldato | `-ty! You settled 3.50 DUSD with Alice` |
| Nuova spesa da approvare | `Alice paid for Taxi. Your part: 17.44 DUSD` |
| Sotto il saldo | `Only you can spend it` |
| Lettura scontrino | `Reading the receipt on your phone…` + tempo trascorso |
| Attesa | `Waiting for Bob's agent…` + tempo trascorso |
| Errore | frase umana + azione: `Bob's node is not answering. Try again in a few seconds.` |

Nella UI si dice **your part** e **limit**, mai "quota" o "threshold".

## 3. Colori

I quattro colori del progetto sono **due coppie, una per tema**, e non si usano tutti insieme:

| Tema | Accento (tint iOS) | Positivo (al posto del verde di sistema) |
|---|---|---|
| **Light** (default) | `#F25481` rosa | `#9CE7AB` menta |
| **Dark** | `#81366F` prugna | `#42848A` teal |

Il resto è la scala neutra di iOS (sfondi raggruppati, etichette a opacità, separatori sottili), scaldata appena verso il rosa. Il rosso di sistema si usa **solo** per errori e azioni distruttive (`Cover and exclude`).

```css
:root {
  /* sfondi stile iOS (grouped) */
  --bg-grouped:    #F6F2F4;   /* systemGroupedBackground, appena caldo */
  --bg-cell:       #FFFEFE;   /* celle e card: il bianco che domina */
  --bg-fill:       rgba(120,110,116,0.12);  /* fill di controlli e campi */
  --separator:     rgba(60,50,58,0.18);     /* 0.5px */

  /* etichette */
  --label:         #1C1A1C;
  --label-2:       rgba(28,26,28,0.60);
  --label-3:       rgba(28,26,28,0.30);

  /* identità */
  --accent:        #F25481;
  --accent-soft:   #FDE7EE;
  --on-accent:     #FFFFFF;
  --positive:      #9CE7AB;
  --positive-soft: #E9F9ED;
  --on-positive:   #1F3B27;
  --danger:        #FF3B30;

  --kitty-cat-line: #F25481;
  --kitty-cat-fill: #FFFFFF;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-grouped:    #000000;
    --bg-cell:       #1C1C1E;
    --bg-fill:       rgba(120,120,128,0.24);
    --separator:     rgba(84,84,88,0.65);

    --label:         #FFFFFF;
    --label-2:       rgba(235,235,245,0.60);
    --label-3:       rgba(235,235,245,0.30);

    --accent:        #81366F;
    --accent-soft:   #3A2034;
    --on-accent:     #FFFFFF;
    --positive:      #42848A;
    --positive-soft: #1E3335;
    --on-positive:   #FFFFFF;
    --danger:        #FF453A;

    --kitty-cat-line: #F25481;   /* il gattino resta rosa e bianco */
    --kitty-cat-fill: #FFFFFF;
  }
}
```

Nel CSS si usano **solo** queste variabili, mai un colore scritto a mano.

**Ruoli**

| Cosa | Stile |
|---|---|
| Pulsante primario (Approve, Send, Confirm) | *filled*: fondo `--accent`, testo `--on-accent` |
| Pulsante secondario (Dispute, Cancel) | *gray*: fondo `--bg-fill`, testo `--label` |
| Azione leggera (See all, Edit) | *plain*: testo `--accent` |
| Azione distruttiva (Cover and exclude) | *tinted* rosso: testo `--danger` su fill rosso al 12% |
| Importo in entrata `+17.44` | testo `--label` su pillola `--positive-soft` |
| Importo in uscita `−3.09` | testo `--label` |
| Card da approvare | fondo `--accent-soft`, conto alla rovescia in `--accent` |

## 4. Tipografia

- **UI:** font di sistema iPhone: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif` (sul Mac e sull'iPhone è SF; Inter come fallback). Nessun file SF incluso.
- **Importi:** stesso font con `font-variant-numeric: tabular-nums`.
- **Solo per il marchio:** **Zilla Slab** 700 (il font slab di Mozilla) per il logo `kit+ty` e per i prefissi `+ty!` / `-ty!` nei toast. Da nessun'altra parte.
- **Hash e ID** (QR, Registro, Prova): `ui-monospace, "SF Mono", "Fira Mono", monospace`.

```css
@import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@700&family=Inter:wght@400;600;700&display=swap');
```

Scala HIG (dimensione / interlinea):

| Stile | Uso in kit+ty |
|---|---|
| Large Title 34/41 bold, tracking −0.4 | titoli di Groups, Profile; saldo |
| Title2 22/28 bold | titolo del gruppo in Home |
| Headline 17/22 semibold | titoli delle righe e delle card |
| Body 17/22 | testo |
| Subheadline 15/20 | descrizioni sotto i titoli delle righe |
| Footnote 13/18 | header di sezione (MAIUSCOLO, `--label-2`), date |
| Caption1 12/16 | badge, etichette della barra in basso |

## 5. Forme, spazi, materiali

- Griglia da 8pt (sottomultipli di 4). Margini laterali **16px**.
- Raggi continui: controlli **10px**, card e liste inset **14px**, sheet **24px** in alto, badge e barra in basso a pillola.
- **Niente ombre, niente gradienti, niente vetro.** Le barre sono **opache** (`--bg-cell`) con separatore 0.5px: la gerarchia nasce dal colore degli sfondi (grouped vs cell), come in Impostazioni.
- Aree toccabili almeno 44×44px. Supporto `safe-area-inset-*`.
- Larghezza massima 430px, centrata.
- Icone: `lucide-react`, tratto 1.75, 22px (coerenti con SF Symbols).

## 6. Movimento

- Spring 300-450ms senza rimbalzo eccessivo; push tra schermate, sheet dal basso.
- Al tocco: scala 0.97 e opacità 0.7 su `:active`.
- L'unica animazione "di carattere" è la zampa del gattino.
- Rispettare `prefers-reduced-motion`.

## 7. Componenti (primitivi in `apps/web/src/ui/`)

- **Lista inset grouped**: header di sezione in Footnote maiuscolo; righe con avatar o icona in quadratino colorato (raggio 7), titolo Headline, sottotitolo Subheadline `--label-2`, valore a destra, chevron dove si naviga; separatori 0.5px rientrati.
- **Riga transazione**: avatar tondo con iniziale, titolo, descrizione, importo a destra (tabular), data sotto in Footnote.
- **Card di approvazione**: blocco `--accent-soft` raggio 14, titolo Headline, frase dell'agente in Subheadline, conto alla rovescia a destra, due pulsanti affiancati (gray `Dispute`, filled `Approve`).
- **Badge** (pillola Caption1 semibold): `Auto mode` fondo `--positive` testo `--on-positive`; `Limit 10.00` e `Always ask` fondo `--bg-fill`; `active` `--positive-soft`; `insolvent` `--accent-soft`; `excluded` `--bg-fill` barrato; `operator` `--bg-fill`.
- **Barra in basso**: pillola flottante opaca `--bg-cell` con bordo 0.5px `--separator`, **tre pulsanti identici** (Groups · Expense · QR), icona + Caption; l'attivo in `--accent`. Il contenuto scorre dietro (padding inferiore 104px).
- **Navigation bar** (schermate secondarie): back in `--accent` con chevron, titolo inline; Large Title che si comprime allo scroll in Groups e Profile.
- **Segmented control** `Scan | Show` (QR). **Slider** iOS del limite: binario `--bg-fill`, parte piena `--positive`, pomello bianco tondo 28px con bordo 0.5px.
- **Sheet** dal basso con grabber (Dispute); fondo dello schermo scurito al 30%.
- **Toast +ty / -ty**: pillola in alto, gattino 22px, prefisso in Zilla Slab; `+ty` su `--positive-soft`, `-ty` su `--accent-soft`. 3 secondi.
- **Stati**: caricamento con il gattino che saluta + testo; vuoto con gattino + titolo + testo + azione; errore con frase umana + `Try again`.
- **Mascot**: l'SVG di `docs/design/kitty-mascot.svg` incorporato **inline** (non `<img>`, altrimenti variabili e animazione non funzionano), prop `size` e `waving`.

## 8. Layout delle schermate

Posizioni dai wireframe, **non spostare gli elementi**. In sintesi, Home viaggiatore dall'alto: pillola del saldo con l'occhio (sinistra) e sotto `Only you can spend it`; logo `kit+ty` (destra, apre Profile); titolo del gruppo + badge del limite (tocco → slider); card del gruppo con le approvazioni in cima e lo storico; Group 2 tratteggiato e non attivo; barra in basso.

## 9. Cosa capisce un giudice in 3 secondi

- **Home viaggiatore**: "ho X dollari che solo io posso spendere; in questo gruppo sono in Auto mode; c'è una spesa che aspetta me".
- **Home Dave**: "c'è una contestazione e un insolvente: decido io".
- **Ogni pagamento**: un `+ty!` che compare in tempo reale nell'altra finestra.

## 10. Cosa non si fa

Look Material o da template SaaS, ombre, gradienti, vetro e blur, bordi spessi, i quattro colori insieme nello stesso tema, colori fuori dai token, loghi o asset di Apple (si imita il linguaggio, non il marchio), spostare elementi rispetto ai wireframe.
