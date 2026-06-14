# POLICY — Worker protection & data privacy

Version 1.0 · applies to the merged Cowork Workflow Miner (logs-analysis core + harness shell).

Goal: turn work **into reusable knowledge**, NOT to surveil individuals. The rules below
are enforced in code, not just documented.

## 1. No personal surveillance
- Only existing co-work **transcripts** are read (work artifacts) — no keystroke logging,
  no screenshots, no real-time tracking.
- The unit of analysis is a **workflow/episode**, not a person. Output optimises process;
  it must not be used to discipline individuals.

## 2. Worker opt-out (consent) — `src/privacy.ts`
- Any session/project can be excluded from analysis:
  - a `.cwbh-exclude` file in the working directory, or
  - a path containing `personal` / `private` / `ca-nhan` / `rieng-tu` (configurable via `CWBH_EXCLUDE`).
- Enforced in `filterExcluded()` **before** any content is read (wired into `pipeline.ts`).

## 3. Data minimisation — egress gate `src/privacy.ts`
- **Credentials** (API key / password / token / private key / JWT / connection string)
  are **DROPPED** (`[REDACTED-*]`) before any text reaches the LLM.
- **PII** (email / phone / national-id / bank-acct / money / customer-code) is **MASKED**.
- The gate runs at **every LLM egress point**: `render.ts` (→ judge) and
  `calibrate.ts` reconstruction (→ judge). Local report exemplars are sanitised too.

## 4. Transparency / audit — `out/state/audit.json`
- Every run records: sessions read vs opted-out, episodes judged, redaction hits,
  episodes with credentials dropped, strong-PII masks.

## 5. No automated decisions about people
- The system only **suggests** (candidates / interventions). It does not auto-create or
  publish skills, and never produces HR judgements.
- Skill drafts (`src/skilldraft.ts`) are opt-in (`--yes`), go to a **review queue**
  (`out/skill_drafts/`), and require human sign-off (REVIEW.md). Never published.

## 6. Business as a late sidecar — `src/sidecar.ts`
- The judge and miner are **business-blind** to preserve independent evaluation.
- Business context is applied only AFTER ranking, by the sidecar, as advisory notes.

## 7. Purpose limitation
- Data is used only to find repeated / inefficient / error-prone workflows to improve work.
  No reuse for other purposes.
