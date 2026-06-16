# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A local, single-user analysis prototype that mines the user's own real Claude Code ("cowork") session transcripts to discover **which engineering workflows work well vs badly per task type**, and emits ranked "skill candidates" worth codifying. It is the *intelligence half* of a larger capture pipeline; the core miner stops at `out/candidates.json` — the clean handoff. An **optional, gated** post-handoff stage (`src/skilldraft.ts`, `bun run draft`) turns a GO candidate into a **complete** skill under `out/skill_drafts/<slug>/`, split into a publishable `skill/` folder (SKILL.md + one `references/<stage>.md` per workflow step + authored `scripts/`) and a sibling, never-published `audit/` folder (mined `evidence.md`, code-rendered `observed.md` counts, `golden_cases.json`, `meta.json`, and the `bun test` self-eval harness). The published skill is authored Claude-skill-deep: **frontmatter** carries top-level `name`/`description`/`license` plus a `metadata:` block (`version`, `auto_generated`, `domain`, `role`, block-list `triggers`, `privacy_rules_version` — `license` from `DRAFT_SKILL_LICENSE`, default `MIT`; `triggers`/`domain`/`role` authored, or deterministic defaults of `[label]`/`software-engineering`/role-from-intervention); **SKILL.md** adds a `## Quick checklist` (the authored skill-level `checklist`, previously parsed-but-dropped), a `## Workflow` **markdown table** (`# | Step | What it does | Reference`), a `## Constraints` MUST-DO/MUST-NOT block, and a closing `## Reference guide` table — all guarded for emptiness, still **no mined counts / no "Observed" / no `×`**; and **each `references/<stage>.md`** is multi-section (How to do it / Examples ✅❌ / Edge cases / Common mistakes / Inputs / Ask-user / Web / Error handling / Script / Checklist), rendered by code from bounded, structured authored fields (kept small to survive the single `claude -p` call's lack of max-output control). The LLM **authors the most complete, correct workflow** for the task type from its own expertise; the mined evidence is used only to prioritise stages/errors and to feed the code-rendered "Observed" layer under `audit/`, so the published skill carries no provenance noise. There is **no REVIEW.md and no DRAFT banner**; the draft is a complete skill, edited by hand if needed. `applyOverclaimGuard` is slimmed to a pure honesty backstop: it no longer suppresses content (no weak⇒null, no zero-failure sentinel), and instead only polices *claims about observations* — it de-"recurring"s singleton friction and strips fabricated observation counts across all authored prose (now reaching the new per-stage depth fields — examples/steps_detail/edge_cases/common_mistakes/per-stage checklist — and the `constraints` block via `mapStepProse`/`mapConstraints`), and softens absolutes only in the observed-data narration (`success_patterns_summary` + `evidence_md`), never in the authored procedure/examples (those are expertise); the code-enforced safety gate (commit/push/PR/deploy/history only on explicit user request) is always present. Authored scripts are written to `skill/scripts/` (referenced, never executed) and a narrow code safety-scan flags — never gates — dangerous bodies into `audit/meta.json.flagged_scripts`. A deterministic, LLM-free path (`draftSkill`, also `--no-llm`) is the single source of truth for the file layout; the rich path lays it down first, then deletes only the prior `generated_stage_refs` manifest (human-added reference files survive) before overwriting, so the two never diverge. Opt-in `--yes`, never auto-published. A separate **cross-machine convergence** step (`src/converge.ts`, `bun run converge`) merges per-machine candidate exports to find org-wide workflows. Both are CLI-only and not wired into the default pipeline.

TypeScript on **Bun**, with effectively zero runtime deps (uses `bun:sqlite`). `implementation-plan.md` is the authoritative design spec; its terminology and schema match the code. `README.md` documents the operational commands.

## Runtime & tooling

- **Package manager + runtime is Bun** (`bun.lock`, `"type": "module"`, `bun:sqlite`, `Bun.spawn`, `import.meta.dir`). Pinned: Bun 1.3.14, `claude` CLI 2.1.175 (`DATA_FORMAT.md`).
- **Tests:** `bun test src` runs `src/merge.test.ts` (privacy gate, convergence, skill-draft gate). The cheaper, no-LLM verification path is still `bun run check` (structural DB invariants, exits non-zero on failure) — treat that as the primary smoke test; `bun test` covers the pure logic of the merged shell.
- **No lint/format/typecheck scripts.** `tsconfig.json` is `strict` + `noEmit`; `bunx tsc --noEmit` typechecks but `tsc` is not a declared dep and not wired as a script.
- macOS has no `timeout`; all process timeouts are implemented in TS via `AbortController`/`setTimeout` → `proc.kill()`.

## Common commands

```bash
bun install                                          # only dep: @types/bun

# Full pipeline (resumable). --mine also runs mine + report at the end.
bun run pipeline.ts --mine

# $0 smoke (no LLM): structure-only run, then validate invariants
bun run pipeline.ts --project <substr> --limit 3 --no-judge
bun run check                                         # or: bun run check --db other.db

# $0 inspection: print exactly what the judge will read (render is never persisted)
bun run dump-render --list
bun run dump-render --sample 3
bun run dump-render <sessionId>#<idx>

# Live judge, capped
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# Individual stages (most src/*.ts are runnable via if (import.meta.main))
bun run discover            # list discovered sessions
bun run classify <id|path>  # turn-classifier audit on one session
bun run mine                # re-cluster + rank from DB labels
bun run report              # regenerate out/report.md + out/candidates.json
bun run calibrate           # interactive trust gate (manual; not in auto pipeline)

# Post-handoff / cross-machine (CLI-only, NOT in the auto pipeline)
bun run draft --yes         # gated: candidates.json GO candidates -> out/skill_drafts/<slug>/{skill,audit}/ (LLM-authored complete skill; publish by copying skill/)
bun run draft --yes --no-llm  #   $0 deterministic-only drafts (never opens/creates a DB)
bun run draft --yes --top 1   #   cap the rich path to the top candidate (LLM-call budget)
bun run converge            # merge out/state/candidates_*.json -> out/convergence.{md,json}
bun test src                # pure-logic tests for the merged shell (merge.test.ts)
```

Key `pipeline.ts` flags: `--project <substr>` `--limit N` `--since <ISO>` `--resume` `--classify-llm` `--max-episodes N` `--max-cost <USD>` `--yes` `--no-judge` `--db <path>` `--mine` `--runner ccs|claude` (default `ccs`) `--ccs-profile <name>` (default `my-api`) `--business "<context>"` (runs the late business sidecar at report time; needs `--mine`). The per-machine convergence export is tagged with a machine id from `CWBH_MACHINE_ID` (falls back to `os.hostname()`).

The **privacy gate is default-on** (`src/privacy.ts`, see `POLICY.md`): opt-out sessions are dropped before any content is read, and every LLM egress is redacted (credentials dropped, PII masked). Each run writes `out/state/audit.json` (sessions read vs opted-out, redaction counts).

## Auth / how the LLM is called

There is **no Anthropic SDK and no raw HTTP**. Every LLM call shells out to the real `claude` CLI in headless mode (`claude -p --output-format json`, prompt on stdin, parse the `.result` field). The CLI must be on `PATH`.

- **`src/runner.ts` is the only LLM-routing layer.** Default `--runner ccs` runs `ccs env <profile>` and merges `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` into the subprocess env (`runnerEnv()`). It does **not** invoke `ccs` as the model wrapper (that pollutes stdout / rejects `--output-format json`). `--runner claude` uses ambient env / the plain `claude` login instead, and needs no `ccs`.
- `runClaudeText()` in `src/runner.ts` is the **shared headless-CLI call** (spawn + runner env + timeout + JSON-envelope unwrap) used by the three auxiliary call sites: the turn-classifier pass (`src/classify.ts`), the mine clustering pass (`src/mine.ts`), and the business sidecar (`src/sidecar.ts`). The **judge** (`src/judge.ts`) keeps its own spawn because it layers retry logic on top and is the cached critical path — consolidating it onto `runClaudeText` is a safe follow-up. A `runApi()` stub is the intended seam for a future API path — it currently throws.

## Architecture: pipeline stages

Orchestrator is `pipeline.ts` (`main()` loop). Per session it runs a fault-isolated **structure phase** (a bad session is skipped, not fatal) then a **judge phase**. Mine + report only run with `--mine`.

1. **Discover** (`src/discover.ts`) — walk `~/.claude/projects/*/`, excluding subagent forks, agent-mode buckets, and this analyzer's own project. Worker opt-out sessions are then dropped (`filterExcluded`, `src/privacy.ts`) before any content is read.
2. **Classify turns** (`src/classify.ts` + `prompts/classify.md`) — assign one role per human turn (`new_task`/`correction`/`continuation`/…). Heuristics first; LLM only for ambiguous turns (`--classify-llm`).
3. **Segment episodes** (`src/segment.ts`) — group turns into **episodes**: a maximal run from one `new_task` to the next, absorbing its corrections + all assistant/tool/system events. Computes `contentHash`. This is the linchpin: corrections stay *inside* the episode so the outcome is judgeable.
4. **Attach subagents** (`src/subagents.ts`) — link `<sessionId>/subagents/*.jsonl` to parent `Agent` tool calls; keep a compact summary only, never the full transcript.
5. **Signals + features** (`src/signals.ts`) — `computeSignalsAndFeatures(ep)` mutates `ep.signals` (directional/weighted evidence) and `ep.features` in place.
6. **Render** (`src/render.ts`) — episode → compact ≤`RENDER_CHAR_CAP` (12k) text the judge reads; tool outputs dropped, images as `[image attached]`, middle elided to keep start+end. The rendered text is then passed through the redaction gate (`sanitizeRendered`, `src/privacy.ts`) before it leaves the machine. Redaction runs *after* the char cap, and the privacy-rules version is folded into the judge cache key via `getJudgePromptHash` (bump `PRIVACY_RULES_VERSION` in `src/types.ts` to force a re-judge when rules change).
7. **Judge** (`src/judge.ts` + `prompts/judge.md`) — render → validated `JudgeLabel`. Default model `claude-opus-4-8`; 120s timeout; exactly one retry on malformed JSON.
8. **Store** (`src/db.ts`) — idempotent upserts of session/turns/episodes/features/evidence/labels.
9. **Mine** (`src/mine.ts`) — DB labels → `TaskCluster[]` + ranked candidates. Clustering = normalize `task_type` then one LLM grouping pass (model `claude-sonnet-4-6`). Ranking uses **transparent component columns** (frequency, success_rate, median_friction, has_stable_pattern, risk_flags, est_effort) — deliberately no composite score.
10. **Report** (`src/report.ts`) — write `out/report.md` (exemplar-driven, good-vs-bad contrast) + `out/candidates.json` (machine-readable handoff).

## Cross-cutting structure — respect these single sources of truth

- **`src/types.ts`** is the shared contract. Every module imports boundary types from here ("Do not redefine these elsewhere"). It also holds versioned constants `LABEL_SCHEMA_VERSION` and `RENDER_CHAR_CAP`.
- **`src/db.ts`** is the only DB-access layer — no raw SQL elsewhere. DDL lives in **`src/schema.sql`** (loaded by an idempotent `migrate()`; every table `IF NOT EXISTS`). DB is `analysis.db` (bun:sqlite, WAL, gitignored); default path `DEFAULT_DB_PATH`, override with `--db`.
- **`src/runner.ts`** is the only LLM-routing layer (see Auth above).
- **`src/util.ts`** holds shared transcript primitives. Human-turn detection is non-trivial (a `user` event may be a tool result or harness-injected) and is single-sourced here (`isHumanTurn`, `extractUserText`, `countImages`, `readEvents`, `sha256`, `median`) — reused by both classify and render.

## Conventions that bite if ignored

- **Resume/caching is a multi-part cache key.** An episode is skipped only if `contentHash` + `judgePromptHash` + `labelSchemaVersion` + `model` + `cliVersion` all match (`isJudged()` / `CacheKey` in `db.ts`). Re-runs are cheap; cost scales with *uncached* episodes only.
- **Editing `prompts/judge.md` invalidates the judge cache** (its hash is in the key) — that's intended. If you change the judge's *output schema*, also bump `LABEL_SCHEMA_VERSION` in `src/types.ts`.
- **Prompts must emit JSON only.** Adapters parse `.result` then extract the first balanced object/array; prose or markdown fences break parsing. There is no templating engine — the `.md` is read verbatim and the input JSON is appended as a labeled section. Note `src/mine.ts` builds its clustering prompt inline (template literal), not in `prompts/`.
- **Model IDs are scattered, not centralized:** judge `claude-opus-4-8` (`judge.ts`), mine `claude-sonnet-4-6` (`mine.ts`), classify passes no `--model`. Changing the judge model invalidates the cache.
- **Mining must never throw on LLM failure** — `llmGroupTaskTypes` returns `null` and falls back to identity (string-normalization) clustering. Surface timeouts via `MINE_LLM_TIMEOUT_MS`, don't let a slow call abort the report.
- **The judge loop is intentionally serial** (no fan-out) — that serial execution is the only rate-limit throttle. Parallelizing requires adding explicit concurrency limiting + rate-limit handling.
- **Cost gates:** a fresh run prompts for confirmation above ~$5 estimated and **fails closed on non-TTY** (use `--yes`); `--max-cost` and `--max-episodes` are runtime ceilings; a consecutive-judge-error circuit breaker stops a broken CLI from burning the whole run.

## Input data format (brief)

Raw transcripts are newline-delimited JSON (`.jsonl`), one event per line, at `~/.claude/projects/<encodedProjectDir>/<sessionId>.jsonl` (cwd with `/`→`-`). Subagent forks live under `<sessionId>/subagents/agent-<agentId>.jsonl` with a sibling `.meta.json`. Events have a top-level `type` (`user`/`assistant`/`system`/`pr-link`/…) plus `uuid`, `parentUuid`, `timestamp`, `isSidechain`, `isMeta`; `system` events carry signals by `subtype` (e.g. `api_error`, `compact_boundary`); `pr-link` is a strong positive signal. Full details in `DATA_FORMAT.md`.
