#!/usr/bin/env sh
# start.sh — one-command entry point. Installs Bun if missing, then launches the
# interactive wizard (run.ts), which preflights deps, lists sessions, lets you pick,
# runs the pipeline, and optionally drafts skills.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found — installing from https://bun.sh …"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

exec bun run "$DIR/run.ts" "$@"
