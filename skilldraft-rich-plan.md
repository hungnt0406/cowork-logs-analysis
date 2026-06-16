# Plan: Rich, LLM-authored skill drafts (rewrite `src/skilldraft.ts`)

## Context

The skill-generation stage today (the held-out `src/skilldraft.ts`, last seen at git `99263e2`) emits a **thin scaffold**: a `scripts/run.ts` with `STEPS = [...]` that does nothing, plus a placeholder SKILL.md. The user wants the generated skill to instead **encode the whole workflow** — success patterns as examples that an LLM reasons into an optimal workflow, *plus* the recurring errors and how to handle them — resembling the multi-file shape of Anthropic's `skill-creator` (SKILL.md + references/), but as a *domain* skill (not copying skill-creator's meta-tool dirs `agents/`, `grader.md`, `eval-viewer/`).

> **SUPERSEDED (2026-06):** the locked decisions below were revised — see
> `skilldraft-perstage-plan.md` for the authoritative direction. The LLM now authors
> the *most complete* workflow from its own expertise; evidence is only a
> discovery/ranking signal + a code-rendered "Observed" grounding layer. Output is split
> into a publishable `skill/` folder + a never-published `audit/` folder, one
> `references/<stage>.md` per workflow step, and there is **no REVIEW.md**. The overclaim
> guard no longer suppresses content; it only polices claims about observations.

Two product decisions were originally locked by the user (now revised per the note above):
- **Error-handling source** = the authoring **LLM authors the common errors + remediation** for the task type from its own expertise. The judge schema records `friction_points{what,evidence}` + `root_cause` but *not* how each was fixed; the mined friction only shows *which* errors were actually observed.
- **Overclaim guard** = ~~gate richness by evidence strength~~ → now a slimmed, pure honesty backstop enforced **in code after parsing**: it does not suppress content (no weak⇒null, no zero-failure sentinel); it de-"recurring"s singleton friction, softens absolutes in observed-data narration, and strips fabricated observation counts from authored prose. Real counts live only in the code-rendered `audit/` sections.

The module stays **gated + CLI-only** (opt-in `--yes`, writes `out/skill_drafts/`, never auto-published).

## Key architectural facts (verified)

- `skilldraft.ts` is absent from the working tree; restore intent from `git show 99263e2:src/skilldraft.ts`. CLI-only, **not** in `pipeline.ts`. No `"draft"` script in `package.json` yet.
- **Full transcripts are NOT persisted in the DB** (`src/calibrate.ts:149-159`). → The authoring pass uses **DB-distilled label fields + `candidates.json` contrasts** as evidence; it does **not** re-read raw `.jsonl` in v1.
- `mine()` persists `task_clusters(cluster_id, member_episode_ids_json)` (`src/mine.ts:473-476`, writer `upsertCluster` `db.ts:266`). → skilldraft reads `memberEpisodeIds` straight from that table; **no LLM re-clustering**.
- `episode_labels` holds per-episode: `outcome`, `workflow_pattern_json`, `good_practices_json`, `friction_points_json` (`[{what,evidence}]`), `root_cause`, `outcome_evidence`. Query patterns: `report.ts:77-130`, `calibrate.ts:74-100`.
- `candidates.json` = `{ machine_id, candidates: RankedCandidate[], contrasts: Record<cluster_id,{successPatterns,failPatterns,recurringFriction}>, generated_at }`. Contrast pairs are already `[string, number]` (**counts come free**). No exemplar refs, no per-episode practices.
- **`openDb(path?)` CREATES + MIGRATES** (`db.ts:17`: `new Database(path,{create:true})` then `migrate`). → must **never** use it to probe availability; `existsSync` first.
- **`extractJsonObject(raw): string|null` already exists in `judge.ts:198`** (balanced-brace, strips ```json fences) but is **not exported**. The other callers (mine/classify/sidecar) use a greedy `/\{[\s\S]*\}/` regex instead — weaker.
- Reuse: `sanitizeText(s):{text,hits,hadCredential,nStrongPii}` (`privacy.ts:64`); `PRIVACY_RULES_VERSION` (`types.ts:28`); `runClaudeText(prompt,{model?,timeoutMs?}):Promise<string|null>` (`runner.ts:62`, never throws, **only unwraps the Claude envelope — does NOT extract JSON**, returns `envelope.result` raw text). Prompt convention: inline rubric + `"## INPUT\n"+JSON`, **JSON-only output**. `RankedCandidate` (`types.ts:190-209`) has **no** member ids.

## Design

### Core principle — two coexisting paths, one layout

`draftSkill()` stays **sync + deterministic + LLM-free** and is the **single source of truth for the file layout**. The rich path layers LLM-authored *content* on top of the identical layout; it never produces a different set of files.

- `draftSkill(c, outRoot, allow): string` writes the **full** layout every time:
  `SKILL.md`, `references/{success-patterns,failure-modes,evidence}.md`, `REVIEW.md`, `meta.json`, `scripts/run.ts`, `tests/skill.test.ts`, `golden_cases.json`. (Deterministic templates — modest, no LLM.)
- `draftSkillRich(c, db, outRoot, allow, opts)` **first calls `draftSkill()`** to lay down the complete structure, **then overwrites only** `SKILL.md` + `references/*.md` (and the rich fields of `meta.json`/frontmatter) with authored content. If authoring yields `null`, it simply **skips the overwrite** → the output is exactly the deterministic draft. Layout can never diverge between paths.

### Functions (`src/skilldraft.ts`)

Preserve the contract names (tests + CLAUDE.md depend on them): `slugify`, `isDraftable` (`recommended_intervention ∈ {skill,script,sop}`), `class DraftGateError`, `draftSkill` (sync, throws if `!allow`/`!isDraftable`), `selfEval` (runs `bun test <dir>/tests`). New:

- `buildClusterEvidence(db, candidate, contrast): ClusterEvidence` — reads `member_episode_ids_json` for `candidate.cluster_id` from `task_clusters`; queries `episode_labels` for those ids; aggregates into **counted items** (point 3):
  - type `EvidenceItem = { text: string; count: number; examples?: string[] }`.
  - `goodPractices`, `frictionPoints` (`text`=`what`, `examples`=`evidence` samples), `rootCauses`: flatten across members, **sanitize every string**, dedupe (case-insensitive on `text`), tally `count`, keep top ~12 by count.
  - `successWorkflows`, `failWorkflows`, `recurringFriction`: map `contrast.*` `[string,count]` → `EvidenceItem` directly (sanitize text).
  - `evidenceStrength: "strong" | "weak"` = strong iff `!low_confidence && (n_judged ?? 0) >= 5`. `hasStablePattern` carried through (informational; today 0/22 true).
  - `nFailureEpisodes` (count of members with outcome ∈ failed/abandoned/partial) so the guard can detect "no failures".
  - Returns an **already-sanitized, token-bounded** bundle.
- `extractJsonObject` — **lift from `judge.ts` to `src/util.ts`, export it**, and have both `judge.ts` and skilldraft import it (DRY; point 5). Logic byte-identical → **no judge-cache impact** (prompt hash unchanged). skilldraft uses it instead of a greedy regex.
- `authorSkillContent(evidence, {model?,timeoutMs?}): Promise<AuthoredSkill | null>` — inline JSON-only rubric (template literal, mine.ts-style) + `"## INPUT\n"+JSON(evidence)`; call `runClaudeText`; run `extractJsonObject` on the result; `JSON.parse`; validate a small schema. **Retry up to 2 attempts** (judge pattern `judge.ts:357-366`): on `null` → retry; on parse/validate failure → retry once with a terse nudge (`"Return ONLY the JSON object — no prose, no markdown fences."`). After both fail → `null`. Default model `claude-opus-4-8`, override `DRAFT_LLM_MODEL`; timeout `DRAFT_LLM_TIMEOUT_MS` default `180000`.
  - **Output schema:** `{ when_to_use, optimal_workflow: string|null, checklist: string[], steps:[{name,detail}], errors:[{error,how_to_handle}], success_patterns_summary, references:{success_patterns_md, failure_modes_md, evidence_md} }`.
  - **Prompt gate (first line of defense):** strong → "state the optimal workflow authoritatively"; weak → "set `optimal_workflow` to null, produce a tentative `checklist`, prefix claims with observation counts; this is a lead, not a validated pattern."
- `applyOverclaimGuard(authored, evidence): AuthoredSkill` — **pure, post-parse code gate (point 4, the integrity crux).** Enforces invariants regardless of what the LLM returned:
  - `evidenceStrength === "weak"` → force `optimal_workflow = null` (and ensure a non-empty `checklist`).
  - `nFailureEpisodes === 0` (no fail patterns) → replace `errors` with a single sentinel `{error: "No failure episodes observed", how_to_handle: "No remediation data — N=<successes> successful runs, 0 failures observed."}`; never fabricate errors.
  - any `recurringFriction`/error item with `count < 2` → render with its explicit count and **must not** be labeled "recurring".
  - `!hasStablePattern` → strip/soften absolute language ("always/consistently/reliably/optimal") in `optimal_workflow`/`success_patterns_summary` (regex-normalize to "observed in N of M runs").
  - This function is the unit-test seam (point 7).
- `draftSkillRich(...)` — see Core principle. Sanitizes authored output once more (defense-in-depth) and runs `applyOverclaimGuard` **before** write.
- `draftFromCandidates(path, outRoot, allow, {top?, llm?, db?}): Promise<DraftResult[]>` — reads `candidates.json`. DB handling per the rules below. Each result runs `selfEval`. Prints an **estimated LLM-call count** before running the rich path (`--top` caps it; `--yes` already gates).

### DB availability (point 2)

- `--no-llm` → **never** open the DB; deterministic path only.
- Else resolve db path (`--db` or `DEFAULT_DB_PATH`); if **`!existsSync(path)`** → deterministic path + `log` a warning (do **not** call `openDb`, which would create an empty DB).
- Only `openDb()` after the path exists.
- Per candidate: if its `cluster_id` is **missing from `task_clusters`** (stale `candidates.json`) → fall back to deterministic for **that candidate only**, warn; never fail the whole batch.

### Output layout (`out/skill_drafts/<slug>/`) — REVISED

Superseded by `skilldraft-perstage-plan.md`. The current tree splits into a publishable
`skill/` folder and a never-published `audit/` folder:

```
out/skill_drafts/<slug>/
├─ skill/                  ← PUBLISH (copy this folder)
│  ├─ SKILL.md             when-to-use / workflow (numbered, each links its stage file) / safety / errors — NO mined counts
│  ├─ references/<stage>.md   one per workflow step (how-to / inputs / ask-user / web / errors / script)
│  ├─ references/{success-patterns,failure-modes}.md  authored synthesis (no counts)
│  └─ scripts/             authored stage scripts (referenced, never auto-run)
└─ audit/                  ← NEVER published
   ├─ evidence.md          mined tallies + provenance note
   ├─ observed.md          code-rendered Observed counts
   ├─ golden_cases.json · meta.json (generated_stage_refs manifest + flagged_scripts + metrics)
   └─ scripts/run.ts · tests/skill.test.ts  (self-eval harness)
```

`skill/SKILL.md` frontmatter is minimal + publishable: `name`, `description`, `version`,
`auto_generated: true`, `privacy_rules_version` — **no** `status`/`review_required`, and
`evidence_strength`/`confidence`/metrics move to `audit/meta.json`. No `## Evidence`
section and no DRAFT banner in the published skill. `selfEval` runs
`bun test <slug>/audit/tests`.

### Privacy (point 6)

Sanitize **every string written to disk**, not just LLM I/O — including `candidate.label`, `business_note`, `risk_flags`, `recommended_intervention` text, contrast strings, root causes, the **frontmatter `description`**, and the LLM-authored markdown. `slug` is already safe (slugified to `[a-z0-9-]`).
- **Frontmatter is YAML** → beyond `sanitizeText`, **YAML-escape** every scalar (quote + escape `:`/newlines/quotes) via a tiny `yamlScalar()` helper, because a redacted string can still contain YAML-breaking chars. This is the highest-risk leak/format vector.
- `meta.json` records `privacy_rules_version: PRIVACY_RULES_VERSION`.

### Wiring

- `package.json`: add `"draft": "bun run src/skilldraft.ts"`.
- CLI: `--candidates <path>`, `--top N`, `--yes` (required), `--no-llm`, `--db <path>`. Keep the `99263e2` opt-in refusal + summary output.
- **Not** wired into `pipeline.ts`.

## Tests — `src/merge.test.ts` (re-add; all LLM-FREE, pure seams)

Re-add the skill-draft gate (CLAUDE.md claims `bun test src` covers it). All tests exercise sync/pure code; never call Claude:
- opt-in refusal: `draftSkill(cand(), tmp, false)` throws `DraftGateError`.
- non-draftable: `isDraftable(cand({recommended_intervention:"none"}))` false; `draftSkill(...,true)` on it throws.
- deterministic layout: `draftSkill(cand({label:"create ticket flow"}), tmp, true)` → `slugify`==`"create-ticket-flow"`; `selfEval` passes `nTests>=3`; dir contains `SKILL.md` (valid frontmatter) **and** `references/`.
- `extractJsonObject`: extracts a balanced object from fenced/prosey text; returns `null` on no-object → `authorSkillContent`-style flow yields `null` on malformed input.
- `applyOverclaimGuard`: weak evidence ⇒ `optimal_workflow===null`; zero failures ⇒ errors == the sentinel; singleton friction not labeled "recurring".
- privacy: a secret embedded in a fake `EvidenceItem` is absent from the rendered markdown / frontmatter (redacted before write).
- stale cluster: a candidate whose `cluster_id` has no `task_clusters` row falls back cleanly (deterministic), batch continues.

## Risk handling

- **LLM null/malformed** → `authorSkillContent` retries once (null→re-run; bad JSON→re-run with nudge); exhausted → `draftSkillRich` skips the overwrite ⇒ deterministic draft; self-eval still passes.
- **LLM over-claims despite prompt gate** → `applyOverclaimGuard` (code) normalizes before write; `confidence:low` + REVIEW.md are the human backstop.
- **Cluster has zero failures** → guard writes the "No failure episodes observed" sentinel; never fabricate.
- **DB absent / `--no-llm`** → deterministic path, logged; never create an empty DB.
- **Stale `candidates.json`** (cluster missing) → per-candidate deterministic fallback, warn; batch continues.
- **Cost / non-TTY** → opt-in `--yes`; rich path prints an estimated call count; `--top N` caps it.
- **Non-idempotent rich path** → re-running overwrites authored content with new LLM output (acceptable for a manual review queue; note it in REVIEW.md so reviewers aren't surprised).

## Files to change

- `src/skilldraft.ts` — **rewrite** (contract from `99263e2` + LLM-authoring path + `applyOverclaimGuard` + counted evidence + sanitize/yaml-escape on write).
- `src/util.ts` — **lift + export `extractJsonObject`** (move from judge.ts).
- `src/judge.ts` — import `extractJsonObject` from util (delete its local copy; behavior unchanged → no cache impact).
- `src/db.ts` — add reader `getClusterMembers(db, clusterId): string[]` (honor "db.ts is the only DB layer"; report.ts/calibrate.ts have inline-SQL precedent if a reader feels heavy).
- `src/merge.test.ts` — re-add the LLM-free gate + pure-helper tests above.
- `package.json` — add `"draft"`.
- `CLAUDE.md` — update the `draft` description (LLM-authored rich layout + code gate).

## Verification

1. **No-LLM smoke:** `bun run draft --yes --no-llm` → deterministic drafts; confirm SKILL.md + `references/` + passing `tests/`; confirm **no DB file** was created when none existed.
2. **Gate + pure tests:** `bun test src` → privacy + convergence + skill-draft gate + guard/extractor/privacy helpers all green.
3. **Structural invariants:** `bun run check` exits 0.
4. **Live strong candidate:** `bun run draft --yes --top 1` (top is `feature`, n=41) → inspect `feature/SKILL.md`: authoritative **Workflow**, real **Errors & handling**, `confidence: high`.
5. **Weak candidate (reproducible — point 8):** since every *draftable* candidate today is `low_confidence=False`, a live weak draft is **not** reproducible from `candidates.json`; cover weak behavior via the **`applyOverclaimGuard` fixture test** (item 2). The manual live check on a low_confidence cluster is **conditional**: run only if one exists, else skip.
6. **Privacy:** grep an authored draft for obvious secret/PII patterns; confirm frontmatter is valid YAML and `meta.json.privacy_rules_version` is set.

## Subagents (point 9)

Single-writer: the main agent implements + integrates (write scope is concentrated in `src/skilldraft.ts`). Use subagents **only for parallel review of the final diff** — agent A: DB access / data-flow / fallback correctness; agent B: privacy (sanitize+YAML-escape coverage), tests, schema/contract. No parallel write agents.
