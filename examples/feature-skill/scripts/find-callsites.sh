#!/usr/bin/env bash
# Map every call site / implementer of a symbol before changing it.
set -euo pipefail
sym="${1:?usage: find-callsites.sh <symbol> [path]}"
path="${2:-.}"
inc=(--include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.go' --include='*.rs')
echo "== definitions & implementers =="
grep -rEn "(def|class|func|function|interface|impl|implements).*${sym}" "$path" "${inc[@]}" || true
echo "== references =="
grep -rFn "$sym" "$path" "${inc[@]}" || true
