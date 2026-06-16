#!/usr/bin/env bash
# verify_feature.sh — run typecheck + tests so a feature is verified, not just written.
# Auto-detects the toolchain. Exits non-zero if any step fails.
set -uo pipefail
fail=0
run() { echo "+ $*"; "$@" || fail=1; }

if [ -f package.json ]; then
  pm=npm; [ -f pnpm-lock.yaml ] && pm=pnpm; [ -f yarn.lock ] && pm=yarn; [ -f bun.lock ] && pm=bun
  grep -q '"typecheck"' package.json && run "$pm" run typecheck
  grep -q '"test"' package.json && run "$pm" test
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  command -v mypy >/dev/null 2>&1 && run mypy .
  command -v ruff >/dev/null 2>&1 && run ruff check .
  command -v pytest >/dev/null 2>&1 && run pytest -q
elif [ -f go.mod ]; then
  run go vet ./...; run go test ./...
elif [ -f Cargo.toml ]; then
  run cargo check; run cargo test
else
  echo "No known toolchain detected; run this project's typecheck + tests manually." >&2
fi

if [ "$fail" -eq 0 ]; then echo "VERIFY: all checks passed"; else echo "VERIFY: failures above — fix before declaring done"; fi
exit "$fail"
