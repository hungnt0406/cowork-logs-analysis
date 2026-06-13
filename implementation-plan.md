# Plan: Cowork Workflow Miner — label good/bad workflows from sessions → ranked skill candidates

> **v2 — revised after reading the real logs.** Segmentation is the linchpin and is now a dedicated turn-role classification stage upstream of episode grouping. "Deterministic outcome signals" are reframed as **evidence signals** (directional, weighted, not ground truth). "No Tier 1" is replaced by a **lightweight stratified calibration** — you cannot calibrate a judge against zero ground truth.

## Context

You have a working capture pipeline in `auto-skills/cowork-mem-pilot/` (transcript → compact view via `extract-conversation.ts` → LLM session summary → claude-mem SQLite via `insert-summary.ts`). Those summaries describe **what happened**, not **whether the workflow was good or bad**, the **shape of the workflow**, or the **friction** along the way. Your `plan.md` flags this "intelligence half" — mining real sessions to find which workflows are worth codifying — as the project's make-or-break gate (Cổng Go/Kill 1).

This build is the **local prototype of that mining intelligence**, over your own ~113 real sessions. It classifies each human turn by role, groups turns into task **episodes**, attaches **evidence signals**, has an LLM-judge label each episode (outcome + workflow pattern + friction), clusters by task type, and produces a **"good vs bad workflow per task" report + ranked skill/script/SOP candidates**. It stops before drafting skills (matches your Go/Kill gate).

**Decisions locked:** unit = episode/task; judge = headless `claude -p --output-format json` (swappable adapter); scope = through mining report. Runtime = TS/Bun 1.3.14. Source of truth = raw transcripts (claude-mem DB is absent here); outputs to a standalone SQLite. Home = `cowork-logs-analysis/`.

## Priorities (sequence of implementation)

- **P0 — non-negotiable, build & validate first:** turn-role classifier + episode grouping (§Stage 1–2); calibration + bias-anchored judge rubric (§Calibration). These determine whether anyone trusts the output.
- **P1 — cheap, fold in from the start:** image-aware turn predicate, exact tool-result exclusion, full cache key (§Stage 1, §Schema).
- **Build-time (schema-shaping, not deferrable):** evidence-signal model (§Evidence signals); component-based ranking, no composite score (§Ranking).
- **Decide by cost/value:** subagent compaction into parent episodes (§Stage 4).

## Data facts (verified against the logs)

- 113 real sessions after excluding nested subagent forks and observer/agent-mode buckets. Concentrated in `usth-tennis-tracking-system` (74), `VinAI-A20-App-143` (27), `auto-skills` (7).
- ~825 human turns; **260 are ≤40 chars** ("continue", "push it", corrections) → naive per-turn = massive over-split. Raw paste/ack-merged segmentation already produced ~623 episodes; still over-fragmented. **Grouping by turn role is required.**
- **113 mixed-media (text+image) user turns** — UI/bug-review tasks. Must not be dropped.
- `pr-link` appears only **16 times** → strong-but-rare positive; absence ≠ failure.
- Subagent transcripts live in `.../<sessionId>/subagents/*.jsonl`, linked by `agentId` / `fork-context-ref`. 101 `Agent` calls in the corpus → delegation is a real workflow choice.
- Event model: one JSON/line. Threaded by `parentUuid`; `isSidechain:true` = subagent. Free signal events: `system/{api_error,compact_boundary,turn_duration}`, `pr-link`, `permission-mode`/`mode`, `queue-operation`, `ai-title`/`last-prompt`, assistant `message.usage`.

## Architecture

```
discover → extract+classify turns → group into episodes → evidence signals ┐
                                          ├ subagent compaction ────────────┤
                                          └ render (compact, images→[image]) ┴→ judge(claude -p) → SQLite
                                                                                      ↓
                                            calibrate (stratified) ── mine (cluster + good/bad contrast) → report.md + candidates.json
```

## File layout (`cowork-logs-analysis/`)

```
cowork-logs-analysis/
  implementation-plan.md   # this file
  pipeline.ts              # orchestrator (resumable)
  src/
    discover.ts    # enumerate real sessions; exclude */subagents/*; link forks
    classify.ts    # turn-role classifier: new_task|correction|continuation|approval|interruption|paste
    segment.ts     # group classified turns into episodes (new_task → next new_task)
    signals.ts     # evidence signals (directional/weighted) + numeric features
    subagents.ts   # load + compact subagent transcripts, join to parent episode
    render.ts      # compact episode view; images rendered as [image attached]
    judge.ts       # adapter: runClaudeP() default | runApi() stub; validate JSON; retry; full cache key
    db.ts          # bun:sqlite open + migrate + upsert; cache check
    schema.sql     # DDL
    mine.ts        # cluster task_type; good/bad workflow contrast; ranking components
    report.ts      # out/report.md (exemplar-driven) + out/candidates.json
    calibrate.ts   # stratified human spot-check + judge self-consistency
  prompts/{judge.md, classify.md}
  analysis.db      # gitignored
  out/{report.md, candidates.json}
```

Reuse: `render.ts` lifts the elision strategy from `auto-skills/cowork-mem-pilot/extract-conversation.ts` (keep user prompts, assistant text, tool name + truncated input; drop tool outputs/file bodies), scoped to one episode.

## Stage 1 — turn extraction + role classification (`classify.ts`) — P0

**Human-turn predicate (image-aware, exact tool-result exclusion).** A `type:"user"` event is a human turn iff:
- it is **not** a tool result: neither a top-level `toolUseResult` field **nor** any `message.content[].type === "tool_result"`; and
- `message.content` has a text part (string, or array with ≥1 `type:"text"`); **mixed text+image is accepted** — extract the text, note `n_images`; and
- the text is non-empty and not a `<…>` harness/slash envelope.
- Image-**only** turns (no text) are kept as `continuation`/evidence attached to the current episode, never as a boundary.

**Turn roles** (assigned per human turn):

| Role | Detection |
|---|---|
| `interruption` | contains `[Request interrupted by user]` |
| `approval` | short + ack pattern (`ok`, `yes`, `go`, `continue`, `lgtm`, `perfect`, `do it`) |
| `paste` | log/listing/output with no request cue (shell-prompt echo, `rsync:`/`xfer#`, tracebacks, `reset by peer`, file-listings) |
| `correction` | starts with negation/fix cue (`no`, `actually`, `instead`, `that's wrong`, `revert`, `still …`) |
| `continuation` | image-only, or low-content follow-up that isn't a new ask |
| `new_task` | everything else — a fresh request/question |

The hard case is **`new_task` vs `correction`/`continuation`** — not separable by text alone ("no, use 640×368" vs "now train v5" are both short imperatives). Resolve with a hybrid:
1. Heuristics decide the easy roles (interruption/approval/paste, and clear cues).
2. For ambiguous turns, use **signals**: time gap since prev turn, whether the prior episode reached completion (final summary / PR / "done"), and **file/topic overlap** with the in-progress episode (high overlap → correction/continuation; low + gap → new_task).
3. Optional **one cheap `claude -p` batch pass** over only the still-ambiguous boundaries (given the prior task summary + the turn) — gated behind a `--classify-llm` flag.

Role labels are persisted per turn (`turns` table) so the classifier itself can be eyeballed and tuned, and they **double as episode features** (`n_corrections`, `n_interruptions`, `n_approvals`).

## Stage 2 — episode grouping (`segment.ts`) — P0

An **episode** = a maximal run beginning at a `new_task` turn and absorbing all following `correction`/`continuation`/`approval`/`interruption`/`paste` turns and all assistant/tool/subagent activity, until the next `new_task`. Corrections stay *inside* the episode — that's what makes the outcome judgeable (the episode is the whole task attempt, rework included). Fallback: a session with no `new_task` boundary becomes one episode.

## Stage 3 — evidence signals (`signals.ts`) — build-time

Not outcome labels — **directional, weighted evidence** the judge weighs and the cross-check uses. Each stored as `{signal, direction(+/-/0), weight(strong/weak), value, reason}`:

| Signal | Dir / weight | Source |
|---|---|---|
| `created_pr` | + strong | `pr-link` event / `gh pr create` |
| `explicit_user_approval` | + strong | approval turn near episode end / praise |
| `explicit_user_rejection` | − strong | correction with `wrong/revert/no` |
| `abandoned_mid_edit` | − strong | last activity is an unresolved edit/tool, session ends |
| `test_passed` / `test_failed` | ± medium | test/build Bash + `toolUseResult` |
| `n_corrections` (grows) | − weak | turn roles |
| `api_errors` | 0/− weak | `system/api_error` (often transient infra) |
| `compact_boundary` | − weak | `system/compact_boundary` (context overflow) |
| `read_before_edit` | + weak | Read precedes Edit on same file |
| numeric features | n/a | tool_sequence, n_files_read/edited, n_images, duration_s, idle_s, tokens, used_subagents |

## Stage 4 — subagent compaction (`subagents.ts`) — decide by cost/value

Load `.../<sessionId>/subagents/*.jsonl`, link by `agentId`/`fork-context-ref` to the parent `Agent` tool call, and attach a **compact summary** (subagent task, tool count, outcome) to the parent episode — not the full nested transcript (token blow-up). Lets the judge assess whether delegation helped or hurt. v1: summary only; full join deferred.

## Stage 5 — render (`render.ts`)
Compact text the judge reads (cap ~12k chars): `USER:`/`ASSISTANT:`/`[tool:name input]`, images as `[image attached]`, plus an appended block of evidence signals and any subagent summaries.

## Stage 6 — judge (`judge.ts` + `prompts/judge.md`) — P0 rubric
Per uncached episode, call `claude -p --output-format json` with the rubric + rendered episode; validate against the label schema; 1 retry on malformed JSON. Adapter boundary lets an API path drop in later.

**Bias-anchored rubric (counters Claude-grading-Claude leniency):** the judge must ground `outcome` primarily in **user-observable behavior** — did the user accept, rework, interrupt, explicitly approve/reject, or abandon? — and treat its own read of "Claude seemed competent" as secondary. Evidence signals are inputs, not verdicts. Weigh `task_difficulty` so a hard task done cleanly isn't "bad workflow" and a lucky trivial one-shot isn't "great workflow."

**Cache key (fixes staleness):** an episode is "already judged" only if `content_hash` **and** `judge_prompt_hash` **and** `label_schema_version` **and** `model` **and** `cli_version` all match. All stored as columns for selective invalidation and audit.

## Stage 7 — pipeline (`pipeline.ts`)
Wire discover→classify→group→signals→subagents→render→judge→store. Flags: `--project`, `--limit`, `--since`, `--resume`, `--classify-llm`. Smoke on `--limit 5` before full run.

## Stage 8 — mine (`mine.ts`) — component-based ranking, no composite score
Normalize `task_type` into clusters (string-normalize + one cheap `claude -p` grouping pass). Per cluster with ≥3 episodes: success rate and **workflow_pattern frequency contrast in success vs failed/partial** → "pattern A works / pattern B flails for task X." Rank candidates by **transparent, separate columns** rather than one fabricated number:

- `frequency` — # episodes (and # distinct sessions)
- `success_rate` — success / judged in cluster
- `median_friction` — median(`n_corrections` + `n_interruptions`)
- `has_stable_pattern` — max share of a single workflow_pattern among successes ≥ 0.5 (+ the dominant pattern)
- `risk_flags` — destructive ops (`rm -rf`, force-push, `DROP`, deploy), secrets/PII in tool inputs, write/delete-heavy
- `est_effort` (informational) — median `duration_s` × frequency

Composite scoring deferred until the inputs are trusted (avoids false precision on a small corpus).

## Stage 9 — report (`report.ts`) — exemplar-driven
`out/report.md`: per cluster — counts, success rate, the good-vs-bad workflow contrast, recurring friction, recommended intervention (skill/script/SOP), and **concrete exemplar episodes** (a good and a bad one with evidence links `sessionId#idx : first_prompt`). Thin clusters labeled **"insufficient evidence,"** not overclaimed. `out/candidates.json`: ranked components, machine-readable for the later skill-draft phase.

## SQLite schema (`schema.sql`)

- `sessions(session_id PK, project, path, started_at, completed_at, n_episodes)`
- `turns(turn_id PK, session_id FK, idx, role, char_len, n_images, ts, episode_id)` — classifier audit + features
- `episodes(episode_id PK, session_id FK, idx, task_key NULL, start_turn, n_turns, n_corrections, n_interruptions, n_approvals, n_images, used_subagents, subagent_summary, first_prompt, started_at, ended_at, content_hash)` — `task_key` nullable now so cross-session task linking (Phase 2) isn't precluded
- `episode_features(episode_id PK/FK, n_tool_calls, tool_sequence, n_files_read, n_files_edited, n_test_runs, duration_s, idle_s, tokens)`
- `episode_evidence(episode_id FK, signal, direction, weight, value, reason)` — long format, many rows/episode
- `episode_labels(episode_id PK/FK, task_type, task_difficulty, outcome, outcome_confidence, workflow_pattern_json, good_practices_json, friction_points_json, root_cause, outcome_evidence, skill_opportunity_json, judged_at, model, judge_prompt_hash, label_schema_version, cli_version)`
- `calibration(episode_id PK/FK, stratum, human_outcome, human_notes, agrees, checked_at)`
- `task_clusters(cluster_id PK, label, member_episode_ids_json)`

## Judge label schema (`judge.ts` validates)
```
{ episode_id, task_type, task_difficulty(trivial|moderate|hard),
  outcome(success|partial|failed|abandoned|qa_only), outcome_confidence(0-1),
  workflow_pattern[ordered tags e.g. explore,plan,edit,test,fix],
  good_practices[str], friction_points[{what,evidence}], root_cause,
  outcome_evidence[str], skill_opportunity{worth_codifying, type(skill|script|sop|none), rationale} }
```

## Calibration (replaces "no Tier 1") — P0
A judge cannot be calibrated against zero ground truth. This is a **mini Tier 1** (~30 min, not days):

- **Stratified sample** (~25–30 episodes), not random: across `outcome` ∈ {success, partial, failed, abandoned}, plus cross-cutting strata high-error, no-test, PR-created, image-heavy, subagent-heavy.
- `bun run src/calibrate.ts` prints each sampled episode (evidence + judge label + transcript); you record agree/disagree + correct outcome → `calibration` table → it reports **per-stratum agreement**. This is the trust gate before believing the full run.
- **Self-consistency:** re-judge ~10 episodes, measure label stability (flags judge overconfidence/noise).
- **Auto cross-check** (tightened): flag `needs_review` only on **high-precision contradictions** — judge=success but (`explicit_user_rejection` ∨ `abandoned_mid_edit`), or judge=failed but (`created_pr` ∨ `explicit_user_approval`). Weak signals (api_errors, no-PR, a single correction) do **not** trigger review.

## Verification (end-to-end)
1. `cd cowork-logs-analysis && bun install` (deps: none beyond `bun:sqlite`).
2. `bun run src/classify.ts <session>` → eyeball turn roles on the richest usth session (the 48-episode one); confirm pastes/acks/corrections no longer start episodes.
3. Smoke: `bun run pipeline.ts --project usth-tennis-tracking-system --limit 5` → `analysis.db` populated; labels valid JSON.
4. `bun run src/calibrate.ts` → per-stratum agreement acceptable before trusting the full run.
5. Full: `bun run pipeline.ts` (resumable; cache keyed on content+prompt+schema+model+cli).
6. `bun run src/mine.ts && bun run src/report.ts` → `out/report.md` shows ≥1 task with a good-vs-bad workflow contrast + exemplar evidence.

**Success = `report.md` surfaces at least one task where a good and a bad workflow are clearly distinguished with exemplar evidence, and judge↔human agreement on the calibration set is acceptable** — the trustworthy signal your Go/Kill 1 gate needs.

## Out of scope (deliberately)
SKILL.md drafting (gated in plan.md), org rollout/redaction/PR governance, vector store/KG, multi-user consolidation, composite ranking score, full subagent-transcript join. `candidates.json` is the clean handoff to those phases.

## Risks / notes
- **Segmentation is the linchpin** — every downstream stage depends on episode quality; that's why classification is its own P0 stage with its own audit table and verification step.
- **Self-grading bias** — mitigated by the user-behavior-anchored rubric + stratified calibration + self-consistency, but bounded; report confidence honestly.
- **Small N + cross-session tasks** — ~150–250 real tasks across 113 sessions, and big efforts span multiple sessions over days. Report is **exemplar-driven, not statistical**; thin clusters → "insufficient evidence"; `episodes.task_key` left nullable for future cross-session linking.
- **Headless `claude -p` is serial** — full run is slow; mitigated by the multi-part cache key + `--limit`/`--resume`. Swap to API via the adapter if volume grows.
