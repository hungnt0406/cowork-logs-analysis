// skilldraft.ts — Skill draft + E2E test scaffold (merged from cowork-behavior-harness P2).
//
// This is the phase AFTER the Go/Kill gate. The base miner deliberately STOPS at
// candidates.json; this module turns a GO candidate into a reviewable skill draft —
// but it is gated and never publishes:
//   * opt-in only (--yes); refuses otherwise,
//   * only candidates whose recommended_intervention is skill|script|sop,
//   * writes to a REVIEW QUEUE (out/skill_drafts/<slug>/), never to a live skills dir,
//   * every draft ships a runnable `bun test` suite + REVIEW.md checklist,
//   * self-eval runs that suite so a draft proves its SCAFFOLD compiles and runs before
//     a human reviews it (the generated golden cases are placeholders — a PASS means the
//     scaffold is wired correctly, NOT that the workflow logic is validated).
//
// Skill structure follows principle: deterministic steps = script,
// reasoning = (left to the author) llm, guard = hooks noted in REVIEW.md.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { RankedCandidate } from "./types.ts";

const DEFAULT_OUT_ROOT = join(import.meta.dir, "..", "out", "skill_drafts");
const DEFAULT_CANDIDATES = join(import.meta.dir, "..", "out", "candidates.json");

export class DraftGateError extends Error {}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "skill"
  );
}

// Gate predicate: a candidate is draftable only if the miner recommended a concrete
// intervention. (low_confidence candidates are allowed through but flagged in REVIEW.)
export function isDraftable(c: RankedCandidate): boolean {
  return c.recommended_intervention === "skill" || c.recommended_intervention === "script" || c.recommended_intervention === "sop";
}

export interface DraftResult {
  slug: string;
  dir: string;
  selfEval: { passed: boolean; nTests: number; tail: string[] };
}

export function draftSkill(c: RankedCandidate, outRoot: string, allow: boolean): string {
  if (!allow) throw new DraftGateError("Skill draft must be opted in explicitly (--yes).");
  if (!isDraftable(c)) {
    throw new DraftGateError(`Candidate "${c.label}" intervention is "${c.recommended_intervention}" — not draftable.`);
  }
  const slug = slugify(c.label);
  const dir = join(outRoot, slug);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });

  writeFileSync(join(dir, "SKILL.md"), skillMd(c, slug), "utf8");
  writeFileSync(join(dir, "scripts", "run.ts"), runTs(c), "utf8");
  writeFileSync(join(dir, "tests", "skill.test.ts"), testTs(), "utf8");
  writeFileSync(join(dir, "golden_cases.json"), goldenJson(c), "utf8");
  writeFileSync(join(dir, "REVIEW.md"), reviewMd(c, slug), "utf8");
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        slug,
        cluster_id: c.cluster_id,
        label: c.label,
        recommended_intervention: c.recommended_intervention,
        success_rate: c.success_rate,
        frequency: c.frequency,
        low_confidence: c.low_confidence ?? false,
        status: "DRAFT-PENDING-REVIEW",
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

// Run the drafted skill's own bun test suite — proves it works before human review.
export async function selfEval(skillDir: string): Promise<{ passed: boolean; nTests: number; tail: string[] }> {
  const proc = Bun.spawn(["bun", "test", join(skillDir, "tests")], { stdout: "pipe", stderr: "pipe" });
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

export async function draftFromCandidates(
  candidatesPath: string,
  outRoot: string,
  allow: boolean,
  top = 0
): Promise<DraftResult[]> {
  const data = JSON.parse(readFileSync(candidatesPath, "utf8"));
  let cands: RankedCandidate[] = Array.isArray(data?.candidates) ? data.candidates : [];
  cands = cands.filter(isDraftable);
  if (top > 0) cands = cands.slice(0, top);
  const results: DraftResult[] = [];
  for (const c of cands) {
    const dir = draftSkill(c, outRoot, allow);
    const ev = await selfEval(dir);
    results.push({ slug: slugify(c.label), dir, selfEval: ev });
  }
  return results;
}

// ── templates ─────────────────────────────────────────────────────────────────
function steps(c: RankedCandidate): string[] {
  if (c.dominant_pattern) return c.dominant_pattern.split(">").map((s) => s.trim()).filter(Boolean);
  return ["explore", "edit", "verify"];
}

function skillMd(c: RankedCandidate, slug: string): string {
  const st = steps(c);
  const hooks = c.risk_flags.length ? c.risk_flags.map((f) => `confirm before: ${f}`).join("; ") : "(none)";
  return `---
name: ${slug}
description: >-
  [VI] Tu dong hoa quy trinh "${c.label}" (quan sat ${c.frequency} lan, success ${(c.success_rate * 100).toFixed(0)}%).
  [EN] Automate the recurring workflow "${c.label}".
version: 0.1.0
status: DRAFT
recommended_intervention: ${c.recommended_intervention}
auto_generated: true
review_required: true
---

# Skill (DRAFT): ${c.label}

> ⚠️ Auto-drafted from a mined workflow candidate. NOT reviewed, NOT published.
> Skill-owner must complete REVIEW.md before this leaves the review queue.

## When to use (trigger)
Recurs ${c.frequency} times across ${c.n_sessions} session(s); dominant success pattern: \`${c.dominant_pattern ?? "n/a"}\`.

## How — 3 layers
1. **Deterministic (script)** — \`scripts/run.ts\`: steps ${JSON.stringify(st)}
2. **Heuristic (LLM judgement)** — author fills in where the steps need judgement.
3. **Hook (guard at contact points)** — ${hooks}

## Effectiveness
See \`tests/\` (unit + e2e + golden) and the self-eval result in REVIEW.md.
`;
}

function runTs(c: RankedCandidate): string {
  const st = steps(c);
  return `// SCAFFOLD runner for the drafted skill. Deterministic steps = script
// TODO(skill-owner): implement the real actions. This skeleton keeps tests runnable.

export const STEPS = ${JSON.stringify(st)} as const;
export const SKILL_LABEL = ${JSON.stringify(c.label)};

export function plan(_context: Record<string, unknown> = {}) {
  return { skill: SKILL_LABEL, steps: [...STEPS], status: "draft" as const };
}

export function run(context: Record<string, unknown> = {}) {
  const p = plan(context);
  return { skill: SKILL_LABEL, executed: p.steps, ok: true, nSteps: p.steps.length };
}
`;
}

function testTs(): string {
  return `// E2E + unit test for the drafted skill (bun test). Proves the scaffold works.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { plan, run, STEPS } from "../scripts/run.ts";

const HERE = join(import.meta.dir, "..");

test("plan returns the observed steps", () => {
  expect(plan({}).steps).toEqual([...STEPS]);
});

test("run completes ok over all steps", () => {
  const out = run({});
  expect(out.ok).toBe(true);
  expect(out.nSteps).toBe(STEPS.length);
});

test("SKILL.md has valid frontmatter", () => {
  const md = readFileSync(join(HERE, "SKILL.md"), "utf8");
  expect(md.startsWith("---")).toBe(true);
  for (const k of ["name:", "description:", "version:"]) expect(md.includes(k)).toBe(true);
});

test("all golden cases run ok (e2e)", () => {
  const cases = JSON.parse(readFileSync(join(HERE, "golden_cases.json"), "utf8"));
  expect(Array.isArray(cases) && cases.length > 0).toBe(true);
  for (const c of cases) expect(run(c.input ?? {}).ok).toBe(true);
});
`;
}

function goldenJson(c: RankedCandidate): string {
  const cases = [
    { name: `golden: typical "${c.label}" task`, input: {}, expect_ok: true },
    { name: `golden: ${c.dominant_pattern ?? "default"} pattern`, input: {}, expect_ok: true },
  ];
  return JSON.stringify(cases, null, 2);
}

function reviewMd(c: RankedCandidate, slug: string): string {
  return `# REVIEW — ${c.label} (\`${slug}\`)

Status: **DRAFT-PENDING-REVIEW** · skill-owner sign-off required.

## Checklist (human-in-the-loop)
- [ ] Business-correct (no harm when automated)
- [ ] Trigger description does not collide with other skills
- [ ] No sensitive data embedded
- [ ] Write/delete ops gated by a confirm hook
- [ ] Self-eval (bun test) PASSES

## Evidence (behaviour-only, from the miner)
- frequency: ${c.frequency} · sessions: ${c.n_sessions} · success_rate: ${(c.success_rate * 100).toFixed(0)}%
- dominant pattern: \`${c.dominant_pattern ?? "n/a"}\`
- recommended intervention: ${c.recommended_intervention}
- risk flags: ${c.risk_flags.length ? c.risk_flags.join(", ") : "none"}
- low confidence: ${c.low_confidence ? "YES — treat as a lead, not a statistic" : "no"}
${c.business_note ? `- business note (sidecar): ${c.business_note}` : ""}

## Decision
- [ ] Approve → a human moves it into the real skills repo
- [ ] Request changes
- [ ] Reject
`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Usage: bun run src/skilldraft.ts [--candidates out/candidates.json] [--top N] --yes
if (import.meta.main) {
  const args = process.argv.slice(2);
  let candidatesPath = DEFAULT_CANDIDATES;
  let top = 0;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--candidates") candidatesPath = args[++i] ?? candidatesPath;
    else if (args[i] === "--top") top = Number(args[++i]);
    else if (args[i] === "--yes") yes = true;
  }
  if (!yes) {
    console.error(
      "[draft] Creates SKILL.md drafts in a REVIEW QUEUE (out/skill_drafts), never published. " +
        "Add --yes to opt in."
    );
    process.exit(2);
  }
  try {
    const results = await draftFromCandidates(candidatesPath, DEFAULT_OUT_ROOT, true, top);
    if (results.length === 0) {
      console.log("[draft] no draftable candidates (none with intervention skill|script|sop).");
    } else {
      console.log(`[draft] drafted ${results.length} skill(s) into out/skill_drafts (review queue):`);
      for (const r of results) {
        console.log(`  - ${r.slug.padEnd(36)} self-eval: ${r.selfEval.passed ? "PASS" : "FAIL"} (${r.selfEval.nTests} tests)`);
      }
      console.log("[draft] each is DRAFT-PENDING-REVIEW (see REVIEW.md).");
    }
  } catch (e) {
    console.error(`[draft] ${(e as Error).message}`);
    process.exit(1);
  }
}
