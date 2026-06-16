#!/usr/bin/env sh
# install.sh — one-line web installer for the Cowork Workflow Miner (macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hungnt0406/cowork-logs-analysis/main/install.sh | bash
#
# What it does: downloads the latest GitHub Release (falls back to the main branch
# tarball when no release exists), installs Bun if missing, runs `bun install`, and
# prints how to launch the interactive wizard. Needs only curl-or-wget + tar; no git.
#
# Env overrides:
#   DIR=<path>      install location          (default: ./cowork-logs-analysis)
#   BRANCH=<name>   fallback branch            (default: main)
set -eu

REPO="hungnt0406/cowork-logs-analysis"
DIR="${DIR:-cowork-logs-analysis}"
BRANCH="${BRANCH:-main}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Pick a downloader (curl preferred, wget fallback).
if command -v curl >/dev/null 2>&1; then
  to_file() { curl -fsSL "$1" -o "$2"; }
  to_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  to_file() { wget -qO "$2" "$1"; }
  to_stdout() { wget -qO- "$1"; }
else
  die "need curl or wget on PATH"
fi

if [ -e "$DIR" ]; then
  die "'$DIR' already exists — remove it or set DIR=<other path>"
fi

# Resolve the latest release tag; fall back to the branch tarball when none exists.
say "Resolving latest release of $REPO ..."
TAG="$(to_stdout "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | grep -m1 '"tag_name"' \
  | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/' || true)"

if [ -n "${TAG:-}" ]; then
  URL="https://codeload.github.com/$REPO/tar.gz/refs/tags/$TAG"
  say "Latest release: $TAG"
else
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  say "No release found — using branch '$BRANCH'"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading $URL ..."
to_file "$URL" "$TMP/src.tar.gz" || die "download failed"

mkdir -p "$DIR"
# GitHub tarballs nest everything under a single <repo>-<ref>/ dir — strip it.
tar -xzf "$TMP/src.tar.gz" -C "$DIR" --strip-components=1 || die "extract failed"
say "Extracted to ./$DIR"

# Install Bun if missing (mirrors start.sh).
if ! command -v bun >/dev/null 2>&1; then
  say "Bun not found — installing from https://bun.sh ..."
  to_stdout https://bun.sh/install | bash
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  PATH="$BUN_INSTALL/bin:$PATH"
fi

say "Installing dependencies ..."
( cd "$DIR" && bun install )

say ""
say "Done. Launch the interactive wizard:"
say "  cd $DIR && ./start.sh"
say ""
say "(The wizard preflights deps, lists your sessions, runs the pipeline, and"
say " optionally drafts skills. The \`--no-judge\` smoke path costs \$0.)"
