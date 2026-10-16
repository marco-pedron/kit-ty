#!/usr/bin/env bash
# Copia dal vecchio progetto i riferimenti API e il codice riusabile.
# Uso: bash scripts/import-legacy.sh /percorso/del/vecchio/repo
set -euo pipefail

OLD="${1:?Indica il percorso del vecchio repo, es. bash scripts/import-legacy.sh ~/code/settleup}"
OLD="$(cd "$OLD" && pwd)"
DEST="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$OLD/.git" ] || { echo "Non trovo un repo git in $OLD"; exit 1; }
command -v rsync >/dev/null || { echo "Serve rsync (su macOS c'è già; su Linux: sudo apt install rsync)"; exit 1; }

EXCL=(--exclude node_modules --exclude dist --exclude coverage --exclude '*.gguf'
      --exclude '.env' --exclude '*.log' --exclude '/infra/data' --exclude '.DS_Store')

mkdir -p "$DEST/_legacy" "$DEST/docs/vendor"

echo "Riferimenti API → docs/vendor/"
for f in docs/vendor/QVAC.md docs/vendor/rln-openapi.yaml; do
  if [ -f "$OLD/$f" ]; then cp "$OLD/$f" "$DEST/$f"; echo "  ✓ $f"; else echo "  ✗ $f MANCANTE: copialo a mano"; fi
done

echo "Codice di riferimento → _legacy/"
copy() {
  if [ -e "$OLD/$1" ]; then
    mkdir -p "$DEST/_legacy/$(dirname "$1")"
    rsync -a "${EXCL[@]}" "$OLD/$1" "$DEST/_legacy/$(dirname "$1")/"
    echo "  ✓ $1"
  else
    echo "  – $1 (non trovato, salto)"
  fi
}
for p in \
  packages/ledger packages/shared packages/rgb-client \
  apps/server/src/rgb apps/server/src/ai apps/server/src/dev-fakes apps/server/package.json \
  apps/web \
  infra \
  scripts \
  package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json \
  eslint.config.js eslint.config.mjs vitest.config.ts vitest.workspace.ts .prettierrc .prettierrc.json \
  .env.example docs/STATUS.md
do copy "$p"; done

echo
echo "Controllo segreti in _legacy/ (deve essere vuoto):"
grep -rIlE '(MNEMONIC|PASSWORD)=[^[:space:]]+' "$DEST/_legacy" | grep -v '\.env\.example$' || echo "  nessuno"
echo
du -sh "$DEST/_legacy"
echo "Fatto. Controlla 'git status' prima del commit."
