# Example: `feature` skill draft

This is a **published example** of the skill that the gated post-handoff drafter
(`src/skilldraft.ts`, `bun run draft`) produces for the `feature` task cluster.

It is a verbatim copy of the publishable half — `out/skill_drafts/feature/skill/` —
checked in here as a reference because `out/` is gitignored (regenerated output).
The sibling `audit/` half (mined `evidence.md` / `observed.md` / `golden_cases.json`
/ self-eval tests) is intentionally **not** published.

## What's here

- `SKILL.md` — authored Claude-skill: frontmatter + Quick checklist + Workflow
  table + Constraints (MUST-DO/MUST-NOT) + Safety gate + Reference guide.
- `references/` — one `*.md` per workflow step (how-to / examples ✅❌ / edge cases /
  common mistakes / inputs / error handling / script / checklist), plus
  `success-patterns.md` and `failure-modes.md`.
- `scripts/` — authored helper scripts (referenced by the skill, never executed).

The workflow is **LLM-authored best practice** for the task type; mined evidence is
used only to prioritise steps/errors and feeds the (unpublished) `audit/` layer, so
this published skill carries no provenance noise (no counts, no "Observed", no `×`).

To regenerate: `bun run draft --yes` → `out/skill_drafts/<slug>/{skill,audit}/`.
