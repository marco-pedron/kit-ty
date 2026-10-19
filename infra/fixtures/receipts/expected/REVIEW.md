# Expected values degli scontrini: note di revisione

Riguarda i 39 file in `infra/fixtures/receipts/expected/`, `simple/expected/` e `hard/expected/`, uno per scontrino (`<nome>.json`, stesso nome del PNG). Li usa la suite di accuratezza dell'OCR (`pnpm ai:test`). Gli `expected.json` dei generatori, letti da `pnpm ai:eval`, restano invariati.

## Da dove viene ogni campo

Ogni file ha un `_source` con la stessa forma del dato: `generator`, `smolvlm2` o `manual`.

| Campo                                                                                               | Fonte                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`, `currency`, `items[].quantity`, `items[].unitPrice`, `items[].total`, `tax`, `tip`, `total` | `generator`: l'`expected.json` dello script che disegna l'immagine, quindi vero per costruzione                                                                                                                                  |
| `merchant`, `items[].label`, `subtotal`                                                             | `smolvlm2`, cioè QVAC `SMOLVLM2_500M_MULTIMODAL_Q8_0` che legge direttamente l'immagine (mai l'OCR dell'app), verificato a occhio sull'immagine; `manual` dove la lettura era sbagliata ed è stata corretta guardando l'immagine |

Lo strumento è `apps/agent/src/ai/accuracy/vlm-reference.ts`. Se SmolVLM2 (500M) legge lo scontrino intero, va in loop sugli scontrini lunghi: ripete "813246001", "000000" o "0,99 A" all'infinito su tutti e tre gli scontrini di `hard/`. Per questo legge **una riga stampata alla volta**: le righe si trovano dai pixel (`png-rows.ts`, bande di inchiostro separate da spazi bianchi), senza usare l'OCR dell'app. La trascrizione grezza di ogni riga è salvata in `_vlmRows` per tracciabilità.

Il bilancio sui 36 scontrini puliti è di 185 campi presi da SmolVLM2: **132 confermati** e **53 corretti** (`manual`, elenco sotto). Nessun campo è `null`: non c'è nulla di illeggibile.

### Regole per i campi testuali

- `merchant`: la prima riga stampata (l'insegna), non la ragione sociale.
- `label`: il nome del prodotto come stampato, senza prezzi, senza "2 x", senza il codice IVA ("A", "B", "C") e senza le sotto-righe ("+ Patatine grandi", "0,734 kg x 2,49 EUR/kg"). Le misure che fanno parte del nome restano: "Water 1.5L", "NUGGETS 9PZ", "ACQUA NAT. 6X1,5L". Per l'articolo a peso di `usd-supermarket` resta il peso e cade il prezzo al kg: "Bananas 0.73 kg". Sono le stesse regole del prompt dell'app (`prompts/extract-receipt.md`).
- `subtotal`: la riga "Subtotal" o "Tam tinh", se è stampata; altrimenti `null`.

## Versioni -photo

`hard/expected/*-photo.json` **derivano dalla versione pulita** (campo `_derivedFrom`) e non sono stati letti da SmolVLM2. Il generatore produce la foto dalla stessa immagine pulita (inclinazione, prospettiva, luce, rumore, sfocatura). Ho controllato a occhio che le tre foto siano leggibili e mostrino lo stesso scontrino.

## Controlli di coerenza (tutti superati, 39/39)

- articoli + tasse + mancia = totale;
- `subtotal`, se presente, = somma degli articoli;
- quantità × prezzo unitario = totale della riga;
- data ISO valida; valuta in {EUR, USD, VND}; importi in unità minime, solo cifre (2 decimali impliciti per EUR e USD, 0 per VND).

## Generatore contro immagine

**Nessuna divergenza.** Ho estratto il testo esatto di ogni riga stampata dagli script dei generatori: è il testo che disegnano. Su 264 controlli, ogni valore del generatore è stampato così com'è (es. 183 → "1,83", 255000 → "255.000"). Due falsi allarmi del controllo sono stati verificati sull'immagine: in `hard/eur-fastfood` la quantità sta prima del nome ("2 x MENU CLASSIC L 8,90 17,80").

Casi delicati, coerenti:

- `hard/eur-supermarket`, articoli a peso: BANANE 0,734 kg × 2,49 = 1,8277, stampato **1,83**, e il generatore dà 183 (quantità 1, prezzo unitario = totale della riga). Stesso discorso per PANE COMUNE (0,412 × 3,20 = 1,3184 → 1,32). Nessun arrotondamento diverso tra immagine e generatore.
- `hard/eur-fastfood` "di cui IVA 10% 2,44" e `hard/eur-supermarket` (tabella "Aliq. Imponibile Imposta") sono IVA **inclusa**: `tax` = null. `hard/vnd-restaurant` "Thue VAT 8% 21.200" è IVA **aggiunta**: `tax` = 21200.
- `hard/eur-fastfood` non stampa la valuta ("TOTALE COMPLESSIVO 26,80"): EUR viene dal generatore e dal contesto (indirizzo e P.IVA italiani, virgola decimale).

## Divergenze tra SmolVLM2 e generatore (controllo incrociato)

Ha vinto sempre il generatore. In ogni caso l'immagine dà ragione al generatore: è SmolVLM2 che ha letto male.

| Scontrino                | Campo              | Generatore (= immagine) | SmolVLM2 ha letto                                                      |
| ------------------------ | ------------------ | ----------------------- | ---------------------------------------------------------------------- |
| `vnd-dinner`             | items[0] unitPrice | 2 x 65.000              | "2 x 65.00"                                                            |
| `simple/eur-bar-01`      | items[0]           | 3 x 3,30 = 9,90         | "3 \times 3 \times 30 9 \, 90"                                         |
| `simple/eur-bar-02`      | items[1]           | 3 x 1,50 = 4,50         | "3 x 1.50 4.50" (punto invece di virgola)                              |
| `simple/usd-grocery-01`  | items[1] total     | 2.80                    | "Bread" (prezzo non letto)                                             |
| `simple/vnd-cafe-03`     | total              | 247.000                 | "247000" (senza separatore)                                            |
| `simple/vnd-minimart-03` | items[3] total     | 19.000                  | "29.000"                                                               |
| `hard/eur-fastfood`      | currency           | EUR                     | non stampata (vedi sopra)                                              |
| `hard/eur-fastfood`      | items[0] unitPrice | 2 x 8,90                | "2 x MENU CLASSIC L 8,90 17,80": corretto, falso allarme del controllo |
| `hard/eur-fastfood`      | items[2]           | 2 x 1,90 = 3,80         | riga "GELATO CARAMELLO" non trascritta                                 |
| `hard/vnd-restaurant`    | date               | 17/10/2026              | "17/10/2016"                                                           |

## Campi SmolVLM2 corretti a mano (53)

Le cause sono tre. I prezzi rimasti nell'etichetta sono un limite del mio estrattore, non del modello. Gli errori di lettura vengono dal modello ("Bank mi", "Goi com", "STAZZONE", accenti inventati). I subtotali in EUR erano letti con la scala sbagliata ("77,500" → 77500).

| Scontrino                | Campo          | SmolVLM2                               | Corretto (immagine)  |
| ------------------------ | -------------- | -------------------------------------- | -------------------- |
| `usd-supermarket`        | items[0].label | "3.73 kg @ 1.10/kg"                    | "Bananas 0.73 kg"    |
| `vnd-dinner`             | items[0].label | null                                   | "Pho bo"             |
| `simple/eur-bar-01`      | items[0].label | null                                   | "Spremuta"           |
| `simple/eur-bar-02`      | merchant       | "CAFFE DEL PONTÉ"                      | "CAFFE DEL PONTE"    |
| `simple/eur-bar-02`      | items[1].label | null                                   | "Cappuccino"         |
| `simple/eur-bar-03`      | merchant       | "BAR DELLA STAZZONE"                   | "BAR DELLA STAZIONE" |
| `simple/eur-bar-03`      | items[1].label | "Caffè espresso"                       | "Caffe espresso"     |
| `simple/eur-grocery-02`  | items[0].label | "Biscotti 6,00 6"                      | "Biscotti"           |
| `simple/eur-grocery-02`  | items[1].label | "Pane 6,00 6"                          | "Pane"               |
| `simple/eur-grocery-02`  | items[3].label | null                                   | "Pasta"              |
| `simple/eur-grocery-03`  | items[0].label | "0lio di oliva"                        | "Olio di oliva"      |
| `simple/eur-grocery-03`  | items[1].label | "Prosciutto crudo 10,20 12.0"          | "Prosciutto crudo"   |
| `simple/eur-grocery-03`  | items[2].label | "Pasta 1,000"                          | "Pasta"              |
| `simple/eur-museum-01`   | subtotal       | "47000"                                | "4700"               |
| `simple/eur-museum-01`   | items[1].label | "Catalog mostra"                       | "Catalogo mostra"    |
| `simple/eur-museum-02`   | merchant       | "MUSÉO DEL MARE"                       | "MUSEO DEL MARE"     |
| `simple/eur-museum-02`   | subtotal       | "77500"                                | "7750"               |
| `simple/eur-museum-02`   | items[1].label | "Catalog mostra 55,50"                 | "Catalogo mostra"    |
| `simple/eur-museum-03`   | subtotal       | "77000"                                | "7700"               |
| `simple/eur-museum-03`   | items[0].label | "Biglietto intero 35,00 55"            | "Biglietto intero"   |
| `simple/eur-museum-03`   | items[1].label | "Biglietto ridottto"                   | "Biglietto ridotto"  |
| `simple/eur-museum-03`   | items[2].label | "Mostra temporanea 16,00"              | "Mostra temporanea"  |
| `simple/eur-museum-03`   | items[3].label | "Catalog mostra"                       | "Catalogo mostra"    |
| `simple/eur-pizzeria-01` | items[1].label | "Tiramisu 12,00 12 x"                  | "Tiramisu"           |
| `simple/eur-pizzeria-02` | items[0].label | "Acqua frizzante 4,50 4.50"            | "Acqua frizzante"    |
| `simple/eur-pizzeria-02` | items[3].label | "Coca cola 6,00 6"                     | "Coca cola"          |
| `simple/eur-pizzeria-03` | items[0].label | "Coca cola 7,00 7 90"                  | "Coca cola"          |
| `simple/usd-diner-01`    | items[1].label | "Coffee 3.50"                          | "Coffee"             |
| `simple/usd-diner-03`    | items[0].label | "13.00"                                | "Milkshake"          |
| `simple/usd-diner-04`    | items[0].label | "French fries 8.50"                    | "French fries"       |
| `simple/usd-diner-04`    | items[2].label | "Pancakes 15.50"                       | "Pancakes"           |
| `simple/usd-grocery-01`  | items[1].label | null                                   | "Bread"              |
| `simple/usd-grocery-02`  | items[3].label | "0 Orange soda"                        | "Orange soda"        |
| `simple/usd-grocery-02`  | items[4].label | "3.50 Bananas"                         | "Bananas"            |
| `simple/vnd-cafe-02`     | items[1].label | "Tra da 14.000 2 x 7.000"              | "Tra da"             |
| `simple/vnd-cafe-02`     | items[2].label | "Ca phe sua da 93.000"                 | "Ca phe sua da"      |
| `simple/vnd-cafe-03`     | items[0].label | "Bank f Plan 15.000 25.000"            | "Banh flan"          |
| `simple/vnd-minimart-02` | items[0].label | "Nuoc suoi 10.000 2 x 5.000 2 x 5.000" | "Nuoc suoi"          |
| `simple/vnd-minimart-02` | items[1].label | "Bank quy"                             | "Banh quy"           |
| `simple/vnd-minimart-03` | items[3].label | null                                   | "Banh quy"           |
| `simple/vnd-street-01`   | items[0].label | "Bank mi"                              | "Banh mi"            |
| `simple/vnd-street-01`   | items[2].label | "Goi com"                              | "Goi cuon"           |
| `simple/vnd-street-02`   | subtotal       | "21000"                                | "91000"              |
| `simple/vnd-street-02`   | items[0].label | "Nuoc mia 20.000 2 x 10.000"           | "Nuoc mia"           |
| `simple/vnd-street-02`   | items[1].label | "Bank mi"                              | "Banh mi"            |
| `simple/vnd-street-02`   | items[2].label | "Goi com"                              | "Goi cuon"           |
| `hard/eur-fastfood`      | items[0].label | null                                   | "MENU CLASSIC L"     |
| `hard/eur-fastfood`      | items[2].label | null                                   | "GELATO CARAMELLO"   |
| `hard/eur-supermarket`   | items[3].label | "ACQUA MAT. 6X1,5L"                    | "ACQUA NAT. 6X1,5L"  |
| `hard/eur-supermarket`   | items[5].label | "PANE COUNTE"                          | "PANE COMUNE"        |
| `hard/vnd-restaurant`    | items[0].label | "Pho bo ta 130.000 2 x 65.000"         | "Pho bo tai"         |
| `hard/vnd-restaurant`    | items[1].label | "Bia Sai Goni 75.000 T5.000"           | "Bia Sai Gon"        |
| `hard/vnd-restaurant`    | items[3].label | "45.000"                               | "Nem ran"            |

## Note sulle fixture di hard/

- Copiate da `kit+ty/hard/` (fuori dal repo) in `infra/fixtures/receipts/hard/`, con `make-images-hard.py` ed `expected.json` invariati. Pesano 2,8 MB, senza LFS (scelta del 19/10).
- Lo script gira dal nuovo percorso (serve `qrcode`, oltre a Pillow e numpy). Rigenerate su macOS, però, le immagini **non sono identiche al pixel** a quelle committate: queste sono state disegnate con DejaVu Sans Mono (Linux), mentre su un Mac lo script usa Menlo, il primo font della sua lista. Testo e contenuto sono uguali. Le immagini committate sono le originali e gli expected valgono per quelle.

## Casi aperti

Nessuno.
