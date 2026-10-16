# @utexo/wdk-wallet-rgb `2.0.3`

> Estratto dai `.d.ts` (`types/src/*.d.ts`), dal README e da `src/wallet-account-rgb.js` del pacchetto installato, più quello che lo spike 2 ha verificato (`spikes/wdk/04-fund-issue.ts`, `04b-send-dusd.ts`, `08-full-single.ts`).
> **Perché 2.0.3 e non 2.0.4:** il tag `v2.0.4` esiste su GitHub ma non è su npm. Inoltre è riscritto per il runtime **Bare** (`src/bare-binding.js` importa `bare-fs` e `@utexo/rgb-lib-bare` anche nell'export per Node) e dipende da un fork git personale di `rgb-sdk`. La 2.0.3 usa `@utexo/rgb-sdk` `1.0.3` → `@utexo/rgb-lib` `0.3.0-beta.8` (binding Node).

## Installazione: attenzione
```json
"@utexo/wdk-wallet-rgb": "2.0.3",
"@utexo/rgb-lib-darwin-arm64": "0.3.0-beta.8"
```
- `@utexo/rgb-lib` dichiara il binario di piattaforma come `optionalDependency`. npm **lo salta in silenzio** se la build fallisce, e a runtime compare `Cannot find module '@utexo/rgb-lib-darwin-arm64'`.
- Il pacchetto di piattaforma **si compila con node-gyp** (wrapper SWIG). **Su Node 24 non compila** (`no member named 'Holder' in 'v8::FunctionCallbackInfo<v8::Value>'`). Su **Node 22.23.3** compila. Il binario è legato all'ABI di Node: **tutto il processo che usa questo modulo deve girare su Node 22**.
- Va dichiarato esplicitamente in `package.json` alla stessa versione di `@utexo/rgb-lib`.

## Costruttore
```js
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
const wm = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  indexerUrl: 'tcp://127.0.0.1:50001',
  transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
  dataDir: '/abs/path/dave/onchain'      // diversa dalla dataDir del nodo Lightning
})
const dw = await wm.getAccount()           // indice 0
```
Lo **stesso seed** del nodo Lightning va bene: indirizzi diversi (BIP-86 dal seed completo contro i primi 32 byte del seed per il nodo VLS), `rgb-lib` separati, nessun conflitto sugli UTXO (verificato).

## Metodi usati
| Metodo | Sync/async | Uso verificato |
|---|---|---|
| `getAddress()` | sync | indirizzo `bcrt1p…` per finanziarla |
| `createUtxos({ upTo, num, size, feeRate })` | **async** → numero di UTXO creati | `{ upTo: false, num: 6, size: 32_000, feeRate: 2 }` |
| `issueAssetNia({ ticker, name, precision, amounts })` | sync | `{ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] }` → `{ assetId: 'rgb:…', ticker, precision, issuedSupply, balance: {settled,future,spendable} }` |
| `transfer({ recipient, token, amount, feeRate, minConfirmations })` | async → `{ hash: txid, fee }` | `recipient` = invoice RGB `rgb:…` creato dal ricevente; `token` = assetId. Stampa su stdout `sendBegin params {…}` (log di debug del pacchetto). |
| `refreshWallet()` | sync | dopo ogni invio, vedi sotto |
| `getTokenBalance(assetId)` | async → `bigint` | |
| `listTransfers(assetId)` | sync | `[{ idx, status: 'Settled'|…, kind: 'Issuance'|'Send', requestedAssignment, txid }]` |
| `getRgbWallet().getAssetBalance(assetId)` | sync | `{ settled, future, spendable }` |

## Sequenza di invio che funziona (blinded, senza `donation`)
1. Ricevente (nodo Lightning): `createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })`.
2. Mittente: `transfer({ recipient: invoice, token: assetId, amount, feeRate: 2, minConfirmations: 1 })`.
3. Ricevente `refreshTransfers` (ACK della consignment) → mittente `refreshWallet()` (broadcast) → mina 1 blocco → refresh di entrambi → `settled`.

Fino al passo 3 il resto del mittente è bloccato: un secondo `transfer` dà `InsufficientAssignments { fungible: 0 }`. Gli invii vanno quindi fatti uno alla volta, un blocco ciascuno.

## Trappole
- `wm.dispose()` lancia `Invalid checksum` (prova a ricostruire una chiave da una tpub di regtest): va avvolto in `try {} catch {}`.
- Dopo l'uso il processo a volte esce con `Can't read exit code from process` (terminazione del codice nativo): da tenere d'occhio nell'agente.
