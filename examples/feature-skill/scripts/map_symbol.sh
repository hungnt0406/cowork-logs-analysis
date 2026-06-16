#!/usr/bin/env bash
# map_symbol.sh — find every definition, implementer, and call site of a symbol
# BEFORE editing, so you never miss a second implementation (a common feature bug).
# Usage: ./map_symbol.sh <symbol> [path]
set -euo pipefail
SYMBOL="${1:?usage: map_symbol.sh <symbol> [path]}"
ROOT="${2:-.}"

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) not found; using grep -rn" >&2
  grep -rn --exclude-dir=.git -w "$SYMBOL" "$ROOT" || true
  exit 0
fi

echo "== Likely definitions / implementations of '$SYMBOL' =="
rg -n --no-heading -w "$SYMBOL" "$ROOT" \
  | rg -e 'class|interface|struct|def |func |fn |function|type |implements|extends' \
  || echo "(no keyword match; scan all references below)"

echo
echo "== All references — review EVERY file before fixing scope =="
rg -n --no-heading -w "$SYMBOL" "$ROOT" || echo "(none)"

echo
echo "== Distinct files touching '$SYMBOL' =="
rg -l -w "$SYMBOL" "$ROOT" || echo "(none)"
