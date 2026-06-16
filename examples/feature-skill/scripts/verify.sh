#!/usr/bin/env bash
# Don't declare done until this is green. Set the three commands for your project.
set -euo pipefail
echo "== typecheck =="; eval "${TYPECHECK_CMD:-true}"
echo "== tests ==";     eval "${TEST_CMD:-true}"
echo "== smoke ==";     eval "${SMOKE_CMD:?set SMOKE_CMD to actually exercise the new code path}"
echo "all green — new path exercised"
