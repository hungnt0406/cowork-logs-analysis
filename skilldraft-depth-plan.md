# Plan: Richer, Claude-format skill drafts (frontmatter metadata + fuller SKILL.md + deep references)

## Context

The generated skill drafts (`src/skilldraft.ts` → `out/skill_drafts/<slug>/skill/`) are too sparse
next to a good published Claude skill (reference: `Jeffallan/claude-skills/skills/api-designer`).
Concretely, after inspecting `out/skill_drafts/feature/`:

- **Frontmatter is present but minimal** — `name/description/version/auto_generated/privacy_rules_version`.
  The example adds a `license` + a `metadata:` block (trigger keywords, domain, role) that makes the
  skill read like a real published unit and helps skill selection. (User confirmed: add it.)
- **References are the biggest gap** — each per-stage file is **~7 lines** (one prose paragraph + 2–3
  bullets). The example's reference files are deep: H2/H3 sections, concrete examples, good-vs-bad
  contrast pairs, edge cases, a closing checklist. (User confirmed: go example-level deep.)
- **SKILL.md is missing sections** the example has — a **Quick checklist**, a **Constraints (MUST /
  MUST NOT)** block, and a **Reference-guide table**. Notably the authoring LLM **already produces a
  `checklist`** field that is parsed, sanitized, guarded… then **never written to any file** (confirmed
  by grep — no writer consumes `a.checklist`). Free content currently discarded. (User confirmed:
  "Enrich, balanced" — add these, keep heavy depth in references.)

**Constraint that shapes the design:** the only LLM path is `claude -p --output-format json`
(`src/runner.ts:62`), which has **no max-output-tokens control**. A single huge "deep references"
payload can truncate → invalid JSON → `authorSkillContent` returns null → deterministic fallback (the
thin stubs). So depth must be delivered as **structured, bounded fields rendered by code**, not one
giant free-text markdown blob — keeping the single-call model the user chose while staying parseable.

Outcome: drafts whose SKILL.md and per-stage references match the depth/format of a real Claude skill,
with richer publishable frontmatter, and no regression to the privacy/safety/honesty guarantees.

## Approach (all in `src/skilldraft.ts`, the single writer)

### 1. Enrich frontmatter (`frontmatter()` + new authored metadata)
Render the user-approved shape; `name`/`description` stay top-level (spec-required), `license`
top-level, the rest under `metadata:`:
```
---
name: feature
description: "Use when adding a new feature…"
license: MIT
metadata:
  version: "0.1.0"
  auto_generated: true
  domain: "software-engineering"
  role: "implementer"
  triggers:
    - "new feature"
    - "add endpoint"
  privacy_rules_version: "1"
---
```
- `frontmatter(slug, description, meta)` gains a `meta` arg: `{ triggers: string[], domain, role, license }`.
- **YAML safety reused:** every scalar via the existing `yamlScalar()` (`skilldraft.ts:144`); `triggers`
  rendered as a **block list** (`- "<yamlScalar-without-quotes>"`), each item escaped — never inline
  `[a, b]` (a redacted comma/quote would break it).
- `license` default from a `DRAFT_SKILL_LICENSE` env, fallback `"MIT"` (matches the approved preview;
  editable by hand). `domain`/`role`/`triggers` come from the LLM (rich path) or **deterministic
  defaults** (no-LLM path): `triggers=[label]`, `domain="software-engineering"`, `role` derived from
  `recommended_intervention` (skill/script/sop → `"implementer"`/`"automation"`/`"practitioner"`).
- Existing test asserts `md.includes("version:")` — still true (now indented under `metadata`); `name:`
  / `description:` stay top-level. No test breakage.

### 2. Extend the authored schema (new fields **optional** → no fixture/test churn)
`AuthoredSkill` (skilldraft.ts:108) gains: `triggers?: string[]`, `domain?: string`, `role?: string`,
`constraints?: { must_do: string[]; must_not: string[] }`. (`checklist` already exists — now rendered.)

`AuthoredStep` (skilldraft.ts:97) gains depth fields, all **optional**:
`steps_detail?: string[]` (the actionable "how to do it" procedure), `examples?: { good: string; bad?:
string; note?: string }[]` (good-vs-bad contrast), `edge_cases?: string[]`, `common_mistakes?:
string[]`, `checklist?: string[]`. Keep `how_to/inputs_needed/ask_user/web_search/error_handling/script`.

Making them optional means the existing `step()` / `authored()` test helpers (merge.test.ts:244,257) and
all current tests compile and pass unchanged; renderers emit a section only when its field is non-empty
(same conditional pattern as today's bullets).

### 3. Coerce the new fields (`coerceStep` / `validateAuthored`, skilldraft.ts:404,438)
Lenient coercion mirroring the current style: `asStringArray` for the string-list fields; a small
`coerceExamples()` (keep entries with a non-empty `good`); `constraints` → `{must_do:[],must_not:[]}`
default. **Validation gate unchanged** (still requires `when_to_use` + ≥1 valid step) so the null →
deterministic-fallback safety net is intact.

### 4. Rewrite the authoring prompt (`buildAuthorPrompt`, skilldraft.ts:345)
- Request the new per-stage depth and the skill-level `triggers/domain/role/constraints`.
- **Bound output to avoid truncation:** explicit per-field targets — `steps_detail` 3–7 items,
  `examples` 2–4 (each 1–3 lines), `edge_cases`/`common_mistakes` 2–5, per-stage `checklist` 3–6,
  steps 5–7. "Be concrete and example-rich but terse; no filler."
- **Keep verbatim:** the `description` trigger rules, the SAFETY GATE clause, JSON-only output, and the
  one honesty clause (no invented counts / no "recurring" for singletons). Examples/code are authored
  expertise — no grounding constraint on them.

### 5. Render the depth
- **`richStageRef(step)`** (skilldraft.ts:771) — rewrite to a multi-section body, sections emitted only
  when present:
  `# <name>` → intro (`how_to`) → `## How to do it` (`steps_detail` numbered) → `## Examples` (✅
  good / ❌ bad / note, fenced when multi-line) → `## Edge cases` → `## Common mistakes` →
  `## Inputs needed` · `## When to ask the user` · `## When to search the web` · `## Error handling`
  (keep current bullets) → `## Script` (`scripts/<file>` link, unchanged) → `## Checklist`.
- **`skillMd()` rich body** (skilldraft.ts:692) — add, between existing sections:
  `## Quick checklist` (render `a.checklist`; **the currently-dropped field**), `## Workflow` as a
  **markdown table** (`# | Step | What it does | Reference`), `## Constraints` (**MUST DO** /
  **MUST NOT** from `a.constraints`), and a closing `## Reference guide` table (each stage file +
  `success-patterns.md`/`failure-modes.md`, with a one-line "read when"). Keep `## When to use`,
  `## Safety` (the code-enforced `SAFETY_NOTE`), `## Errors & handling`. Each section guarded for
  emptiness. The inline `` `references/<file>` `` links remain (the test regex at merge.test.ts:522
  still matches; table cells keep the backtick path). **No mined counts / no "Observed" / no `×`** in
  SKILL.md — preserves the publish/audit split assertions (merge.test.ts:547-549).
- **`detStageRef()`** (skilldraft.ts:786) — modest enrichment: the same section headings with honest
  `_authored when DB evidence is available_` placeholders, so even an LLM-free / fallback draft isn't a
  3-line stub. (Filenames unchanged → `generated_stage_refs` test still `["explore.md","edit.md",
  "test.md"]`.)

### 6. Privacy + honesty cover the new fields (no new leak surface)
- **`sanitizeAuthored()`** (skilldraft.ts:1170) — extend to sanitize `triggers/domain/role`,
  `constraints.*`, and per-step `steps_detail/examples/edge_cases/common_mistakes/checklist`. Every
  string still passes `san()` before disk (the existing redaction tests at merge.test.ts:378,402 then
  cover the new fields once a test seeds a secret into them).
- **`applyOverclaimGuard()`** (skilldraft.ts:547) — extend `stripFabricatedCounts` / `softenAbsolutes` /
  de-"recurring" passes to also walk the new prose-bearing fields (examples, steps_detail, edge_cases,
  common_mistakes, per-stage + skill checklist). Pure; still the unit-test seam.

### Truncation safeguard (single-call kept; escape hatch documented)
Bounded structured fields (above) + the existing 2-attempt retry (`authorSkillContent`, skilldraft.ts:481)
+ the richer `detStageRef` fallback are the mitigation. If, in live runs, the deeper payload still
truncates often, the localized escape hatch is to author references in a second pass — I'll leave
`authorSkillContent` as the single seam where that split would happen and note it in a code comment,
but **not** implement the split now (user chose single-call). No change to `runner.ts`.

## Files to change
- **`src/skilldraft.ts`** — primary: schema extensions; `coerceStep`/`validateAuthored`;
  `buildAuthorPrompt`; `frontmatter` (+ `meta` arg, deterministic defaults, `DRAFT_SKILL_LICENSE`);
  `skillMd` (Quick checklist / Workflow table / Constraints / Reference guide); `richStageRef` rewrite;
  `detStageRef` enrich; `sanitizeAuthored` + `applyOverclaimGuard` field coverage. Reuses existing
  `yamlScalar`, `san`, `assignStageRefs`, `countedList` (audit only) — no new infra.
- **`src/merge.test.ts`** — keep all current tests green (new fields optional). Add: (a) frontmatter
  has `license:`, `metadata:`, `triggers:`, and is valid YAML; (b) `richStageRef` emits `## Examples` /
  `## Edge cases` / `## Checklist` when those fields are set, plus a good/bad marker; (c) skill-level
  `checklist` is rendered into SKILL.md (`## Quick checklist`) — the regression guard for the
  dropped field; (d) `constraints` renders MUST/MUST NOT. Extend one redaction test to seed a secret in
  a new field (e.g. an `examples[].good`) and assert it's absent from disk.
- **`CLAUDE.md`** — update the `draft` paragraph: SKILL.md now carries Quick-checklist / Constraints /
  Reference-guide table + richer `metadata` frontmatter; references are deep multi-section per stage.
- **`skilldraft-perstage-plan.md`** (untracked note) — append a short "v2: depth + frontmatter
  metadata" addendum so the design note matches the code.

## Verification
1. `bun test src` — all existing + new pure/seam tests green (guard, stageFileName, writeRichDraft,
   privacy, frontmatter, new richStageRef sections, checklist-rendered).
2. `bun run check` — structural DB invariants still exit 0 (no DB-path changes).
3. `bun run draft --yes --no-llm` — deterministic drafts produce the full tree with **enriched
   frontmatter** (license + metadata.triggers) and section-skeleton stage stubs; confirm **no DB file
   created** when none exists; `selfEval` passes.
4. **Live depth check (opt-in):** `bun run draft --yes --top 1` (the `feature` candidate, n_judged=41).
   Inspect `out/skill_drafts/feature/`:
   - `skill/SKILL.md`: frontmatter has `metadata.triggers`; body has Quick checklist + Workflow table +
     Constraints + Reference guide; **no counts / no "Observed" / no banner**.
   - `skill/references/<stage>.md`: each is multi-section (How to do it / Examples ✅❌ / Edge cases /
     Common mistakes / Error handling / Checklist) — clearly deep, not a 7-line stub.
   - `wc -l skill/references/*.md` is an order of magnitude larger than today's ~7.
   - Watch the run for an authoring timeout/`null` (truncation) → would fall back to the (now richer)
     deterministic stubs; if frequent, flip on the documented split-references escape hatch.
5. Privacy spot-check: grep the whole draft (`skill/` + `audit/`, incl. `scripts/*`) for secret/PII
   patterns; confirm `skill/SKILL.md` frontmatter parses as valid YAML.
