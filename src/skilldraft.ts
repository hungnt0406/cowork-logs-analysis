// skilldraft.ts — LLM-authored complete skills (post-handoff, gated, CLI-only).
//
// This is the phase AFTER the Go/Kill gate. The base miner deliberately STOPS at
// candidates.json; this module turns a GO candidate into a *complete* skill — the LLM
// authors the most complete, correct workflow for the task type from its own expertise;
// the mined evidence is used only to PRIORITISE and to feed a separate, code-rendered
// "Observed" grounding layer that lives under audit/ (never published).
//   * opt-in only (--yes); refuses otherwise,
//   * only candidates whose recommended_intervention is skill|script|sop,
//   * writes to out/skill_drafts/<slug>/ split into a publishable skill/ folder and a
//     never-published audit/ folder (mined evidence, observed counts, golden_cases,
//     meta, tests). Publishing = copy the skill/ folder.
//   * every draft ships a runnable `bun test` suite under audit/tests; self-eval runs it.
//
// TWO COEXISTING PATHS, ONE LAYOUT:
//   * draftSkill()      — sync, deterministic, LLM-free. The single source of truth for
//                         the file layout; writes the FULL tree every time and records the
//                         generated per-stage reference filenames in audit/meta.json.
//   * draftSkillRich()  — calls draftSkill() first, then deletes ONLY the prior
//                         generated_stage_refs (never a blanket wipe — human-added files
//                         survive), writes LLM-authored per-stage files, scripts and the
//                         split skill/audit content, then rewrites the manifest. If
//                         authoring yields null, it skips the overwrite → output is exactly
//                         the deterministic draft. Layout can never diverge.
//
// INTEGRITY: the procedure is LLM best-practice; statements about OBSERVED data stay
// honest. applyOverclaimGuard (pure, post-parse) polices only claims about observations —
// it de-"recurring"s singletons, softens absolutes in observed-data narration, and strips
// fabricated observation counts from authored prose. Real counts only ever come from the
// code-rendered audit/ sections (countedList), which cannot lie. Every string written to
// disk is sanitized (privacy.ts); YAML frontmatter scalars are additionally YAML-escaped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
import type { Database } from "bun:sqlite";
import type { RankedCandidate } from "./types.ts";
import { PRIVACY_RULES_VERSION } from "./types.ts";
import { sanitizeText } from "./privacy.ts";
import { extractJsonObject, truncate } from "./util.ts";
import { runClaudeText } from "./runner.ts";
import { openDb, getClusterMembers, DEFAULT_DB_PATH } from "./db.ts";
import { DESTRUCTIVE_PATTERNS } from "./mine.ts";

const DEFAULT_OUT_ROOT = join(import.meta.dir, "..", "out", "skill_drafts");
const DEFAULT_CANDIDATES = join(import.meta.dir, "..", "out", "candidates.json");

const DRAFT_LLM_MODEL = process.env.DRAFT_LLM_MODEL || "claude-opus-4-8";
// Per-attempt ceiling. The authored payload is large (one full how-to + inputs/ask-user/
// web/error-handling per stage, plus errors and three reference bodies), so a single opus
// call routinely runs 3-6 min — a tighter cap silently times out (→ null → scaffold
// fallback). 600s leaves headroom; override with DRAFT_LLM_TIMEOUT_MS.
const DRAFT_LLM_TIMEOUT_MS = Number(process.env.DRAFT_LLM_TIMEOUT_MS) || 600000;
// Publishable license for the generated skill frontmatter. Editable by hand; overridable
// via DRAFT_SKILL_LICENSE. Default "MIT" matches the user-approved preview.
const DRAFT_SKILL_LICENSE = process.env.DRAFT_SKILL_LICENSE || "MIT";
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EXAMPLES = 3;
const MAX_ITEM_CHARS = 280;
const MAX_EXAMPLE_CHARS = 200;

// The two fixed authored reference files. They keep hyphen names and are NEVER in the
// generated_stage_refs manifest (so manifest-driven cleanup can't delete them).
const FIXED_REFS = ["success-patterns.md", "failure-modes.md"] as const;

export class DraftGateError extends Error {}

// ── Public-ish data shapes ────────────────────────────────────────────────────
export interface EvidenceItem {
  text: string;
  count: number;
  examples?: string[];
}

export interface ClusterEvidence {
  clusterId: string;
  label: string;
  recommendedIntervention: string;
  frequency: number;
  nSessions: number;
  nJudged: number;
  successRate: number;
  lowConfidence: boolean;
  hasStablePattern: boolean;
  evidenceStrength: "strong" | "weak";
  nFailureEpisodes: number;
  nSuccessEpisodes: number;
  riskFlags: string[];
  businessNote?: string;
  // Counted, deduped, sanitized, token-bounded evidence.
  goodPractices: EvidenceItem[];
  frictionPoints: EvidenceItem[];
  rootCauses: EvidenceItem[];
  successWorkflows: EvidenceItem[];
  failWorkflows: EvidenceItem[];
  recurringFriction: EvidenceItem[];
}

// A good-vs-bad contrast example for a stage. `good` is required; `bad`/`note` optional.
export interface AuthoredExample {
  good: string;
  bad?: string;
  note?: string;
}

// An authored workflow stage. detail = the one-line hot-path summary (SKILL.md); the rest
// is depth that renders into skill/references/<stage>.md. The depth fields are all
// OPTIONAL — a step authored without them still renders cleanly; renderers emit a
// section only when its field is non-empty.
export interface AuthoredStep {
  name: string;
  detail: string;
  how_to: string;
  inputs_needed: string[];
  ask_user: string;
  web_search: string;
  error_handling: string;
  // Depth (optional) → rendered as their own sections in references/<stage>.md.
  steps_detail?: string[]; // the actionable "how to do it" numbered procedure
  examples?: AuthoredExample[]; // good-vs-bad contrast pairs
  edge_cases?: string[];
  common_mistakes?: string[];
  checklist?: string[]; // per-stage closing checklist
  script?: { filename: string; language: string; purpose: string; body: string };
}

export interface AuthoredSkill {
  description: string; // one self-contained sentence — the frontmatter trigger
  when_to_use: string;
  optimal_workflow: string | null;
  checklist: string[];
  steps: AuthoredStep[];
  errors: { error: string; how_to_handle: string }[];
  success_patterns_summary: string;
  // Publishable metadata (optional) → frontmatter `metadata:` block + ## Constraints.
  triggers?: string[]; // skill-selection trigger keywords
  domain?: string;
  role?: string;
  constraints?: { must_do: string[]; must_not: string[] };
  references: {
    success_patterns_md: string;
    failure_modes_md: string;
    evidence_md: string;
  };
}

export interface ClusterContrast {
  successPatterns: [string, number][];
  failPatterns: [string, number][];
  recurringFriction: [string, number][];
}

export interface DraftResult {
  slug: string;
  dir: string;
  authored: boolean; // true => LLM-authored rich content; false => deterministic draft
  selfEval: { passed: boolean; nTests: number; tail: string[] };
}

// ── Privacy helpers (every string written to disk passes through here) ─────────
function san(s: string): string {
  return sanitizeText(s ?? "").text;
}

// Sanitize + YAML-escape a scalar for frontmatter. A redacted string can still
// contain YAML-breaking chars (':', newlines, quotes) — the highest-risk format/leak
// vector — so we always double-quote and escape. Returns the quoted scalar.
function yamlScalar(s: string): string {
  const clean = san(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x1f]/g, " "); // strip any remaining control chars
  return `"${clean}"`;
}

// ── Contract: slug / gate predicate ───────────────────────────────────────────
export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "skill"
  );
}

// Gate predicate: draftable only if the miner recommended a concrete intervention.
export function isDraftable(c: RankedCandidate): boolean {
  return (
    c.recommended_intervention === "skill" ||
    c.recommended_intervention === "script" ||
    c.recommended_intervention === "sop"
  );
}

// Evidence strength from the candidate alone (used by the deterministic path and
// mirrored inside buildClusterEvidence): strong iff confident AND enough judged. Now
// only flavours confidence language; never suppresses content.
function candidateEvidenceStrength(c: RankedCandidate): "strong" | "weak" {
  return !c.low_confidence && (c.n_judged ?? 0) >= 5 ? "strong" : "weak";
}

// ── Per-stage reference filenames (the SINGLE filename-mapping seam) ───────────
// Underscore style (clarify_scope.md). Distinct from the hyphen-named FIXED_REFS.
export function stageFileName(name: string): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || "stage";
}

// Map authored steps → unique stage filenames ONCE. Both skillMd() links and the file
// writers consume this single array, so a SKILL.md link can never point at a filename
// that wasn't written. Collisions dedupe via _2, _3, ….
export function assignStageRefs(steps: AuthoredStep[]): { step: AuthoredStep; fileName: string }[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const base = stageFileName(step.name || step.detail);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const fileName = (n === 1 ? base : `${base}_${n}`) + ".md";
    return { step, fileName };
  });
}

// ── Evidence aggregation (DB-distilled + candidates.json contrasts) ────────────
function safeParseArray(json: string | null | undefined): any[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Flatten {text, examples?} entries into counted, deduped, sanitized, bounded items.
function tallyItems(
  entries: { text: string; examples?: string[] }[],
  cap = MAX_EVIDENCE_ITEMS
): EvidenceItem[] {
  const map = new Map<string, EvidenceItem>();
  for (const e of entries) {
    const text = truncate(san(e.text).trim(), MAX_ITEM_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    const existing = map.get(key);
    const exs = (e.examples ?? [])
      .map((x) => truncate(san(x).trim(), MAX_EXAMPLE_CHARS))
      .filter(Boolean);
    if (existing) {
      existing.count++;
      if (exs.length) {
        existing.examples ??= []; // first occurrence may have had no evidence
        for (const ex of exs) {
          if (existing.examples.length >= MAX_EXAMPLES) break;
          if (!existing.examples.includes(ex)) existing.examples.push(ex);
        }
      }
    } else {
      map.set(key, {
        text,
        count: 1,
        examples: exs.length ? exs.slice(0, MAX_EXAMPLES) : undefined,
      });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, cap);
}

// Contrast pairs already carry counts — map straight to bounded EvidenceItems.
function contrastItems(pairs: [string, number][] | undefined, cap = MAX_EVIDENCE_ITEMS): EvidenceItem[] {
  return (pairs ?? [])
    .map(([text, count]) => ({ text: truncate(san(text).trim(), MAX_ITEM_CHARS), count }))
    .filter((it) => it.text)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, cap);
}

// Build the (already-sanitized, token-bounded) evidence bundle for a cluster.
// Reads member episode ids from task_clusters; queries episode_labels for those ids;
// folds in the candidates.json contrast. Never re-clusters and never reads raw jsonl.
export function buildClusterEvidence(
  db: Database,
  candidate: RankedCandidate,
  contrast: ClusterContrast | undefined
): ClusterEvidence {
  const members = getClusterMembers(db, candidate.cluster_id);

  const good: { text: string }[] = [];
  const friction: { text: string; examples?: string[] }[] = [];
  const roots: { text: string }[] = [];
  let nFailureEpisodes = 0;
  let nSuccessEpisodes = 0;

  if (members.length > 0) {
    const placeholders = members.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT outcome, good_practices_json, friction_points_json, root_cause
         FROM episode_labels WHERE episode_id IN (${placeholders})`
      )
      .all(...members) as Array<{
      outcome: string | null;
      good_practices_json: string | null;
      friction_points_json: string | null;
      root_cause: string | null;
    }>;

    for (const r of rows) {
      if (r.outcome === "success") nSuccessEpisodes++;
      if (r.outcome === "failed" || r.outcome === "abandoned" || r.outcome === "partial") {
        nFailureEpisodes++;
      }
      for (const gp of safeParseArray(r.good_practices_json)) {
        if (typeof gp === "string" && gp.trim()) good.push({ text: gp });
      }
      for (const fp of safeParseArray(r.friction_points_json)) {
        if (fp && typeof fp === "object" && typeof fp.what === "string" && fp.what.trim()) {
          friction.push({
            text: fp.what,
            examples: typeof fp.evidence === "string" && fp.evidence.trim() ? [fp.evidence] : undefined,
          });
        } else if (typeof fp === "string" && fp.trim()) {
          friction.push({ text: fp });
        }
      }
      if (typeof r.root_cause === "string" && r.root_cause.trim()) roots.push({ text: r.root_cause });
    }
  }

  const evidenceStrength = candidateEvidenceStrength(candidate);

  return {
    clusterId: candidate.cluster_id,
    label: san(candidate.label),
    recommendedIntervention: san(candidate.recommended_intervention),
    frequency: candidate.frequency,
    nSessions: candidate.n_sessions,
    nJudged: candidate.n_judged ?? 0,
    successRate: candidate.success_rate,
    lowConfidence: candidate.low_confidence ?? false,
    hasStablePattern: candidate.has_stable_pattern,
    evidenceStrength,
    nFailureEpisodes,
    nSuccessEpisodes,
    riskFlags: (candidate.risk_flags ?? []).map(san).filter(Boolean),
    businessNote: candidate.business_note ? san(candidate.business_note) : undefined,
    goodPractices: tallyItems(good),
    frictionPoints: tallyItems(friction),
    rootCauses: tallyItems(roots),
    successWorkflows: contrastItems(contrast?.successPatterns),
    failWorkflows: contrastItems(contrast?.failPatterns),
    recurringFriction: contrastItems(contrast?.recurringFriction),
  };
}

// ── LLM authoring (JSON-only; retry; never throws) ─────────────────────────────
const AUTHOR_NUDGE = "Return ONLY the JSON object — no prose, no markdown fences.";

function buildAuthorPrompt(ev: ClusterEvidence): string {
  const confidence =
    ev.evidenceStrength === "strong"
      ? "The mined evidence is reasonably strong — state the workflow with confidence."
      : "The mined evidence is thin (low confidence / few judged episodes) — keep confidence language measured, but still author the full, correct workflow.";
  const rubric = `You are authoring a COMPLETE, production-quality engineering "skill" — a reusable workflow guide — for the recurring task type "${ev.label}". Author the MOST COMPLETE, CORRECT end-to-end workflow for "${ev.label}" from your own engineering expertise. ${confidence}

The MINED EVIDENCE below is real-world signal from the user's own coding sessions (counts of observed practices, friction points, workflow patterns, root causes). Use it to PRIORITISE the stages and errors that actually bite for this user and to ground specifics — but you MUST cover stages the evidence never reached. Fill every stage fully; do not omit a stage just because the evidence is silent on it.

OUTPUT: a single JSON object, no prose, no markdown fences, matching EXACTLY this shape:
{
  "description": string,
  "when_to_use": string,
  "optimal_workflow": string,
  "checklist": string[],
  "triggers": string[],
  "domain": string,
  "role": string,
  "constraints": {"must_do": string[], "must_not": string[]},
  "steps": [{
    "name": string, "detail": string,
    "how_to": string, "inputs_needed": string[],
    "ask_user": string, "web_search": string,
    "error_handling": string,
    "steps_detail": string[],
    "examples": [{"good": string, "bad": string, "note": string}],
    "edge_cases": string[],
    "common_mistakes": string[],
    "checklist": string[],
    "script": {"filename": string, "language": string, "purpose": string, "body": string}
  }],
  "errors": [{"error": string, "how_to_handle": string}],
  "success_patterns_summary": string,
  "references": {
    "success_patterns_md": string,
    "failure_modes_md": string,
    "evidence_md": string
  }
}

RULES:
- "description" is the SKILL-SELECTION TRIGGER: ONE complete, self-contained sentence of AT MOST 180 characters that names when to reach for this skill. It must read as a finished sentence (never cut off mid-clause) and must NOT duplicate "when_to_use". This single field decides whether the skill fires, so make it precise and standalone.
- "when_to_use" is a slightly fuller (2-4 sentence) trigger description for the body.
- "checklist": the SKILL-LEVEL quick checklist — 5-9 short, imperative items a practitioner ticks off across the whole workflow.
- "triggers": 3-6 short keyword/phrase triggers for skill selection (e.g. "new feature", "add endpoint").
- "domain": one short kebab/space domain label (e.g. "software-engineering").
- "role": the practitioner role this skill serves (e.g. "implementer", "automation", "practitioner").
- "constraints": {"must_do": 2-5 imperative MUSTs, "must_not": 2-5 imperative MUST-NOTs} — hard rules for this task type.
- "steps": 5-7 entries covering the whole workflow end to end. Each step:
  - "name": short imperative; "detail": one-line hot-path summary for SKILL.md.
  - "how_to": full how-to prose (the intro depth in references/<stage>.md).
  - "inputs_needed": info the stage needs (string[]; [] if none).
  - "ask_user": when/what to ask the user ("" if N/A — e.g. a Clarify-scope stage asks; an automatic stage does not).
  - "web_search": when to search the web ("" if N/A).
  - "error_handling": how this stage fails and what to do.
  - "steps_detail": 3-7 numbered, actionable sub-steps — the concrete "how to do it" procedure.
  - "examples": 2-4 good-vs-bad contrast pairs, each {"good": ..., "bad": ..., "note": ...}; "good" required, each 1-3 lines (code or prose); "bad"/"note" optional.
  - "edge_cases": 2-5 edge cases / gotchas to watch for ([] if none).
  - "common_mistakes": 2-5 common mistakes to avoid ([] if none).
  - "checklist": 3-6 short per-stage checklist items.
  - "script": ONLY when the stage is genuinely deterministic/scriptable — a runnable script {filename, language, purpose, body}. Omit otherwise. Scripts are referenced, never auto-run.
- Be concrete and example-rich but TERSE — no filler, no restating other fields. Bound each field to the counts above so the JSON stays small enough to return complete (do NOT truncate; finish the object).
- "optimal_workflow": author the recommended end-to-end workflow as prose (always provide it).
- "errors": list the common, important errors for THIS task type and how to handle them; the evidence shows which were actually observed. Infer plausible remediations from your expertise and the friction/root-cause signal.
- SAFETY GATE — outward-facing or hard-to-reverse actions (git commit, push, force-push, open/merge a PR, deploy/publish/release, rewrite history, or delete remote/shared data) must be written as GATED ON AN EXPLICIT USER REQUEST in the current conversation. Never present them as routine automatic steps; phrase them as "when the user asks, …" or as a step that first confirms. Local, reversible edits need no gate.
- HONESTY: do not invent observation counts in prose, and do not call something "recurring" that was observed once — statements about what was OBSERVED must match the evidence. The recommended PROCEDURE is your expertise; only claims about the user's observed data must stay grounded. Examples and code are authored expertise — they need no observation grounding.
- references.* are self-contained markdown bodies (headings/lists allowed): success_patterns_md adds DEPTH (concrete examples, edge cases, rationale) — do NOT restate the optimal_workflow prose, it is rendered separately; failure_modes_md expands the errors + handling; evidence_md narrates limitations.`;
  return rubric + "\n\n## INPUT\n" + JSON.stringify(ev, null, 2);
}

function asString(x: any, d = ""): string {
  return typeof x === "string" ? x : d;
}

function asStringArray(x: any): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : [];
}

// Coerce good-vs-bad example entries leniently; keep only entries with a non-empty `good`.
function coerceExamples(x: any): AuthoredExample[] {
  if (!Array.isArray(x)) return [];
  const out: AuthoredExample[] = [];
  for (const e of x) {
    if (!e || typeof e !== "object") continue;
    const good = asString(e.good).trim();
    if (!good) continue;
    const bad = asString(e.bad).trim();
    const note = asString(e.note).trim();
    out.push({ good, ...(bad ? { bad } : {}), ...(note ? { note } : {}) });
  }
  return out;
}

// Coerce a constraints block → always {must_do, must_not} (defaults to empty arrays).
function coerceConstraints(x: any): { must_do: string[]; must_not: string[] } {
  if (!x || typeof x !== "object") return { must_do: [], must_not: [] };
  return { must_do: asStringArray(x.must_do), must_not: asStringArray(x.must_not) };
}

// Coerce one parsed step leniently. Returns null when it has no name AND no detail. The
// depth fields are only attached when non-empty so test-built steps (without them) stay
// shape-identical and renderers' optional-chaining guards behave the same.
function coerceStep(s: any): AuthoredStep | null {
  if (!s || typeof s !== "object") return null;
  const name = asString(s.name).trim();
  const detail = asString(s.detail).trim();
  if (!name && !detail) return null;
  let script: AuthoredStep["script"] | undefined;
  if (s.script && typeof s.script === "object") {
    const filename = asString(s.script.filename).trim();
    const body = asString(s.script.body);
    if (filename && body.trim()) {
      script = {
        filename,
        language: asString(s.script.language).trim() || "sh",
        purpose: asString(s.script.purpose).trim(),
        body,
      };
    }
  }
  const stepsDetail = asStringArray(s.steps_detail);
  const examples = coerceExamples(s.examples);
  const edgeCases = asStringArray(s.edge_cases);
  const commonMistakes = asStringArray(s.common_mistakes);
  const checklist = asStringArray(s.checklist);
  return {
    name,
    detail,
    how_to: asString(s.how_to).trim(),
    inputs_needed: asStringArray(s.inputs_needed),
    ask_user: asString(s.ask_user).trim(),
    web_search: asString(s.web_search).trim(),
    error_handling: asString(s.error_handling).trim(),
    ...(stepsDetail.length ? { steps_detail: stepsDetail } : {}),
    ...(examples.length ? { examples } : {}),
    ...(edgeCases.length ? { edge_cases: edgeCases } : {}),
    ...(commonMistakes.length ? { common_mistakes: commonMistakes } : {}),
    ...(checklist.length ? { checklist } : {}),
    ...(script ? { script } : {}),
  };
}

// Validate + coerce a parsed object into AuthoredSkill. Lenient on the new fields
// (default ""/[]/omit script), but now REQUIRES when_to_use AND ≥1 valid step — an
// authored object with steps:[] returns null (→ deterministic draft, which still has
// per-stage stubs), so a draft is never marked authored=true with zero stage files.
function validateAuthored(obj: any): AuthoredSkill | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const when = asString(obj.when_to_use).trim();
  if (!when) return null;
  // description is the trigger field; fall back to when_to_use's first sentence.
  const description = asString(obj.description).trim() || firstSentence(when);

  const optimal =
    typeof obj.optimal_workflow === "string" && obj.optimal_workflow.trim()
      ? obj.optimal_workflow
      : null;
  const checklist = asStringArray(obj.checklist);
  const steps = Array.isArray(obj.steps)
    ? (obj.steps.map(coerceStep).filter(Boolean) as AuthoredStep[])
    : [];
  if (steps.length === 0) return null; // require ≥1 valid step
  const errors = Array.isArray(obj.errors)
    ? obj.errors
        .filter((e: any) => e && typeof e === "object")
        .map((e: any) => ({ error: asString(e.error).trim(), how_to_handle: asString(e.how_to_handle).trim() }))
        .filter((e: { error: string; how_to_handle: string }) => e.error)
    : [];
  const summary = asString(obj.success_patterns_summary).trim();
  const refs = obj.references && typeof obj.references === "object" ? obj.references : {};
  // Publishable metadata (all optional → attached only when present).
  const triggers = asStringArray(obj.triggers);
  const domain = asString(obj.domain).trim();
  const role = asString(obj.role).trim();
  const constraints = coerceConstraints(obj.constraints);

  return {
    description,
    when_to_use: when,
    optimal_workflow: optimal,
    checklist,
    steps,
    errors,
    success_patterns_summary: summary,
    ...(triggers.length ? { triggers } : {}),
    ...(domain ? { domain } : {}),
    ...(role ? { role } : {}),
    ...(constraints.must_do.length || constraints.must_not.length ? { constraints } : {}),
    references: {
      success_patterns_md: asString(refs.success_patterns_md).trim(),
      failure_modes_md: asString(refs.failure_modes_md).trim(),
      evidence_md: asString(refs.evidence_md).trim(),
    },
  };
}

// Author rich content from evidence. Up to 2 attempts (judge pattern): null → retry;
// parse/validate failure → retry once with a terse nudge. Returns null after both fail.
export async function authorSkillContent(
  ev: ClusterEvidence,
  opts?: { model?: string; timeoutMs?: number }
): Promise<AuthoredSkill | null> {
  const model = opts?.model ?? DRAFT_LLM_MODEL;
  const timeoutMs = opts?.timeoutMs ?? DRAFT_LLM_TIMEOUT_MS;
  const base = buildAuthorPrompt(ev);
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? base : base + "\n\n" + AUTHOR_NUDGE;
    const raw = await runClaudeText(prompt, { model, timeoutMs });
    if (raw == null) continue; // timeout / spawn failure → retry
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      continue;
    }
    const validated = validateAuthored(parsed);
    if (validated) return validated;
  }
  return null;
}

// ── Overclaim guard (PURE, post-parse code gate — the integrity backstop) ──────
// Slimmed: it no longer suppresses content (no weak⇒null, no zero-failure sentinel).
// It only polices CLAIMS ABOUT OBSERVATIONS — softens absolutes in observed-data
// narration, de-"recurring"s singleton friction, and strips fabricated observation
// counts the LLM may have asserted in free prose. Real counts come only from the
// code-rendered audit/ sections. Stays pure (unit-test seam).
function softenAbsolutes(s: string): string {
  if (!s) return s;
  return s
    .replace(/\balways\b/gi, "often")
    .replace(/\bnever\b/gi, "rarely")
    .replace(/\bconsistently\b/gi, "frequently")
    .replace(/\breliably\b/gi, "frequently")
    .replace(/\bguaranteed\b/gi, "observed")
    .replace(/\bevery time\b/gi, "in observed runs");
}

// Neutralise fabricated observation-count claims in authored prose. The LLM must not
// assert numbers about the user's data in free prose; real counts live in audit/.
//   "observed in 7 runs" / "seen in 5 of 8 sessions" / "in 3 episodes" → vague phrasing.
function stripFabricatedCounts(s: string): string {
  if (!s) return s;
  return s
    .replace(/\b\d+\s+of\s+\d+\s+(runs?|sessions?|episodes?|cases?|times?)\b/gi, "some $1")
    .replace(
      /\b(observed|seen|appeared|occurred|happened|found)\s+in\s+\d+(?:\s*[-–]\s*\d+)?\s+(runs?|sessions?|episodes?|cases?|times?)\b/gi,
      "$1 in some $2"
    )
    .replace(/\bin\s+\d+\s+(runs?|sessions?|episodes?|cases?)\b/gi, "in some $1")
    .replace(/\b\d+\s*[×x]\b/gi, "multiple times")
    .replace(/\b\d+\s+(runs?|sessions?|episodes?|cases?)\b/gi, "several $1");
}

function maxFrictionCount(ev: ClusterEvidence): number {
  let m = 0;
  for (const it of [...ev.frictionPoints, ...ev.recurringFriction]) if (it.count > m) m = it.count;
  return m;
}

// Apply a pure string transform to every prose-bearing field of a step — including the
// optional depth fields — so the guard's count-stripping / de-"recurring" passes reach
// examples, sub-steps, edge cases, mistakes, and the per-stage checklist too.
function mapStepProse(s: AuthoredStep, f: (x: string) => string): AuthoredStep {
  return {
    ...s,
    detail: f(s.detail),
    how_to: f(s.how_to),
    error_handling: f(s.error_handling),
    ...(s.steps_detail ? { steps_detail: s.steps_detail.map(f) } : {}),
    ...(s.examples
      ? {
          examples: s.examples.map((e) => ({
            good: f(e.good),
            ...(e.bad ? { bad: f(e.bad) } : {}),
            ...(e.note ? { note: f(e.note) } : {}),
          })),
        }
      : {}),
    ...(s.edge_cases ? { edge_cases: s.edge_cases.map(f) } : {}),
    ...(s.common_mistakes ? { common_mistakes: s.common_mistakes.map(f) } : {}),
    ...(s.checklist ? { checklist: s.checklist.map(f) } : {}),
  };
}

// Apply a pure transform to the constraints block (if present).
function mapConstraints(
  c: { must_do: string[]; must_not: string[] } | undefined,
  f: (x: string) => string
): { must_do: string[]; must_not: string[] } | undefined {
  if (!c) return c;
  return { must_do: c.must_do.map(f), must_not: c.must_not.map(f) };
}

// Enforce honesty invariants regardless of what the LLM returned. Pure; this is the
// unit-test seam.
export function applyOverclaimGuard(authored: AuthoredSkill, ev: ClusterEvidence): AuthoredSkill {
  // Clone (no shared refs) so the guard can never mutate the caller's object.
  const out: AuthoredSkill = JSON.parse(JSON.stringify(authored));

  // Strip fabricated observation counts from ALL authored prose (workflow/how_to/
  // steps/errors/summary). Real counts only ever come from audit/ code-rendered sections.
  out.description = stripFabricatedCounts(out.description);
  out.when_to_use = stripFabricatedCounts(out.when_to_use);
  if (out.optimal_workflow) out.optimal_workflow = stripFabricatedCounts(out.optimal_workflow);
  out.success_patterns_summary = stripFabricatedCounts(out.success_patterns_summary);
  out.checklist = out.checklist.map(stripFabricatedCounts);
  out.steps = out.steps.map((s) => mapStepProse(s, stripFabricatedCounts));
  out.constraints = mapConstraints(out.constraints, stripFabricatedCounts);
  out.errors = out.errors.map((e) => ({
    error: stripFabricatedCounts(e.error),
    how_to_handle: stripFabricatedCounts(e.how_to_handle),
  }));
  out.references.success_patterns_md = stripFabricatedCounts(out.references.success_patterns_md);
  out.references.failure_modes_md = stripFabricatedCounts(out.references.failure_modes_md);
  out.references.evidence_md = stripFabricatedCounts(out.references.evidence_md);

  // Soften absolutes — restricted to success_patterns_summary + observed-data narration
  // ONLY (the evidence_md body), NOT the workflow/how_to/steps (those are expertise).
  // NOTE: the depth plan §6 listed softenAbsolutes among the passes to extend over the new
  // per-stage fields (examples/steps_detail/…); intentionally narrowed here — those fields
  // are authored expertise and keep their absolutes, matching the module's integrity model.
  if (!ev.hasStablePattern) {
    out.success_patterns_summary = softenAbsolutes(out.success_patterns_summary);
    out.references.evidence_md = softenAbsolutes(out.references.evidence_md);
  }

  // "recurring" must not label friction seen fewer than twice — across all authored prose.
  if (maxFrictionCount(ev) < 2) {
    const deRecur = (s: string) => s.replace(/\brecurring\b/gi, "observed");
    out.description = deRecur(out.description);
    out.when_to_use = deRecur(out.when_to_use);
    out.success_patterns_summary = deRecur(out.success_patterns_summary);
    if (out.optimal_workflow) out.optimal_workflow = deRecur(out.optimal_workflow);
    out.checklist = out.checklist.map(deRecur);
    out.steps = out.steps.map((s) => mapStepProse(s, deRecur));
    out.constraints = mapConstraints(out.constraints, deRecur);
    out.errors = out.errors.map((e) => ({ error: deRecur(e.error), how_to_handle: deRecur(e.how_to_handle) }));
    out.references.success_patterns_md = deRecur(out.references.success_patterns_md);
    out.references.failure_modes_md = deRecur(out.references.failure_modes_md);
    out.references.evidence_md = deRecur(out.references.evidence_md);
  }

  return out;
}

// ── Script safety scan (code backstop; flags, never gates) ─────────────────────
// EXTRA narrow signals beyond mine.ts's DESTRUCTIVE_PATTERNS. Keep these narrow so a
// benign `bun test`/build subprocess is NOT flagged.
const EXTRA_SCRIPT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "pipe-to-shell (curl|wget … | sh)"],
  [/(cat|cp|scp|less|source|\.)\s+[^\n]*(~\/\.ssh|\/\.ssh\/|\.aws\/credentials|(?:^|[\s/])\.env\b)/i, "credential-file read (.ssh/.env/.aws)"],
  [/\b(npm|pnpm|yarn|pip|pip3)\s+(install|add|i)\b/i, "arbitrary package install"],
  [/\bgit\s+(rebase|filter-branch|filter-repo)\b|\bgit\s+reset\s+--hard\b/i, "git history-rewrite (rebase/filter-branch/reset --hard)"],
];

// Scan a script body for genuinely dangerous signals. Returns a combined reason string
// (or "" if clean). Reuses mine.ts DESTRUCTIVE_PATTERNS + the local extras.
function scanScriptBody(body: string): string {
  const reasons: string[] = [];
  for (const [re, label] of DESTRUCTIVE_PATTERNS) if (re.test(body)) reasons.push(label);
  for (const [re, label] of EXTRA_SCRIPT_PATTERNS) if (re.test(body)) reasons.push(label);
  return [...new Set(reasons)].join("; ");
}

// Reject (not salvage) a raw script filename. Returns null when unsafe.
function safeScriptName(raw: string): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return null; // no path segments
  if (name.includes("..")) return null; // no traversal
  if (name.startsWith(".")) return null; // no leading dot
  if (/^[a-zA-Z]:/.test(name)) return null; // no drive letter
  if (/^[\\/]/.test(name)) return null; // no absolute path
  return name;
}

// ── Deterministic templates (LLM-free; full layout) ────────────────────────────
function steps(c: RankedCandidate): string[] {
  // Sanitize each token — dominant_pattern is written to disk (SKILL.md + run.ts).
  if (c.dominant_pattern) return c.dominant_pattern.split(">").map((s) => san(s).trim()).filter(Boolean);
  return ["explore", "edit", "verify"];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

// Sanitize a string for a markdown table cell: a redacted scalar can still contain a `|`
// or newline, either of which breaks the table — escape the pipe, fold newlines to spaces.
function cell(s: string): string {
  return san(s).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

// Clamp a trigger description to a complete-looking sentence, ≤max chars, cut on a
// sentence then word boundary (never mid-word). Backstop for the authored field.
export function clampDescription(s: string, max = 180): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sentenceEnd = t.slice(0, max + 1).search(/[.!?](\s|$)/);
  if (sentenceEnd >= 40) return t.slice(0, sentenceEnd + 1).trim();
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return clampDescription(m ? m[1] : t);
}

// Code-enforced safety gate, present in every SKILL.md regardless of LLM phrasing.
const SAFETY_NOTE = `## Safety
Only commit, push, open or merge PRs, deploy/publish, or rewrite git history when the user explicitly asks for it in the current conversation. Default to local, reversible edits and report what changed; never run these outward-facing actions as an automatic step.`;

// Format a counted evidence item line; only count>=2 may be tagged "recurring".
function countedLine(it: EvidenceItem): string {
  const tag = it.count >= 2 ? "  _(recurring)_" : "";
  return `- (${it.count}×) ${san(it.text)}${tag}`;
}

function countedList(items: EvidenceItem[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map(countedLine).join("\n");
}

// Derive the practitioner role from the recommended intervention (deterministic default
// when the LLM did not author a `role`).
function roleForIntervention(intervention: string): string {
  switch (intervention) {
    case "script":
      return "automation";
    case "sop":
      return "practitioner";
    case "skill":
    default:
      return "implementer";
  }
}

interface FrontmatterMeta {
  triggers: string[];
  domain: string;
  role: string;
  license: string;
}

// Build the frontmatter metadata: authored values when present, else deterministic
// defaults (triggers=[label], domain="software-engineering", role from intervention).
function buildFrontmatterMeta(c: RankedCandidate, a: AuthoredSkill | null): FrontmatterMeta {
  const label = san(c.label);
  const triggers = a?.triggers && a.triggers.length ? a.triggers : label ? [label] : [];
  return {
    triggers,
    domain: a?.domain || "software-engineering",
    role: a?.role || roleForIntervention(c.recommended_intervention),
    license: DRAFT_SKILL_LICENSE,
  };
}

// Publishable frontmatter (NO mined counts / strength / confidence — those move to
// audit/meta.json). `name`/`description`/`license` stay top-level (spec-shaped); the rest
// sit under `metadata:`. Every scalar is YAML-escaped; `triggers` is a block list (never
// inline `[a, b]`, which a redacted comma/quote could break).
function frontmatter(slug: string, description: string, meta: FrontmatterMeta): string {
  const triggers = meta.triggers.filter((t) => t && t.trim());
  const triggersBlock =
    triggers.length > 0 ? "\n" + triggers.map((t) => `    - ${yamlScalar(t)}`).join("\n") : " []";
  return `---
name: ${yamlScalar(slug)}
description: ${yamlScalar(description)}
license: ${yamlScalar(meta.license)}
metadata:
  version: "0.1.0"
  auto_generated: true
  domain: ${yamlScalar(meta.domain)}
  role: ${yamlScalar(meta.role)}
  triggers:${triggersBlock}
  privacy_rules_version: ${yamlScalar(PRIVACY_RULES_VERSION)}
---`;
}

// The full SKILL.md (publishable). authored=null ⇒ deterministic body; otherwise rich
// body. NO mined counts, NO Observed sections, NO ## Evidence, NO DRAFT banner.
// `refs` (when authored) is the assignStageRefs() output so links always match files.
function skillMd(
  c: RankedCandidate,
  slug: string,
  authored: AuthoredSkill | null,
  refs: { step: AuthoredStep; fileName: string }[] | null
): string {
  const label = san(c.label);

  const description = authored
    ? clampDescription(san(authored.description))
    : `Automate the recurring workflow "${label}".`;

  const header = `${frontmatter(slug, description, buildFrontmatterMeta(c, authored))}

# ${label}
`;

  if (!authored) {
    const st = steps(c);
    const risks = c.risk_flags.length ? c.risk_flags.map(san).join(", ") : "none recorded";
    const workflow = st
      .map((s, i) => `${i + 1}. **${s}** — see \`references/${stageFileName(s)}.md\`.`)
      .join("\n");
    return `${header}
## When to use
Use this skill for the recurring task "${label}".

## Workflow
${workflow}

${SAFETY_NOTE}

## Errors & handling
Common failure modes for "${label}" — see \`references/failure-modes.md\`. Risk signals: ${risks}.
`;
  }

  // Rich body — HOT PATH stays short (progressive disclosure): trigger + quick checklist +
  // a workflow table (each row links its own stage file) + constraints + safety + brief
  // errors + a closing reference-guide table. Each section is guarded for emptiness. NO
  // mined counts / no "Observed" / no `×` here — those live only under audit/.
  const a = authored;
  const refList = refs ?? assignStageRefs(a.steps);

  // ## Quick checklist (renders a.checklist — previously authored but never written).
  const quickChecklist = a.checklist.length
    ? `\n## Quick checklist\n${a.checklist.map((c) => `- [ ] ${san(c)}`).join("\n")}\n`
    : "";

  // ## Workflow — markdown table; the Reference cell keeps the backtick path link.
  const workflowSection = refList.length
    ? `| # | Step | What it does | Reference |\n| --- | --- | --- | --- |\n` +
      refList
        .map(({ step, fileName }, i) => `| ${i + 1} | ${cell(step.name)} | ${cell(step.detail)} | \`references/${fileName}\` |`)
        .join("\n")
    : "_(steps to be refined)_";

  // ## Constraints — MUST DO / MUST NOT (only the non-empty halves render).
  const cons = a.constraints;
  const constraintsSection =
    cons && (cons.must_do.length || cons.must_not.length)
      ? "\n## Constraints\n" +
        (cons.must_do.length ? `\n**MUST DO**\n${cons.must_do.map((m) => `- ${san(m)}`).join("\n")}\n` : "") +
        (cons.must_not.length ? `\n**MUST NOT**\n${cons.must_not.map((m) => `- ${san(m)}`).join("\n")}\n` : "")
      : "";

  const HOT_ERRORS = 3;
  const errorsBrief =
    a.errors.length === 0
      ? "_See `references/failure-modes.md` for common failure modes and handling._"
      : a.errors
          .slice(0, HOT_ERRORS)
          .map((e) => `- **${san(e.error)}** → ${san(e.how_to_handle)}`)
          .join("\n") +
        (a.errors.length > HOT_ERRORS
          ? `\n- _…${a.errors.length - HOT_ERRORS} more in \`references/failure-modes.md\`._`
          : "");

  // ## Reference guide — one row per stage file + the two fixed authored references.
  const refGuideRows = [
    ...refList.map(({ step, fileName }) => `| \`references/${fileName}\` | ${cell(step.name)}${step.detail ? ` — ${cell(step.detail)}` : ""} |`),
    "| `references/success-patterns.md` | Recommended workflow, examples, and rationale |",
    "| `references/failure-modes.md` | Common failure modes and how to handle them |",
  ];
  const referenceGuide = `## Reference guide\n| Reference | Read when |\n| --- | --- |\n${refGuideRows.join("\n")}`;

  return `${header}
## When to use
${san(a.when_to_use)}
${quickChecklist}
## Workflow
${workflowSection}

_Each step has full how-to, inputs, and error handling in its \`references/\` file._
${constraintsSection}
${SAFETY_NOTE}

## Errors & handling
${errorsBrief}

See \`references/failure-modes.md\` for the full list.

${referenceGuide}
`;
}

// ── Per-stage reference bodies (skill/references/<stage>.md) ───────────────────
// Choose a fence longer than any backtick run in the body, so an authored example that
// itself contains ``` (LLM code examples often do) can't prematurely close the block.
function fenceFor(body: string): string {
  let max = 0;
  for (const m of body.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

// Render one good-vs-bad example. Multi-line bodies are fenced; single lines are bullets.
function renderExample(ex: AuthoredExample): string[] {
  const out: string[] = [];
  const multi = (s: string) => s.includes("\n");
  const good = san(ex.good);
  if (multi(good)) {
    const f = fenceFor(good);
    out.push("**✅ Good**", "", f, good, f, "");
  } else out.push(`- **✅ Good:** ${good}`);
  if (ex.bad) {
    const bad = san(ex.bad);
    if (multi(bad)) {
      const f = fenceFor(bad);
      out.push("**❌ Bad**", "", f, bad, f, "");
    } else out.push(`- **❌ Bad:** ${bad}`);
  }
  if (ex.note) out.push(`- _Note: ${san(ex.note)}_`);
  return out;
}

// Rich: one multi-section file body per authored stage. Each section is emitted only when
// its field is present, so a thin step still renders cleanly (how-to / inputs / ask-user /
// web / errors / script) and a deep step gets How-to / Examples / Edge cases / Common
// mistakes / Checklist on top.
export function richStageRef(step: AuthoredStep): string {
  const out: string[] = [`# ${san(step.name) || "Stage"}`, ""];
  const intro = san(step.how_to) || san(step.detail);
  if (intro) out.push(intro);

  const stepsDetail = (step.steps_detail ?? []).filter(Boolean);
  if (stepsDetail.length) {
    out.push("", "## How to do it", "");
    stepsDetail.forEach((s, i) => out.push(`${i + 1}. ${san(s)}`));
  }

  const examples = (step.examples ?? []).filter((e) => e && e.good);
  if (examples.length) {
    out.push("", "## Examples", "");
    examples.forEach((ex, i) => {
      if (i > 0) out.push("");
      out.push(...renderExample(ex));
    });
  }

  const edge = (step.edge_cases ?? []).filter(Boolean);
  if (edge.length) {
    out.push("", "## Edge cases", "");
    for (const e of edge) out.push(`- ${san(e)}`);
  }

  const mistakes = (step.common_mistakes ?? []).filter(Boolean);
  if (mistakes.length) {
    out.push("", "## Common mistakes", "");
    for (const m of mistakes) out.push(`- ${san(m)}`);
  }

  if (step.inputs_needed.length) {
    out.push("", "## Inputs needed", "");
    for (const i of step.inputs_needed) out.push(`- ${san(i)}`);
  }

  if (step.ask_user) out.push("", "## When to ask the user", "", san(step.ask_user));
  if (step.web_search) out.push("", "## When to search the web", "", san(step.web_search));
  if (step.error_handling) out.push("", "## Error handling", "", san(step.error_handling));

  if (step.script) {
    out.push("", "## Script", "", `\`scripts/${san(step.script.filename)}\` — ${san(step.script.purpose)}`);
  }

  const checklist = (step.checklist ?? []).filter(Boolean);
  if (checklist.length) {
    out.push("", "## Checklist", "");
    for (const c of checklist) out.push(`- [ ] ${san(c)}`);
  }

  return out.join("\n") + "\n";
}

// Deterministic stub body for one stage (candidate-only; no DB). Section-skeleton with
// honest placeholders so even an LLM-free / fallback draft isn't a 3-line stub.
function detStageRef(stepName: string): string {
  const name = san(stepName) || "Stage";
  const authoredWhen = "_Authored when DB evidence is available._";
  return `# ${name}

_Deterministic scaffold for the "${name}" stage. The sections below are authored when DB evidence is available._

## How to do it
${authoredWhen}

## Examples
${authoredWhen}

## Edge cases
${authoredWhen}

## Common mistakes
${authoredWhen}

## Error handling
${authoredWhen}

## Checklist
${authoredWhen}
`;
}

// ── Authored skill/references content (NO mined counts) ────────────────────────
export function richSuccessRef(a: AuthoredSkill, ev: ClusterEvidence): string {
  const workflowProse = a.optimal_workflow ? san(a.optimal_workflow) : "_(no workflow synthesis authored)_";
  return `# Success patterns — ${ev.label}

## Recommended workflow
${workflowProse}

## What worked
${san(a.success_patterns_summary) || "_(none synthesized)_"}

${san(a.references.success_patterns_md) || ""}
`;
}

function richFailureRef(a: AuthoredSkill, ev: ClusterEvidence): string {
  const errorsBody =
    a.errors.length === 0
      ? "_(no errors authored)_"
      : a.errors.map((e) => `### ${san(e.error)}\n${san(e.how_to_handle)}`).join("\n\n");
  return `# Failure modes & handling — ${ev.label}

${san(a.references.failure_modes_md) || "_(no authored body)_"}

## Errors & handling
${errorsBody}
`;
}

// Deterministic skill/references fixed files (candidate-only; no counts).
function detSuccessRef(c: RankedCandidate): string {
  return `# Success patterns — ${san(c.label)}

Workflow stages: \`${san(c.dominant_pattern ?? "explore>edit>verify")}\`.

_Deterministic scaffold. A richer, LLM-authored success synthesis is written when DB evidence is available._
`;
}

function detFailureRef(c: RankedCandidate): string {
  const risks = c.risk_flags.length ? c.risk_flags.map((f) => `- ${san(f)}`).join("\n") : "_none recorded_";
  return `# Failure modes & handling — ${san(c.label)}

Risk signals from the miner:
${risks}

_Deterministic scaffold. The common errors + handling are authored when DB evidence is available._
`;
}

// ── audit/ content (mined, code-rendered, NEVER published) ─────────────────────
// Rich observed counts (the countedList sections moved out of the published skill).
function richObservedRef(ev: ClusterEvidence): string {
  return `# Observed in your sessions — ${ev.label}

_Code-rendered from mined episode labels. Counts = observation frequency; the published workflow is LLM-authored best practice and does not depend on these._

## Observed success workflows
${countedList(ev.successWorkflows, "no success workflows recorded")}

## Observed good practices
${countedList(ev.goodPractices, "no good practices recorded")}

## Observed friction
${countedList(ev.recurringFriction.length ? ev.recurringFriction : ev.frictionPoints, "no friction recorded")}

## Observed root causes
${countedList(ev.rootCauses, "no root causes recorded")}
`;
}

function richEvidenceRef(a: AuthoredSkill, ev: ClusterEvidence): string {
  return `# Evidence — ${ev.label}

> Provenance: the workflow under \`skill/\` is LLM-authored best practice; the counts
> below are mined from ${ev.nJudged} judged episode(s) and are advisory only.

${san(a.references.evidence_md) || ""}

---
### Tallies
- frequency: ${ev.frequency}
- sessions: ${ev.nSessions}
- success_rate: ${pct(ev.successRate)}
- n_judged: ${ev.nJudged}
- success_episodes: ${ev.nSuccessEpisodes} · failure_episodes: ${ev.nFailureEpisodes}
- evidence_strength: ${ev.evidenceStrength}
- has_stable_pattern: ${ev.hasStablePattern}
- low_confidence: ${ev.lowConfidence}
- privacy_rules_version: ${PRIVACY_RULES_VERSION}
${ev.businessNote ? `- business note: ${san(ev.businessNote)}` : ""}
`;
}

function detObservedRef(c: RankedCandidate): string {
  return `# Observed in your sessions — ${san(c.label)}

_No DB evidence available for this draft (deterministic path). Observed counts are written when the analysis DB is present._
`;
}

function detEvidenceRef(c: RankedCandidate): string {
  return `# Evidence — ${san(c.label)}

> Provenance: the workflow under \`skill/\` is LLM-authored / deterministic best practice;
> the counts below are mined and advisory only.

- frequency: ${c.frequency}
- sessions: ${c.n_sessions}
- success_rate: ${pct(c.success_rate)}
- n_judged: ${c.n_judged ?? 0}
- evidence_strength: ${candidateEvidenceStrength(c)}
- low_confidence: ${c.low_confidence ? "YES — treat as a lead" : "no"}
- recommended_intervention: ${san(c.recommended_intervention)}
${c.business_note ? `- business note (sidecar): ${san(c.business_note)}` : ""}

_No DB evidence available (deterministic path)._
`;
}

// ── audit/ scaffold (test harness; NOT part of the skill) ──────────────────────
function runTs(c: RankedCandidate): string {
  const st = steps(c);
  return `// SCAFFOLD runner for the drafted skill's self-eval (audit/, NOT part of the skill).
// TODO(skill-owner): implement the real actions. This skeleton keeps the test runnable.
// The published workflow lives in ../../skill/SKILL.md + ../../skill/references/, not here.

export const STEPS = ${JSON.stringify(st)} as const;
export const SKILL_LABEL = ${JSON.stringify(san(c.label))};

export function plan(_context: Record<string, unknown> = {}) {
  return { skill: SKILL_LABEL, steps: [...STEPS], status: "draft" as const };
}

export function run(context: Record<string, unknown> = {}) {
  const p = plan(context);
  return { skill: SKILL_LABEL, executed: p.steps, ok: true, nSteps: p.steps.length };
}
`;
}

// Lives at audit/tests/skill.test.ts. Relative paths walk up to audit/ then over to skill/.
function testTs(): string {
  return `// E2E + unit test for the drafted skill (bun test). Proves the scaffold works.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { plan, run, STEPS } from "../scripts/run.ts";

const AUDIT = join(import.meta.dir, "..");

test("plan returns the observed steps", () => {
  expect(plan({}).steps).toEqual([...STEPS]);
});

test("run completes ok over all steps", () => {
  const out = run({});
  expect(out.ok).toBe(true);
  expect(out.nSteps).toBe(STEPS.length);
});

test("SKILL.md has valid frontmatter", () => {
  const md = readFileSync(join(AUDIT, "..", "skill", "SKILL.md"), "utf8");
  expect(md.startsWith("---")).toBe(true);
  for (const k of ["name:", "description:", "version:"]) expect(md.includes(k)).toBe(true);
});

test("all golden cases run ok (e2e)", () => {
  const cases = JSON.parse(readFileSync(join(AUDIT, "golden_cases.json"), "utf8"));
  expect(Array.isArray(cases) && cases.length > 0).toBe(true);
  for (const c of cases) expect(run(c.input ?? {}).ok).toBe(true);
});
`;
}

function goldenJson(c: RankedCandidate): string {
  const cases = [
    { name: `golden: typical "${san(c.label)}" task`, input: {}, expect_ok: true },
    { name: `golden: ${san(c.dominant_pattern ?? "default")} pattern`, input: {}, expect_ok: true },
  ];
  return JSON.stringify(cases, null, 2);
}

// audit/meta.json — tool metadata + manifest + flagged scripts + metrics.
function metaJson(
  c: RankedCandidate,
  slug: string,
  authored: boolean,
  generatedStageRefs: string[],
  flaggedScripts: { file: string; reason: string }[]
): string {
  return JSON.stringify(
    {
      slug,
      cluster_id: c.cluster_id,
      label: san(c.label),
      recommended_intervention: san(c.recommended_intervention),
      success_rate: c.success_rate,
      frequency: c.frequency,
      n_judged: c.n_judged ?? 0,
      low_confidence: c.low_confidence ?? false,
      evidence_strength: candidateEvidenceStrength(c),
      confidence: c.low_confidence ? "low" : "high",
      privacy_rules_version: PRIVACY_RULES_VERSION,
      authored,
      generated_stage_refs: generatedStageRefs,
      flagged_scripts: flaggedScripts,
    },
    null,
    2
  );
}

// Read the prior generated_stage_refs manifest from audit/meta.json (for cleanup).
function readManifest(dir: string): string[] {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "audit", "meta.json"), "utf8"));
    return Array.isArray(meta.generated_stage_refs) ? meta.generated_stage_refs : [];
  } catch {
    return [];
  }
}

// ── draftSkill — sync, deterministic, single source of truth for the layout ────
export function draftSkill(c: RankedCandidate, outRoot: string, allow: boolean): string {
  if (!allow) throw new DraftGateError("Skill draft must be opted in explicitly (--yes).");
  if (!isDraftable(c)) {
    throw new DraftGateError(
      `Candidate "${c.label}" intervention is "${c.recommended_intervention}" — not draftable.`
    );
  }
  const slug = slugify(c.label);
  const dir = join(outRoot, slug);
  const skillDir = join(dir, "skill");
  const auditDir = join(dir, "audit");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(auditDir, "scripts"), { recursive: true });
  mkdirSync(join(auditDir, "tests"), { recursive: true });

  // skill/ (publishable)
  writeFileSync(join(skillDir, "SKILL.md"), skillMd(c, slug, null, null), "utf8");
  writeFileSync(join(skillDir, "references", "success-patterns.md"), detSuccessRef(c), "utf8");
  writeFileSync(join(skillDir, "references", "failure-modes.md"), detFailureRef(c), "utf8");
  // Capture the PRIOR manifest before the meta.json write below clobbers it — needed so
  // a re-draft can clean stage refs left by an EARLIER run (esp. a prior RICH run, whose
  // authored stage filenames differ from these deterministic stubs). Manifest-driven:
  // FIXED_REFS and human-added files are never listed, so they always survive.
  const priorManifest = readManifest(dir);

  // One stub per dominant-pattern stage; record the generated filenames in the manifest.
  const generatedStageRefs: string[] = [];
  const seen = new Set<string>();
  for (const st of steps(c)) {
    let fname = stageFileName(st) + ".md";
    let n = 2;
    while (seen.has(fname)) fname = stageFileName(st) + `_${n++}` + ".md";
    seen.add(fname);
    writeFileSync(join(skillDir, "references", fname), detStageRef(st), "utf8");
    generatedStageRefs.push(fname);
  }
  // Remove prior generated stage refs this run did NOT regenerate (e.g. a prior rich run's
  // authored files) so they can't linger as orphaned, unlinked-but-published files. Never
  // touch FIXED_REFS or anything this run just wrote.
  for (const f of priorManifest) {
    if ((FIXED_REFS as readonly string[]).includes(f) || generatedStageRefs.includes(f)) continue;
    const p = join(skillDir, "references", f);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // audit/ (never published)
  writeFileSync(join(auditDir, "observed.md"), detObservedRef(c), "utf8");
  writeFileSync(join(auditDir, "evidence.md"), detEvidenceRef(c), "utf8");
  writeFileSync(join(auditDir, "golden_cases.json"), goldenJson(c), "utf8");
  writeFileSync(join(auditDir, "scripts", "run.ts"), runTs(c), "utf8");
  writeFileSync(join(auditDir, "tests", "skill.test.ts"), testTs(), "utf8");
  writeFileSync(join(auditDir, "meta.json"), metaJson(c, slug, false, generatedStageRefs, []), "utf8");
  return dir;
}

// Shared write path for the rich (authored) draft — used by both the live LLM path and
// the LLM-free test seam. `dir` is the deterministic draft dir (already laid down).
export function writeRichDraft(
  c: RankedCandidate,
  ev: ClusterEvidence,
  authoredRaw: AuthoredSkill,
  dir: string
): { dir: string; authored: true } {
  // Code gate BEFORE write, then a defense-in-depth sanitize pass on every field.
  const guarded = applyOverclaimGuard(authoredRaw, ev);
  const authored = sanitizeAuthored(guarded);

  const slug = slugify(c.label);
  const skillDir = join(dir, "skill");
  const auditDir = join(dir, "audit");
  const refsDir = join(skillDir, "references");
  const scriptsDir = join(skillDir, "scripts");

  // Manifest-driven cleanup: delete ONLY the prior generated per-stage stubs (never a
  // blanket references/*.md wipe — a human-added skill/references/my-notes.md survives,
  // and FIXED_REFS are never in the manifest).
  for (const f of readManifest(dir)) {
    if ((FIXED_REFS as readonly string[]).includes(f)) continue;
    const p = join(refsDir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // Assign stage filenames ONCE; both SKILL.md links and the file writers consume it.
  const refs = assignStageRefs(authored.steps);

  // Write authored scripts → skill/scripts/ (reject-filename + safety scan). Record the
  // skill-relative filename back onto the step so the stage file links it correctly.
  const flaggedScripts: { file: string; reason: string }[] = [];
  for (const { step } of refs) {
    if (!step.script) continue;
    const safeName = safeScriptName(step.script.filename);
    if (!safeName) {
      console.error(`[draft] rejected unsafe script filename "${step.script.filename}" — skipping.`);
      delete step.script; // drop the link so the stage file won't reference a missing file
      continue;
    }
    const target = resolve(scriptsDir, safeName);
    if (!(target === scriptsDir || target.startsWith(scriptsDir + sep))) {
      console.error(`[draft] script "${safeName}" resolves outside skill/scripts — skipping.`);
      delete step.script;
      continue;
    }
    step.script.filename = safeName;
    let body = san(step.script.body); // secrets never hit disk
    const reason = scanScriptBody(body);
    if (reason) {
      body = `# ⚠️ UNVETTED — flagged: ${reason}; review before running\n` + body;
      flaggedScripts.push({ file: safeName, reason });
    }
    writeFileSync(target, body, "utf8");
  }

  // skill/ — authored content, NO mined counts.
  writeFileSync(join(skillDir, "SKILL.md"), skillMd(c, slug, authored, refs), "utf8");
  writeFileSync(join(refsDir, "success-patterns.md"), richSuccessRef(authored, ev), "utf8");
  writeFileSync(join(refsDir, "failure-modes.md"), richFailureRef(authored, ev), "utf8");
  const generatedStageRefs: string[] = [];
  for (const { step, fileName } of refs) {
    writeFileSync(join(refsDir, fileName), richStageRef(step), "utf8");
    generatedStageRefs.push(fileName);
  }

  // audit/ — mined, code-rendered.
  writeFileSync(join(auditDir, "observed.md"), richObservedRef(ev), "utf8");
  writeFileSync(join(auditDir, "evidence.md"), richEvidenceRef(authored, ev), "utf8");
  writeFileSync(join(auditDir, "meta.json"), metaJson(c, slug, true, generatedStageRefs, flaggedScripts), "utf8");
  return { dir, authored: true };
}

// ── draftSkillRich — lay down deterministic layout, then overwrite rich files ──
export async function draftSkillRich(
  c: RankedCandidate,
  db: Database,
  outRoot: string,
  allow: boolean,
  opts: { contrast?: ClusterContrast; model?: string; timeoutMs?: number; authorOverride?: AuthoredSkill }
): Promise<{ dir: string; authored: boolean }> {
  // 1. Full deterministic structure first — layout can never diverge.
  const dir = draftSkill(c, outRoot, allow);

  // 2. Build (sanitized, bounded) evidence and author rich content (or use the override).
  const ev = buildClusterEvidence(db, c, opts.contrast);
  const authoredRaw =
    opts.authorOverride ?? (await authorSkillContent(ev, { model: opts.model, timeoutMs: opts.timeoutMs }));
  if (!authoredRaw) return { dir, authored: false }; // skip overwrite → deterministic stands

  // 3. Guard + sanitize + write (shared seam).
  return writeRichDraft(c, ev, authoredRaw, dir);
}

// Defense-in-depth: sanitize every string field of an authored skill once more,
// including the new per-step depth fields, metadata, constraints, and any
// script.{filename,purpose,body}. Every string written to disk passes through here.
function sanitizeAuthored(a: AuthoredSkill): AuthoredSkill {
  return {
    description: san(a.description),
    when_to_use: san(a.when_to_use),
    optimal_workflow: a.optimal_workflow == null ? null : san(a.optimal_workflow),
    checklist: a.checklist.map(san),
    steps: a.steps.map((s) => ({
      name: san(s.name),
      detail: san(s.detail),
      how_to: san(s.how_to),
      inputs_needed: s.inputs_needed.map(san),
      ask_user: san(s.ask_user),
      web_search: san(s.web_search),
      error_handling: san(s.error_handling),
      ...(s.steps_detail ? { steps_detail: s.steps_detail.map(san) } : {}),
      ...(s.examples
        ? {
            examples: s.examples.map((e) => ({
              good: san(e.good),
              ...(e.bad ? { bad: san(e.bad) } : {}),
              ...(e.note ? { note: san(e.note) } : {}),
            })),
          }
        : {}),
      ...(s.edge_cases ? { edge_cases: s.edge_cases.map(san) } : {}),
      ...(s.common_mistakes ? { common_mistakes: s.common_mistakes.map(san) } : {}),
      ...(s.checklist ? { checklist: s.checklist.map(san) } : {}),
      ...(s.script
        ? {
            script: {
              filename: san(s.script.filename),
              language: san(s.script.language),
              purpose: san(s.script.purpose),
              body: san(s.script.body),
            },
          }
        : {}),
    })),
    errors: a.errors.map((e) => ({ error: san(e.error), how_to_handle: san(e.how_to_handle) })),
    success_patterns_summary: san(a.success_patterns_summary),
    ...(a.triggers ? { triggers: a.triggers.map(san) } : {}),
    ...(a.domain ? { domain: san(a.domain) } : {}),
    ...(a.role ? { role: san(a.role) } : {}),
    ...(a.constraints
      ? { constraints: { must_do: a.constraints.must_do.map(san), must_not: a.constraints.must_not.map(san) } }
      : {}),
    references: {
      success_patterns_md: san(a.references.success_patterns_md),
      failure_modes_md: san(a.references.failure_modes_md),
      evidence_md: san(a.references.evidence_md),
    },
  };
}

// ── selfEval — run the drafted skill's own bun test suite (under audit/tests) ──
export async function selfEval(
  draftDir: string
): Promise<{ passed: boolean; nTests: number; tail: string[] }> {
  const proc = Bun.spawn(["bun", "test", join(draftDir, "audit", "tests")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const text = out + err;
  const m = text.match(/(\d+)\s+pass/);
  const nTests = m ? Number(m[1]) : 0;
  return { passed: code === 0, nTests, tail: text.trim().split("\n").slice(-3) };
}

// ── Orchestration: read candidates.json → draft each ───────────────────────────
export async function draftFromCandidates(
  candidatesPath: string,
  outRoot: string,
  allow: boolean,
  opts: { top?: number; llm?: boolean; db?: string } = {}
): Promise<DraftResult[]> {
  const top = opts.top ?? 0;
  const llm = opts.llm !== false; // default: attempt the rich path when a DB exists
  const data = JSON.parse(readFileSync(candidatesPath, "utf8"));
  let cands: RankedCandidate[] = Array.isArray(data?.candidates) ? data.candidates : [];
  const contrasts: Record<string, ClusterContrast> =
    data?.contrasts && typeof data.contrasts === "object" ? data.contrasts : {};
  cands = cands.filter(isDraftable);
  if (top > 0) cands = cands.slice(0, top);

  // DB availability — NEVER call openDb() to probe (it creates+migrates an empty DB).
  let db: Database | null = null;
  if (llm) {
    const dbPath = opts.db ?? DEFAULT_DB_PATH;
    if (existsSync(dbPath)) {
      db = openDb(dbPath);
    } else {
      console.error(
        `[draft] no DB at ${dbPath} — using the deterministic path (no LLM authoring).`
      );
    }
  }

  // Estimate the LLM-call budget for the rich path (1–2 calls per candidate).
  if (db) {
    const n = cands.length;
    console.error(`[draft] rich path: ~${n}–${n * 2} LLM call(s) across ${n} candidate(s).`);
  }

  const results: DraftResult[] = [];
  try {
    for (const c of cands) {
      const slug = slugify(c.label);
      let dir: string;
      let authored = false;
      if (db) {
        const members = getClusterMembers(db, c.cluster_id);
        if (members.length === 0) {
          console.error(
            `[draft] cluster "${c.cluster_id}" missing from task_clusters (stale candidates.json) — deterministic fallback for "${slug}".`
          );
          dir = draftSkill(c, outRoot, allow);
        } else {
          const r = await draftSkillRich(c, db, outRoot, allow, {
            contrast: contrasts[c.cluster_id],
          });
          dir = r.dir;
          authored = r.authored;
        }
      } else {
        dir = draftSkill(c, outRoot, allow);
      }
      const ev = await selfEval(dir);
      results.push({ slug, dir, authored, selfEval: ev });
    }
  } finally {
    db?.close();
  }
  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Usage: bun run src/skilldraft.ts [--candidates <path>] [--top N] [--no-llm] [--db <path>] --yes
if (import.meta.main) {
  const args = process.argv.slice(2);
  let candidatesPath = DEFAULT_CANDIDATES;
  let top = 0;
  let yes = false;
  let llm = true;
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--candidates") candidatesPath = args[++i] ?? candidatesPath;
    else if (args[i] === "--top") top = Number(args[++i]);
    else if (args[i] === "--yes") yes = true;
    else if (args[i] === "--no-llm") llm = false;
    else if (args[i] === "--db") dbPath = args[++i];
  }
  if (!yes) {
    console.error(
      "[draft] Creates complete skills in out/skill_drafts (skill/ to publish + audit/ provenance), " +
        "never auto-published. Add --yes to opt in. Rich (LLM-authored) layout unless --no-llm."
    );
    process.exit(2);
  }
  try {
    const results = await draftFromCandidates(candidatesPath, DEFAULT_OUT_ROOT, true, {
      top,
      llm,
      db: dbPath,
    });
    if (results.length === 0) {
      console.log("[draft] no draftable candidates (none with intervention skill|script|sop).");
    } else {
      console.log(`[draft] drafted ${results.length} skill(s) into out/skill_drafts:`);
      for (const r of results) {
        console.log(
          `  - ${r.slug.padEnd(34)} ${(r.authored ? "rich" : "scaffold").padEnd(8)} self-eval: ${
            r.selfEval.passed ? "PASS" : "FAIL"
          } (${r.selfEval.nTests} tests)`
        );
      }
      console.log("[draft] publish a skill by copying its <slug>/skill/ folder; audit/ stays internal.");
    }
  } catch (e) {
    console.error(`[draft] ${(e as Error).message}`);
    process.exit(1);
  }
}
