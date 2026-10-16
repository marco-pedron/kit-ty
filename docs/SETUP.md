# Setup del repository (PM, venerdì 10:00-10:45)

Tempo stimato: 30-45 minuti. Servono `git`, `gh` (GitHub CLI, autenticato con `gh auth login`), `rsync`, Node ≥ 22.17 e il vecchio repository sul tuo computer.

## 1. Crea il repository
```sh
cd ~/code                                  # la cartella dove tieni i progetti
gh repo create kit-ty --private --clone    # crea su GitHub e clona in ~/code/kit-ty
cd kit-ty
```
(In alternativa: crea `kit-ty` privato dal sito di GitHub e clonalo.)

## 2. Metti dentro il pacchetto di partenza
Estrai lo zip che ti ho dato **dentro** `kit-ty`, in modo che `CLAUDE.md` stia nella radice:
```sh
unzip ~/Downloads/kit-ty-starter.zip -d .
ls            # devi vedere: CLAUDE.md  README.md  docs  scripts  .github  .gitignore
```

## 3. Importa riferimenti e codice dal vecchio progetto
```sh
bash scripts/import-legacy.sh ~/code/<cartella-del-vecchio-repo>
```
Lo script copia `QVAC.md` e `rln-openapi.yaml` in `docs/vendor/`, e il codice riusabile (ledger, client RLN, infra Docker, rail RGB, AI, configurazioni) in `_legacy/`, escludendo `node_modules`, `.env`, dati Docker e modelli. Alla fine controlla che la riga "Controllo segreti" dica **nessuno**.

## 4. Controlla e pubblica
```sh
git status                                 # niente .env, niente infra/data, niente .gguf
git add -A
git commit -m "docs: kit+ty starter pack and legacy reference"
git push -u origin main
```

## 5. Aggiungi i compagni di squadra
Per ognuno (con il loro username GitHub):
```sh
gh api -X PUT repos/{owner}/kit-ty/collaborators/<username> -f permission=push
```
`{owner}` viene riempito da `gh` con il proprietario del repo. In alternativa: Settings → Collaborators sul sito.

## 6. Avvisa il team (incolla in chat)
> Repo: github.com/<owner>/kit-ty. Leggete `docs/SPEC.md` (15 minuti) e `docs/PLAN.md`.
> Stream: A = <nome>, B = <nome>, C = <nome> (PM).
> Adesso: B parte con lo spike nel vecchio repo (`docs/prompts/00-spike-lightning.md`); A e C fanno la sessione contratto sulla macchina di A (`docs/prompts/01-contract.md`).
> Gate alle 13:30.

## 7. Ogni dev, sulla propria macchina
```sh
git clone git@github.com:<owner>/kit-ty.git && cd kit-ty
corepack enable
claude                                     # Claude Code nella radice del repo
```
Poi incolla il prompt giusto:
- **ora:** B → `docs/prompts/00-spike-lightning.md` (nel **vecchio** repo); A con C → `docs/prompts/01-contract.md`;
- **dopo il gate:** ognuno incolla `docs/prompts/stream-<a|b|c>.md` seguito da "Task <ID>".

## 8. Dopo la sessione contratto (circa 13:15)
- Mergia la PR `k0-contract` e verifica che la CI su GitHub sia verde.
- (Facoltativo, 1 minuto) Settings → Branches → regola su `main`: "Require a pull request" e "Require status checks: check". Evita push diretti per errore.

## 9. Domenica prima del submit
```sh
git rm -r _legacy && git commit -m "chore: remove legacy reference" && git push
```
