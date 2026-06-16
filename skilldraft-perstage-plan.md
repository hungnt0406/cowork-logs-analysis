# Plan: LLM-authored complete workflow + per-stage reference depth in skill drafts

## Context

`src/skilldraft.ts` turns a GO candidate into a reviewable skill draft. Today each
workflow stage in `SKILL.md` is **a single line** (`name` + one-line `detail`) — it says
*what* to do, not *how*. References are thin/generic, `scripts/` is a dead scaffold, and
richness is **gated by evidence strength** (`applyOverclaimGuard` forces
`optimal_workflow=null` on weak evidence, emits a sentinel when zero failures observed).

The mined evidence is too sparse to author a step-level playbook: even the top candidate
`feature` (n_judged=41, `recommended_intervention:"sop"`, `has_stable_pattern:false`) has
success patterns and friction almost all at count=1 (`out/candidates.json`).

**Decision (user):** the LLM should author the *most complete, full* workflow for a task
type from its own expertise; evidence stops being a content *constraint* and becomes
(a) the discovery/ranking signal (unchanged) and (b) a separate **"Observed in your
sessions"** grounding layer, rendered by code from real counts so it can't be fabricated.
Each stage gets deep how-to in `skill/references/`, **one file per stage** (how to do it, what
to ask the user, when to search the web, error handling, and any script). The output is also
restructured into a **publishable `skill/` folder** and a separate **`audit/` folder** (mined
evidence/counts/golden_cases/meta/tests) so the published skill carries no provenance noise; and
`REVIEW.md` is dropped — the draft is a **complete skill**, edited by hand if needed. Generated
scripts are written and referenced (not auto-run).

This is a deliberate philosophy change, so the integrity story shifts from "every claim is
grounded" to "**the procedure is LLM best-practice; statements about observed data stay
honest**". Code-synced docs must be updated to match.

## Confirmed choices
- **Publish/audit split:** every draft is written as two sibling folders —
  `out/skill_drafts/<slug>/skill/` (the **publishable** unit — copy this whole folder) and
  `out/skill_drafts/<slug>/audit/` (provenance/verification — **never published**).
- **No REVIEW.md, no DRAFT banner:** produce a **complete** skill directly; if the user wants
  changes they edit by hand. Drop `reviewMd()` and the "NOT reviewed / DRAFT-PENDING-REVIEW"
  framing. A tiny `auto_generated: true` provenance flag in frontmatter is the only marker.
- **Evidence role:** still produce the mined "Observed" layer (code-rendered counts) — but it
  lives in **`audit/`**, not in the published skill.
- **Per-stage references:** each workflow stage is its OWN file in `skill/references/`
  (e.g. `clarify_scope.md`), NOT a single combined `workflow.md`.
- **Scripts:** authored scripts go in `skill/scripts/<file>` + are referenced from the stage
  file; do **not** execute in `selfEval`. A code-level safety scan flags dangerous bodies with
  an `⚠️ UNVETTED` header in the file + a record in `audit/meta.json` (informational, not a gate).

## Output layout
```
out/skill_drafts/<slug>/
├─ skill/                         ← PUBLISH (clean, self-contained)
│  ├─ SKILL.md                    when-to-use / workflow / safety / errors — NO mined counts
│  ├─ references/
│  │  ├─ <stage>.md …             one per workflow step (how-to / inputs / ask-user / web / errors)
│  │  ├─ success-patterns.md      authored success synthesis only (no counts)
│  │  └─ failure-modes.md         authored errors + handling only (no counts)
│  └─ scripts/                    authored stage scripts only
└─ audit/                         ← NEVER published
   ├─ evidence.md                 mined tallies + provenance note
   ├─ observed.md                 code-rendered Observed counts (workflows / good practices / friction / roots)
   ├─ golden_cases.json
   ├─ meta.json                   tool metadata + generated_stage_refs manifest + flagged_scripts + metrics
   ├─ scripts/run.ts              test scaffold (NOT part of the skill)
   └─ tests/skill.test.ts         self-eval harness (reads ../../skill/SKILL.md, ../scripts/run.ts, ../golden_cases.json)
```
`selfEval` runs `bun test <slug>/audit/tests`. Publishing = copy `<slug>/skill/`.

## Design

### 1. Extend the per-step authored schema (`AuthoredSkill.steps`)
`src/skilldraft.ts` — today `steps: {name, detail}[]`. Extend each step to:
```
{ name, detail,            // detail = the existing one-line hot-path summary (SKILL.md)
  how_to,                  // full how-to prose → references/<stage>.md
  inputs_needed: string[], // info the stage needs
  ask_user,                // when/what to ask the user ("" if N/A)  ← Clarify-scope case
  web_search,              // when to search the web ("" if N/A)
  error_handling,          // per-stage failure handling
  script? }                // optional { filename, language, purpose, body }
```
Provenance is **structural, not self-tagged**: the LLM authors the procedure freely; the
mined signal lives in its own code-rendered sections (see #5). No per-step `grounded` flag.

Update `validateAuthored()` to coerce the new fields leniently (default `""`/`[]`/omit
`script`); keep `when_to_use` as required **and require ≥1 valid step** — an authored object
with `steps:[]` returns `null` (→ deterministic draft, which still has per-stage stubs), so a
draft is never marked `authored=true` with zero stage files. `optimal_workflow` is now
**always requested** (no strong/weak fork).

### 2. Flip the authoring prompt (`buildAuthorPrompt`)
- Remove "Ground every claim in the evidence / do NOT invent practices, errors, numbers."
- New framing: *"Author the most complete, correct end-to-end workflow for `<label>` from
  your engineering expertise. The mined evidence below is real-world signal from the user's
  own sessions — use it to prioritise the stages/errors that actually bite and to ground
  specifics, but DO cover stages the evidence never reached. Fill every stage fully."*
- Per stage require: `how_to`, `inputs_needed`, `ask_user`, `web_search`, `error_handling`,
  and an optional `script` when the stage is genuinely deterministic/scriptable.
- Drop the "if no failures, return empty errors" rule → *"List the common, important errors
  for this task type and how to handle them; the evidence shows which were actually observed."*
- **Keep**: the `description` trigger rules; the SAFETY GATE (commit/push/PR/deploy/history
  only on explicit user request); JSON-only output; and one honesty clause: *"Do not invent
  counts or call something 'recurring' that was observed once — statements about what was
  observed must match the evidence; the recommended procedure is your expertise."*
- `evidenceStrength` / `hasStablePattern` stay in the input only to flavour confidence
  language, never to suppress content.

### 3. Retarget `applyOverclaimGuard` (the integrity backstop, slimmed)
- **Delete** rule 1 (weak ⇒ `optimal_workflow=null`) and rule 2 (zero failures ⇒ sentinel).
- **Keep** rule 4 (de-"recurring" when `maxFrictionCount(ev) < 2`) across all authored prose.
- **Soften-absolutes (rule 3):** restrict `softenAbsolutes` to `success_patterns_summary`
  and the observed-data narration only — NOT the workflow/how_to/steps (that's expertise).
- **Strip fabricated counts** from authored prose (workflow/how_to/steps/errors/summary):
  regex-neutralise observation-count claims — `observed in 7 runs`, `5 of 8 sessions`,
  `in N episodes` → vague phrasing. Real counts only ever come from the code-rendered Observed
  sections; the LLM must not assert numbers in free prose (prompt says so; this is the backstop).
- Real number-honesty is now structural: mined sections are rendered by `countedList()`
  with actual counts and cannot lie. The guard only polices the LLM's *claims about*
  observations. It remains the pure unit-test seam.

### 4. One reference file PER STAGE in `skill/references/`
Each workflow stage becomes its **own** file, e.g. `Clarify scope` → `skill/references/clarify_scope.md`
(NOT a single combined `workflow.md`). Add:
- `stageFileName(name)` helper: lowercase, keep `[a-z0-9_]` (spaces/punct → `_`), collapse/trim
  `_`, cap length, fallback `stage`; **dedupe within a draft** (append `_2`, `_3` on collision).
  Underscore style follows the user's example (`clarify_scope.md`); the 3 fixed "Observed" files
  keep their existing hyphen names.
- `richStageRef(step, ev)` → one file body:
```
# <name>
<how_to>

- **Inputs needed:** …            (omit if empty)
- **Ask the user:** …             (omit if empty)
- **When to search the web:** …   (omit if empty)
- **Error handling:** <error_handling>
- **Script:** `scripts/<file>` — <purpose>   (only if a script was written)
```
- `detStageRef(stepName)` → a short deterministic stub body (no DB needed).
- `assignStageRefs(steps): {step, fileName}[]` — the **single** place that maps steps→filenames
  (runs `stageFileName` + dedupe ONCE). Both `skillMd()` links and the file writers consume this
  one array, so a SKILL.md link can never point at a filename that wasn't written.

**Both paths keep "one file per stage"; cleanup is manifest-driven (never touch human files):**
- `draftSkill()` (deterministic) writes a stub per step from `steps(c)` (the `dominant_pattern`
  split, e.g. `explore.md`) into `skill/references/` and records the generated stage filenames
  in `audit/meta.json` (`generated_stage_refs`).
- `draftSkillRich()` first calls `draftSkill()`, then deletes **only the files listed in the
  prior `generated_stage_refs` manifest** (NOT a blanket `skill/references/*.md` wipe — a
  human-added `skill/references/my-notes.md` survives), writes one file per authored step via
  `assignStageRefs`, then rewrites the manifest. The two fixed authored files (`FIXED_REFS` =
  `{success-patterns,failure-modes}.md`) are never in the manifest.

### 5. Split authored content (skill/) from mined counts (audit/)
Previously `richSuccessRef`/`richFailureRef` mixed authored prose with code-rendered counts;
now they split by destination:
- **skill/** (publishable, authored-only, NO counts):
  - `skill/references/success-patterns.md` — `a.success_patterns_summary` + `a.references.success_patterns_md`.
  - `skill/references/failure-modes.md` — authored `a.errors` (full list) + `a.references.failure_modes_md`.
- **audit/** (mined, code-rendered, never published):
  - `audit/observed.md` (new `richObservedRef(ev)`) — the `countedList()` sections:
    Observed success workflows / good practices / friction / root causes.
  - `audit/evidence.md` (`richEvidenceRef`) — tallies + a provenance note ("Workflow is
    LLM-authored best practice; counts here are mined from N judged episodes").
Deterministic path writes stub equivalents (det observed/evidence say "no DB evidence" when none).

### 6. SKILL.md body (clean, publishable)
`skillMd()` rich body: render the numbered `steps` as the **Workflow** section (name +
`detail` one-liner), and **each step links to its own stage file**, e.g.
``1. **Clarify scope** — <detail>. → `references/clarify_scope.md` `` (link is skill-relative).
Sections: **When to use** · **Workflow** · **Safety** (keep `SAFETY_NOTE`) · **Errors & handling**
(top-3 brief → link `references/failure-modes.md`). **Drop the `## Evidence` mined-counts section**
(it moves to `audit/`) and **drop the "⚠️ Auto-drafted / NOT reviewed" banner**. Fallback to a
checklist only if `steps` is empty.
Frontmatter (minimal, publishable): `name`, `description`, `version`, `auto_generated: true`,
`privacy_rules_version`. Move `evidence_strength`/`confidence`/metrics to `audit/meta.json`.

### 7. Write generated scripts → `skill/scripts/` (`draftSkillRich`)
After guard + sanitize, for each step with a `script`:
- **Filename policy = REJECT, not salvage** (resolves the prior internal inconsistency):
  reject any raw name containing `/`, `\`, `..`, a leading `.`, an absolute path, or a drive
  letter → skip + `console.error` warn (do NOT silently strip to a basename). Then `resolve()`
  and assert the path stays inside `skill/scripts/`.
- **No scaffold collision:** the test scaffold now lives in `audit/scripts/run.ts`, separate
  from `skill/scripts/`, so authored scripts can't overwrite it. (Defensively still reject a
  leading `.`; reserving `run.ts` is no longer required.)
- **Safety scan on the body (code backstop, not just `san()`):** `san()` only redacts secrets.
  Additionally scan for genuinely dangerous signals — `rm -rf`/destructive deletes, `git push`/
  force-push/history-rewrite, pipe-to-shell (`curl|wget … | sh`), exfil to external hosts,
  reads/writes of credential files (`~/.ssh`, `.env`, `.aws`), arbitrary `npm/pip install`,
  DB drops. On a match: still WRITE the script (honours the "complete skill, no gate" choice)
  but prepend a prominent `# ⚠️ UNVETTED — flagged: <reason>; review before running` header and
  record `{file, reason}` under `flagged_scripts` in `audit/meta.json`. Benign subprocess
  (running tests/build) is NOT flagged — keep patterns narrow; reuse
  `DESTRUCTIVE_PATTERNS`/`SECRET_PATTERNS` from `mine.ts`.
- `writeFileSync` the **sanitized** body (`san()` first — secrets never hit disk).
- Reference it from the step's stage file (#4), as `scripts/<file>` (skill-relative).
- No `selfEval` execution of authored scripts.
Extend `sanitizeAuthored()` to cover all new string fields incl. `script.{filename,purpose,body}`.

### 8. Tests (`src/merge.test.ts`)
- **Rewrite** `guard: weak evidence forces optimal_workflow null …` → assert weak evidence
  **preserves** `optimal_workflow` (no longer nulled).
- **Rewrite** `guard: zero failures yields the sentinel …` → assert zero failures **keeps**
  authored errors (no sentinel injected).
- **Keep** `guard: singleton friction never labeled 'recurring'`; keep redaction tests
  (`buildClusterEvidence`, `draftSkill`), gate/`isDraftable`/`DraftGateError`, `clampDescription`,
  safety-gate, `getClusterMembers`, stale-cluster fallback, deterministic-layout.
- **Update** the safety-gate test: assert `## Safety` + "explicitly asks" live in
  `skill/SKILL.md`; **remove** the REVIEW.md assertion (REVIEW.md no longer exists).
- **Update** the redaction `draftSkill` test: walk BOTH `skill/` and `audit/`; no secret in any file.
- **Add** publish/audit split test: `skill/` has no mined counts (no `frequency N`, no
  "Observed" sections, no `## Evidence`); `audit/observed.md` + `audit/evidence.md` carry them.
- **Add** `richStageRef` test: a stage named "Clarify scope" renders a body containing its
  `how_to` + "Ask the user" + a ``scripts/<file>`` reference.
- **Add** `stageFileName` test: "Clarify scope" → `clarify_scope`; collisions dedupe to
  `_2`; punctuation/empty fall back safely.
- **Add** script filename-policy test: `../etc/passwd`, `a/b.sh` are **rejected** (skipped) —
  NOT salvaged to a basename; resolved path stays inside `skill/scripts/`.
- **Add** safety-scan test: a body with `rm -rf /` (or `git push --force`) is written WITH the
  `⚠️ UNVETTED` header and recorded in `audit/meta.json.flagged_scripts`; a benign `bun test` body is not.
- **Add** fabricated-count strip test: `optimal_workflow`/how_to containing "observed in 7 runs"
  is neutralised by the guard.
- **Add LLM-free rich-write seam** `writeRichDraft(c, ev, authored, dir)` (or an
  `authorOverride?: AuthoredSkill` param) so tests inject authored content and exercise the full
  write path with no Claude call. Assert: (a) `skill/references/<stage>.md` files match the
  `skill/SKILL.md` links (`assignStageRefs`), (b) a script is written to `skill/scripts/` + linked,
  (c) stale manifest files are removed but a human `skill/references/my-notes.md` survives,
  (d) `audit/meta.json.authored===true`, (e) `selfEval` passes.
- Update the deterministic-layout test for the new tree: `skill/SKILL.md` + per-stage stubs in
  `skill/references/` + `audit/{evidence.md,observed.md,golden_cases.json,meta.json,tests/}`,
  and `generated_stage_refs` in `audit/meta.json`. No `REVIEW.md` anywhere.

### 9. Sync the docs (single-source-of-truth)
- `CLAUDE.md`: rewrite the `draft` paragraph — drop "richness gated by evidence strength /
  weak forces `optimal_workflow=null` / zero-failure sentinel" and the `SKILL.md + references/...
  + REVIEW.md` layout sentence. State: "Each GO candidate becomes a complete skill written as
  `skill/` (publishable: SKILL.md + one `references/<stage>.md` per workflow step + authored
  `scripts/`) plus a sibling `audit/` (mined evidence, observed counts, golden_cases, meta,
  tests — never published). No REVIEW.md; the guard only polices observed-count claims + the
  safety gate." Update the `bun run draft` command notes accordingly.
- `skilldraft-rich-plan.md`: update the two "locked decisions" (error-handling source,
  overclaim guard) + the old output-layout section to match this new direction (untracked note).

## Files to change
- `src/skilldraft.ts` — **primary**: split writes into `skill/` + `audit/` subfolders;
  **remove `reviewMd()`** and the DRAFT-banner/`review_required` framing; clean `skillMd`
  (drop `## Evidence` + banner, minimal frontmatter); extend `AuthoredSkill`/step schema;
  `validateAuthored` (require ≥1 step); `buildAuthorPrompt`; slim `applyOverclaimGuard`
  (+ fabricated-count strip); add `stageFileName` + `assignStageRefs` + `richStageRef` +
  `detStageRef` + `richObservedRef`; manifest-based stale-file cleanup (manifest in
  `audit/meta.json`); script writer → `skill/scripts/` (reject-filename + safety scan →
  `audit/meta.json.flagged_scripts`); relocate scaffold/golden/tests under `audit/` and fix
  the `testTs` relative paths (`../../skill/SKILL.md`); a testable `writeRichDraft` seam;
  extend `sanitizeAuthored`.
- `src/merge.test.ts` — update/add tests per #8.
- `CLAUDE.md`, `skilldraft-rich-plan.md` — doc sync per #9.
- No changes to `mine.ts`, `report.ts`, `db.ts`, `types.ts`, `privacy.ts`, `runner.ts`
  (all consumed as-is; `getClusterMembers`, `sanitizeText`, `extractJsonObject`, `runClaudeText`
  reused).

## Verification
1. `bun test src` — all pure/gate tests green (incl. rewritten guard tests + new stage/script tests).
2. `bun run check` — structural DB invariants still exit 0.
3. `bun run draft --yes --no-llm` — deterministic drafts produce the full `skill/`+`audit/`
   tree: per-stage stubs in `skill/references/` (e.g. `explore.md`), audit files under `audit/`,
   **no `REVIEW.md` anywhere**; confirm **no DB file created** when none exists; `selfEval` passes.
4. **(required, LLM-free)** Rich-write seam: call `writeRichDraft`/`authorOverride` with an
   injected authored fixture into a temp dir and assert `skill/` stage files match SKILL.md links,
   a script is written to `skill/scripts/` + linked, manifest cleanup spares a human file,
   `audit/meta.json.authored===true`, mined counts appear only under `audit/`, and `selfEval`
   passes (CI-safe replacement for live inspection — see #8).
5. **(optional, opt-in — depends on DB/Claude/model/cost; NOT a hard gate)**
   `bun run draft --yes --top 1` (live, `feature`, n=41) — inspect `out/skill_drafts/feature/`:
   - `skill/SKILL.md` Workflow = numbered steps, each linking its own `references/<stage>.md`;
     no mined counts / no banner.
   - `skill/references/clarify_scope.md` (one file per stage) has **How to / Ask the user /
     When to search the web / Error handling**, and a `scripts/<file>` reference where authored.
   - `audit/observed.md` + `audit/evidence.md` carry the code-rendered "Observed …" counts.
6. Privacy spot-check: grep the whole draft (`skill/` + `audit/`, incl. `scripts/*`) for
   secret/PII patterns; confirm `skill/SKILL.md` frontmatter is valid YAML.

---

## v2: depth + frontmatter metadata (implemented)

The v1 drafts above were structurally complete but *thin* next to a real published Claude
skill (`Jeffallan/claude-skills/skills/api-designer`): minimal frontmatter, ~7-line stage
references, and a SKILL.md missing the checklist/constraints/reference-guide a real skill
carries. v2 closes that gap **without** changing the single-`claude -p` call model — depth is
delivered as **bounded, structured authored fields rendered by code**, never one giant
free-text blob that could truncate → invalid JSON → null → scaffold fallback. (See
`skilldraft-depth-plan.md` for the full design.) All changes are in `src/skilldraft.ts`.

- **Schema (all new fields OPTIONAL → no fixture/test churn):** `AuthoredStep` gains
  `steps_detail`, `examples: {good, bad?, note?}[]`, `edge_cases`, `common_mistakes`,
  `checklist`; `AuthoredSkill` gains `triggers`, `domain`, `role`, `constraints: {must_do,
  must_not}`. Coerced leniently (`coerceExamples` keeps only entries with a non-empty `good`;
  `coerceConstraints` defaults to empty arrays). The validation gate is unchanged
  (`when_to_use` + ≥1 valid step), so null → deterministic-fallback is intact.
- **Frontmatter:** `frontmatter(slug, description, meta)` now renders top-level
  `name`/`description`/`license` + a `metadata:` block (`version`, `auto_generated`, `domain`,
  `role`, **block-list** `triggers`, `privacy_rules_version`). `license` from
  `DRAFT_SKILL_LICENSE` (default `MIT`). No-LLM defaults: `triggers=[label]`,
  `domain="software-engineering"`, `role` from `recommended_intervention`
  (skill→implementer / script→automation / sop→practitioner). Every scalar via `yamlScalar`;
  `triggers` is a block list (never inline `[a, b]` — a redacted comma/quote would break it).
- **SKILL.md (rich body):** adds `## Quick checklist` (renders `a.checklist` — the field that
  was parsed/guarded then **never written** in v1), `## Workflow` as a markdown **table**
  (`# | Step | What it does | Reference`, the Reference cell keeps the backtick
  `references/<file>` link the test regex matches), `## Constraints` (MUST DO / MUST NOT), and
  a closing `## Reference guide` table. Table cells run through `cell()` (escapes `|`, folds
  newlines). Still **no mined counts / no "Observed" / no `×`** — the publish/audit split holds.
- **references/<stage>.md (rich):** `richStageRef` rewritten to multi-section — intro →
  How to do it (numbered `steps_detail`) → Examples (✅ good / ❌ bad / note, fenced when
  multi-line) → Edge cases → Common mistakes → Inputs needed → When to ask the user → When to
  search the web → Error handling → Script → Checklist. Sections emit only when non-empty.
  `detStageRef` enriched to the same section skeleton with honest
  `_Authored when DB evidence is available._` placeholders (filenames unchanged →
  `generated_stage_refs` manifest is identical).
- **Authoring prompt (`buildAuthorPrompt`):** requests the new fields with **explicit bounds**
  (steps 5–7; `steps_detail` 3–7; `examples` 2–4 at 1–3 lines; `edge_cases`/`common_mistakes`
  2–5; per-stage `checklist` 3–6; skill `checklist` 5–9; `triggers` 3–6; `constraints` 2–5
  each) and "be concrete but terse; finish the object" to stay parseable. The `description`
  trigger rules, SAFETY GATE, JSON-only, and honesty clauses are kept verbatim; examples/code
  are explicitly flagged as authored expertise needing no observation grounding.
- **Privacy + honesty:** `sanitizeAuthored` covers every new string (triggers/domain/role,
  constraints.*, and per-step depth fields incl. `examples.{good,bad,note}`).
  `applyOverclaimGuard` extends count-strip + de-"recurring" to the new prose fields via
  `mapStepProse`/`mapConstraints`; `softenAbsolutes` stays restricted to the observed-data
  narration (it must not soften authored expertise — examples/sub-steps included).
- **Truncation escape hatch (documented, not implemented):** if the deeper payload truncates
  often in live runs, split references into a second authoring pass at the `authorSkillContent`
  seam. Not done now (user chose single-call); `runner.ts` unchanged.
- **Tests (`merge.test.ts`):** all v1 tests stay green (new fields optional). Added: frontmatter
  license/metadata/block-list-triggers parses as valid YAML (`Bun.YAML.parse`); `richStageRef`
  depth sections + ✅/❌ markers (and a thin-step omission test); rich SKILL.md Quick checklist +
  Constraints + Workflow table + Reference guide with no counts; and a redaction test seeding a
  secret in `examples[].good`/`edge_cases` asserting it never reaches disk.
