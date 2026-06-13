# Cowork Workflow Miner

Labels good/bad workflows from your own real Claude Code sessions and produces a
ranked report of skill/script/SOP candidates. Local prototype of the mining
intelligence gate (Cổng Go/Kill 1) — stops **before** drafting skills.

See `implementation-plan.md` for the full design and `DATA_FORMAT.md` for the
verified transcript format.

## Pipeline

```
discover → classify (turn roles) → segment (episodes) → signals + subagents
   → render → judge (claude -p) → SQLite ─┬→ calibrate (trust gate)
                                          └→ mine (cluster + good/bad) → report.md + candidates.json
```

## Setup

```bash
bun install            # only dep: @types/bun (uses bun:sqlite)
```

Requires the `claude` CLI on PATH (used headless as the judge: `claude -p --output-format json`).
By default the LLM calls route through the **ccs `my-api` profile** — the pipeline injects
that profile's env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from `ccs env my-api`) into
the `claude` subprocess. Pass `--runner claude` to use the plain `claude` login instead, or
`--ccs-profile <name>` to pick a different ccs profile. (`ccs` is only required for the default
`--runner ccs`; `--runner claude` has no such dependency.)

## Run

```bash
# 1. Eyeball the classifier on one session (audit tool)
bun run src/classify.ts <sessionId|path>

# 2. List discovered real sessions
bun run src/discover.ts

# 3. Smoke (structure only, no LLM calls)
bun run pipeline.ts --project auto-skills --limit 3 --no-judge

# 3b. Validate the structure for $0 — counts vs baseline + hard invariants (PASS/FAIL)
#     Run after any --no-judge pass; exits non-zero if an invariant breaks.
bun run check                       # or: bun run check --db other.db

# 3c. Eyeball the render for $0 — see EXACTLY what the judge will read.
#     The render is never persisted, so this re-runs structure and prints it.
bun run dump-render --list                  # metadata table: chars/cap, elided?, subagents?
bun run dump-render --sample 3              # 3 representative episodes (longest, elided, subagents)
bun run dump-render <sessionId>#<idx>       # one specific episode, full body
bun run dump-render --session <id|prefix>   # every episode in a session

# 4. Smoke with the live judge, capped
#    --project matches a substring of the session's recorded cwd basename
#    (e.g. the usth project records as "tennis_tracking_system").
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# 5. Full run (resumable; judge is cache-keyed — re-running skips judged episodes)
bun run pipeline.ts --mine          # --mine also runs mine + report at the end

# 6. Trust gate: stratified human spot-check + auto cross-check
bun run src/calibrate.ts            # interactive; --non-interactive to just sample
bun run src/calibrate.ts --non-interactive

# 7. (Re)generate the report any time
bun run src/mine.ts
bun run src/report.ts               # writes out/report.md + out/candidates.json
```

### pipeline.ts flags
`--project <substr>` · `--limit N` (sessions) · `--since <ISO>` · `--resume` ·
`--classify-llm` (LLM pass on ambiguous turn boundaries) · `--max-episodes N`
(cap judge calls) · `--max-cost <USD>` (hard spend ceiling) · `--yes` (skip the
est-cost confirmation) · `--no-judge` · `--db <path>` · `--mine` ·
`--runner ccs|claude` (LLM routing, default `ccs`) · `--ccs-profile <name>` (default `my-api`)

Cost safety: a fresh judge run above ~$5 estimated prompts for confirmation (fails
closed on non-TTY — pass `--yes` for automation). `--max-cost` caps cumulative spend,
and 5 consecutive judge failures trip a circuit breaker so a broken CLI can't burn the
whole budget. Numeric flags reject non-numeric values rather than silently unbounding.

## Cost / time note

The judge runs `claude -p` **serially**, ~one call per episode (corpus ≈ 329
episodes). Each call is a real metered request. Use `--max-episodes` /
`--project` / `--limit` to bound a run; the multi-part cache key
(content + prompt + schema + model + cli) makes the full run resumable — nothing
is re-judged unless its content or the rubric changes.

## Outputs

- `analysis.db` (gitignored) — sessions, turns, episodes, features, evidence, labels, calibration, clusters.
- `out/report.md` — per-cluster good-vs-bad workflow contrast + exemplar episodes.
- `out/candidates.json` — ranked candidates (machine-readable handoff for the skill-draft phase).

## Module map

| File | Stage |
|---|---|
| `src/discover.ts` | enumerate real sessions (excludes forks, agent-mode, the analyzer's own project) |
| `src/classify.ts` + `prompts/classify.md` | turn-role classifier (P0) |
| `src/segment.ts` | group turns into episodes (P0) |
| `src/signals.ts` | evidence signals + numeric features |
| `src/subagents.ts` | compact subagent summaries → parent episode |
| `src/render.ts` | compact episode view for the judge (≤12k chars) |
| `src/judge.ts` + `prompts/judge.md` | bias-anchored LLM judge + cache key (P0) |
| `src/calibrate.ts` | stratified calibration + self-consistency (P0 trust gate) |
| `src/mine.ts` | cluster + good/bad contrast + component ranking |
| `src/report.ts` | exemplar-driven report + candidates.json |
| `src/db.ts` + `src/schema.sql` | SQLite persistence |
| `src/types.ts` / `src/util.ts` | shared contract + helpers |
| `pipeline.ts` | orchestrator (resumable) |
