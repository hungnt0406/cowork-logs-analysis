// Tests for the merged shell (privacy gate, convergence, skill-draft gate).
// All tests are LLM-FREE — they exercise sync/pure seams; never call Claude.
// Run: bun test src/merge.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sanitizeText, isExcludedSession, filterExcluded } from "./privacy.ts";
import { converge } from "./converge.ts";
import { extractJsonObject } from "./util.ts";
import { openDb, migrate, getClusterMembers, upsertLabel } from "./db.ts";
import { Database } from "bun:sqlite";
import {
  validateEfficiency,
  validateQuality,
  getPanelPromptHash,
  getJudgePromptHash,
  consolidate,
  consolidateDeterministic,
} from "./judge.ts";
import { mine } from "./mine.ts";
import {
  slugify,
  isDraftable,
  draftSkill,
  draftFromCandidates,
  buildClusterEvidence,
  applyOverclaimGuard,
  clampDescription,
  richSuccessRef,
  richStageRef,
  stageFileName,
  assignStageRefs,
  writeRichDraft,
  selfEval,
  DraftGateError,
  type AuthoredSkill,
  type AuthoredStep,
  type ClusterEvidence,
} from "./skilldraft.ts";
import type {
  SessionInfo,
  RankedCandidate,
  JudgeLabel,
  JudgeMeta,
  EfficiencyAssessment,
  QualityAssessment,
} from "./types.ts";

// ── privacy ────────────────────────────────────────────────────────────────────
test("credentials are dropped, never leaked", () => {
  const raw =
    "password: hunter2 api_key=sk-ant-abc123def456 Bearer ey.tok.en " +
    "mongodb://u:p@host/db -----BEGIN PRIVATE KEY-----X-----END PRIVATE KEY-----";
  const r = sanitizeText(raw);
  expect(r.hadCredential).toBe(true);
  for (const leak of ["hunter2", "sk-ant-abc123def456", "u:p@host"]) {
    expect(r.text.includes(leak)).toBe(false);
  }
  expect(r.text.includes("[REDACTED")).toBe(true);
});

test("PII is masked with strong-pii count", () => {
  const r = sanitizeText("email a.nguyen@vinhomes.vn phone 0912345678 id 012345678901");
  expect(r.text.includes("a.nguyen@vinhomes.vn")).toBe(false);
  expect(r.text.includes("0912345678")).toBe(false);
  expect(r.nStrongPii).toBeGreaterThan(0);
});

test("clean text is unchanged", () => {
  const r = sanitizeText("fix the failing tennis tracker test");
  expect(r.hits.length).toBe(0);
  expect(r.text).toBe("fix the failing tennis tracker test");
});

function fakeSession(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "s1",
    project: "proj",
    projectDir: "-Users-x-proj",
    cwd: "/Users/x/proj",
    jsonlPath: "/Users/x/.claude/projects/-Users-x-proj/s1.jsonl",
    subagentsDir: null,
    startedAt: "",
    completedAt: "",
    ...over,
  };
}

test("worker opt-out by path substring", () => {
  const ex = isExcludedSession(fakeSession({ cwd: "/Users/x/personal/diary" }));
  expect(ex.excluded).toBe(true);
});

test("filterExcluded partitions sessions", () => {
  const { kept, excluded } = filterExcluded([
    fakeSession({ sessionId: "a", cwd: "/work/app" }),
    fakeSession({ sessionId: "b", cwd: "/work/private-notes" }),
  ]);
  expect(kept.length).toBe(1);
  expect(excluded.length).toBe(1);
});

// ── convergence ─────────────────────────────────────────────────────────────────
function cand(over: Partial<RankedCandidate>): RankedCandidate {
  return {
    cluster_id: "c",
    label: "bug fix",
    frequency: 3,
    n_sessions: 3,
    success_rate: 0.8,
    median_friction: 1,
    has_stable_pattern: true,
    dominant_pattern: "explore>edit>test",
    risk_flags: [],
    est_effort: 100,
    recommended_intervention: "skill",
    ...over,
  };
}

test("cross-machine convergence marks shared workflow cross-validated", () => {
  const items = [
    { machineId: "M-A", candidate: cand({ cluster_id: "a", frequency: 3 }) },
    { machineId: "M-B", candidate: cand({ cluster_id: "b", frequency: 4 }) },
    { machineId: "M-A", candidate: cand({ cluster_id: "c", label: "unique refactor here", dominant_pattern: "edit" }) },
  ];
  const conv = converge(items);
  const xval = conv.filter((c) => c.cross_validated);
  expect(xval.length).toBe(1);
  expect(xval[0].n_machines).toBe(2);
  expect(xval[0].total_frequency).toBe(7);
});

// ── skill-draft gate ──────────────────────────────────────────────────────────
// `cand()` (above) defaults to a draftable candidate (recommended_intervention "skill").
function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function walkFiles(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(d, e.name)) : [join(d, e.name)]
  );
}

test("draftSkill refuses unless opted in (--yes)", () => {
  const dir = tmpDir("draft-optin-");
  try {
    expect(() => draftSkill(cand({}), dir, false)).toThrow(DraftGateError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-draftable intervention is rejected", () => {
  const dir = tmpDir("draft-nondraft-");
  try {
    expect(isDraftable(cand({ recommended_intervention: "none" }))).toBe(false);
    expect(() => draftSkill(cand({ recommended_intervention: "none" }), dir, true)).toThrow(
      DraftGateError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "deterministic layout: full structure + passing self-eval",
  async () => {
    const dir = tmpDir("draft-layout-");
    try {
      const skillDir = draftSkill(
        cand({ label: "create ticket flow", n_judged: 8, low_confidence: false }),
        dir,
        true
      );
      expect(skillDir).toBe(join(dir, "create-ticket-flow"));
      expect(slugify("create ticket flow")).toBe("create-ticket-flow");

      // New tree: skill/ (publishable) + audit/ (provenance). No REVIEW.md anywhere.
      const md = readFileSync(join(skillDir, "skill", "SKILL.md"), "utf8");
      expect(md.startsWith("---")).toBe(true);
      for (const k of ["name:", "description:", "version:"]) expect(md.includes(k)).toBe(true);
      expect(existsSync(join(skillDir, "skill", "references"))).toBe(true);
      for (const f of ["success-patterns.md", "failure-modes.md"]) {
        expect(existsSync(join(skillDir, "skill", "references", f))).toBe(true);
      }
      // Per-stage stubs are written from the dominant pattern (explore>edit>test).
      for (const f of ["explore.md", "edit.md", "test.md"]) {
        expect(existsSync(join(skillDir, "skill", "references", f))).toBe(true);
      }
      // audit/ files.
      for (const f of ["evidence.md", "observed.md", "golden_cases.json", "meta.json"]) {
        expect(existsSync(join(skillDir, "audit", f))).toBe(true);
      }
      expect(existsSync(join(skillDir, "audit", "tests", "skill.test.ts"))).toBe(true);
      expect(existsSync(join(skillDir, "audit", "scripts", "run.ts"))).toBe(true);
      // generated_stage_refs manifest is recorded.
      const meta = JSON.parse(readFileSync(join(skillDir, "audit", "meta.json"), "utf8"));
      expect(meta.generated_stage_refs).toEqual(["explore.md", "edit.md", "test.md"]);
      // No REVIEW.md anywhere in the tree.
      const allFiles = walkFiles(skillDir);
      expect(allFiles.some((f) => f.endsWith("REVIEW.md"))).toBe(false);

      // Self-eval runs the drafted skill's own bun test suite.
      const ev = await selfEval(skillDir);
      expect(ev.passed).toBe(true);
      expect(ev.nTests).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000
);

// ── extractJsonObject (shared util) ───────────────────────────────────────────
test("extractJsonObject pulls a balanced object from fenced/prosey text", () => {
  expect(extractJsonObject('here it is:\n```json\n{"a":1}\n``` thanks')).toBe('{"a":1}');
  expect(extractJsonObject('prefix {"a":{"b":2}} suffix')).toBe('{"a":{"b":2}}');
  expect(extractJsonObject("no object here")).toBeNull();
  // The authorSkillContent flow JSON.parses the extraction; null short-circuits it.
  expect(extractJsonObject("")).toBeNull();
});

// ── description clamp (the trigger field must never clip mid-word) ─────────────
test("clampDescription never cuts mid-word and stays within budget", () => {
  const short = "Use when fixing a reported defect.";
  expect(clampDescription(short)).toBe(short); // already short → unchanged

  const long =
    "Use when fixing a reported defect in an existing codebase — a wrong runtime " +
    "behavior, a broken UI interaction, a failing build or test, or incorrect output, " +
    "where you must locate the cause and confirm the symptom is gone afterwards.";
  const out = clampDescription(long);
  expect(out.length).toBeLessThanOrEqual(181); // ≤180 + optional ellipsis
  expect(out.endsWith(" ")).toBe(false);
  // Last token must be a whole word or an ellipsis — never a truncated word fragment.
  const tail = out.replace(/…$/, "").trim().split(" ").pop()!;
  expect(long.includes(tail)).toBe(true);
});

// ── safety gate is code-enforced in every SKILL.md ────────────────────────────
test("draftSkill always emits the publishing-safety gate", () => {
  const dir = tmpDir("draft-safety-");
  try {
    const skillDir = draftSkill(cand({ label: "git push flow" }), dir, true);
    const md = readFileSync(join(skillDir, "skill", "SKILL.md"), "utf8");
    expect(md).toContain("## Safety");
    expect(md.toLowerCase()).toContain("explicitly asks");
    // REVIEW.md no longer exists — the draft is a complete skill.
    expect(existsSync(join(skillDir, "REVIEW.md"))).toBe(false);
    expect(existsSync(join(skillDir, "skill", "REVIEW.md"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── frontmatter: license + metadata block + block-list triggers, valid YAML ────
test("frontmatter carries license + metadata block + block-list triggers and parses as YAML", () => {
  const dir = tmpDir("draft-frontmatter-");
  try {
    // recommended_intervention "script" → role "automation" (deterministic default).
    const skillDir = draftSkill(cand({ label: "ship feature", recommended_intervention: "script" }), dir, true);
    const md = readFileSync(join(skillDir, "skill", "SKILL.md"), "utf8");
    for (const k of ["name:", "description:", "license:", "metadata:", "domain:", "role:", "triggers:", "version:"]) {
      expect(md.includes(k)).toBe(true);
    }
    // triggers must be a YAML block list, never inline [a, b] (a redacted comma would break it).
    expect(md).toMatch(/triggers:\n\s+- /);
    expect(md).not.toMatch(/triggers:\s*\[/);
    // The whole frontmatter parses as valid YAML.
    const fm = md.split("---")[1];
    const parsed = Bun.YAML.parse(fm) as {
      name: string;
      description: string;
      license: string;
      metadata: { role: string; domain: string; triggers: string[]; version: string };
    };
    expect(parsed.name).toBe("ship-feature"); // slug, top-level
    expect(parsed.license).toBe("MIT");
    expect(parsed.metadata.role).toBe("automation"); // script → automation
    expect(parsed.metadata.domain).toBe("software-engineering");
    expect(Array.isArray(parsed.metadata.triggers)).toBe(true);
    expect(parsed.metadata.triggers.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── applyOverclaimGuard (the code integrity gate) ─────────────────────────────
function step(over: Partial<AuthoredStep> = {}): AuthoredStep {
  return {
    name: "explore",
    detail: "look first",
    how_to: "read the relevant files",
    inputs_needed: [],
    ask_user: "",
    web_search: "",
    error_handling: "retry on transient failure",
    ...over,
  };
}

function authored(over: Partial<AuthoredSkill> = {}): AuthoredSkill {
  return {
    description: "Use when doing the thing.",
    when_to_use: "when doing the thing",
    optimal_workflow: "always do X then Y",
    checklist: [],
    steps: [step()],
    errors: [{ error: "thing broke", how_to_handle: "fix it" }],
    success_patterns_summary: "it works",
    references: { success_patterns_md: "", failure_modes_md: "", evidence_md: "" },
    ...over,
  };
}

function evidence(over: Partial<ClusterEvidence> = {}): ClusterEvidence {
  return {
    clusterId: "k",
    label: "thing",
    recommendedIntervention: "sop",
    frequency: 10,
    nSessions: 5,
    nJudged: 10,
    successRate: 0.7,
    lowConfidence: false,
    hasStablePattern: true,
    evidenceStrength: "strong",
    nFailureEpisodes: 3,
    nSuccessEpisodes: 7,
    riskFlags: [],
    goodPractices: [],
    frictionPoints: [],
    rootCauses: [],
    successWorkflows: [],
    failWorkflows: [],
    recurringFriction: [],
    ...over,
  };
}

test("guard: weak evidence PRESERVES the authored optimal_workflow (no longer nulled)", () => {
  const out = applyOverclaimGuard(
    authored({ optimal_workflow: "Do X then Y then verify." }),
    evidence({ evidenceStrength: "weak" })
  );
  expect(out.optimal_workflow).toBe("Do X then Y then verify.");
});

test("guard: zero failures KEEPS authored errors (no sentinel injected)", () => {
  const out = applyOverclaimGuard(
    authored({ errors: [{ error: "config drift", how_to_handle: "reconcile against the source of truth" }] }),
    evidence({ nFailureEpisodes: 0, nSuccessEpisodes: 9 })
  );
  expect(out.errors.length).toBe(1);
  expect(out.errors[0].error).toBe("config drift");
  expect(out.errors[0].how_to_handle).toContain("reconcile");
});

test("progressive disclosure: moved workflow prose survives in success-patterns.md", () => {
  // Fix-3 moved the long workflow/success prose out of the hot path; assert it still
  // reaches disk via richSuccessRef (the reference body) — nothing lost.
  const a = authored({
    optimal_workflow: "WORKFLOW_PROSE_MARKER: explore then edit then verify.",
    success_patterns_summary: "WHAT_WORKED_MARKER: front-loaded exploration.",
  });
  const ref = richSuccessRef(a, evidence());
  expect(ref).toContain("WORKFLOW_PROSE_MARKER");
  expect(ref).toContain("WHAT_WORKED_MARKER");
  expect(ref).toContain("## Recommended workflow");
});

test("guard: singleton friction is never labeled 'recurring'", () => {
  const out = applyOverclaimGuard(
    authored({ errors: [{ error: "recurring flaky thing", how_to_handle: "retry the recurring step" }] }),
    evidence({
      nFailureEpisodes: 2,
      frictionPoints: [{ text: "flaky thing", count: 1 }],
      recurringFriction: [],
    })
  );
  expect(out.errors[0].error.toLowerCase()).not.toContain("recurring");
  expect(out.errors[0].how_to_handle.toLowerCase()).not.toContain("recurring");
});

test("guard: fabricated observation counts in authored prose are neutralised", () => {
  const out = applyOverclaimGuard(
    authored({
      optimal_workflow: "This pattern was observed in 7 runs and worked 5 of 8 sessions.",
      steps: [step({ how_to: "Seen in 3 episodes; do the thing." })],
    }),
    evidence()
  );
  expect(out.optimal_workflow).not.toMatch(/\b7 runs\b/);
  expect(out.optimal_workflow).not.toMatch(/\b5 of 8\b/);
  expect(out.steps[0].how_to).not.toMatch(/\b3 episodes\b/);
});

// ── per-stage references (filename mapping + body) ─────────────────────────────
test("stageFileName: slugifies, dedupes via _N, falls back safely", () => {
  expect(stageFileName("Clarify scope")).toBe("clarify_scope");
  expect(stageFileName("!!!")).toBe("stage");
  expect(stageFileName("")).toBe("stage");
  const refs = assignStageRefs([step({ name: "Clarify scope" }), step({ name: "Clarify scope" })]);
  expect(refs[0].fileName).toBe("clarify_scope.md");
  expect(refs[1].fileName).toBe("clarify_scope_2.md");
});

test("richStageRef renders how-to, ask-user, and a scripts/<file> reference", () => {
  const s = step({
    name: "Clarify scope",
    how_to: "HOWTO_MARKER: pin the requirements down.",
    ask_user: "ASKUSER_MARKER: which surfaces are in scope?",
    script: { filename: "scope.sh", language: "sh", purpose: "snapshot scope", body: "echo hi" },
  });
  const body = richStageRef(s);
  expect(body).toContain("# Clarify scope");
  expect(body).toContain("HOWTO_MARKER");
  expect(body).toContain("ASKUSER_MARKER");
  expect(body).toContain("`scripts/scope.sh`");
});

test("richStageRef renders depth sections (How to do it / Examples / Edge cases / Common mistakes / Checklist)", () => {
  const s = step({
    name: "Implement",
    how_to: "Make the change.",
    steps_detail: ["Write a failing test", "Implement minimally", "Refactor"],
    examples: [{ good: "GOOD_MARKER do it this way", bad: "BAD_MARKER not this way", note: "NOTE_MARKER" }],
    edge_cases: ["EDGE_MARKER conflicting requirements"],
    common_mistakes: ["MISTAKE_MARKER coding before scope"],
    checklist: ["CHECK_MARKER tests green"],
  });
  const body = richStageRef(s);
  expect(body).toContain("## How to do it");
  expect(body).toContain("1. Write a failing test");
  expect(body).toContain("## Examples");
  expect(body).toContain("✅"); // good marker
  expect(body).toContain("❌"); // bad marker
  expect(body).toContain("GOOD_MARKER");
  expect(body).toContain("BAD_MARKER");
  expect(body).toContain("## Edge cases");
  expect(body).toContain("EDGE_MARKER");
  expect(body).toContain("## Common mistakes");
  expect(body).toContain("MISTAKE_MARKER");
  expect(body).toContain("## Checklist");
  expect(body).toContain("- [ ] CHECK_MARKER tests green");
});

test("richStageRef fences a multi-line example that itself contains ``` with a longer fence", () => {
  // An authored code example may contain a triple-backtick block; a bare ``` fence would
  // close prematurely. The fence must be longer than any backtick run in the body.
  const inner = "```js\nconst x = 1;\n```";
  const body = richStageRef(step({ name: "Demo", examples: [{ good: `before\n${inner}\nafter` }] }));
  expect(body).toContain("## Examples");
  expect(body).toContain("````"); // a 4+ backtick fence wraps the 3-backtick body
  expect(body).toContain("const x = 1;");
});

test("richStageRef omits depth sections when the fields are absent (thin step stays clean)", () => {
  // A step with no depth fields must not emit empty ## How to do it / ## Examples headings.
  const body = richStageRef(step({ name: "Quick", how_to: "just do it" }));
  expect(body).toContain("# Quick");
  expect(body).not.toContain("## How to do it");
  expect(body).not.toContain("## Examples");
  expect(body).not.toContain("## Checklist");
});

// ── privacy: secrets are redacted before they reach disk / evidence ───────────
test("buildClusterEvidence redacts secrets in label fields", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  db.query(
    `INSERT INTO task_clusters (cluster_id, label, member_episode_ids_json) VALUES (?,?,?)`
  ).run("k", "thing", JSON.stringify(["e1"]));
  db.query(
    `INSERT INTO episode_labels (episode_id, outcome, good_practices_json, friction_points_json, root_cause)
     VALUES (?,?,?,?,?)`
  ).run(
    "e1",
    "success",
    JSON.stringify(["used api_key=sk-ant-SECRETSECRET123456 to auth"]),
    JSON.stringify([{ what: "leaked password: hunter2here", evidence: "in the log" }]),
    "root cause text"
  );
  const ev = buildClusterEvidence(db, cand({ cluster_id: "k", n_judged: 8 }), undefined);
  const blob = JSON.stringify(ev);
  expect(blob).not.toContain("sk-ant-SECRETSECRET123456");
  expect(blob).not.toContain("hunter2here");
  expect(blob).toContain("[REDACTED");
  db.close();
});

test("draftSkill redacts secrets in candidate fields before writing to disk", () => {
  const dir = tmpDir("draft-privacy-");
  try {
    const skillDir = draftSkill(
      cand({
        label: "deploy flow",
        business_note: "ssh with password: topsecret42",
        risk_flags: ["token=sk-ant-LEAKLEAKLEAK123456"],
        n_judged: 8,
      }),
      dir,
      true
    );
    // Every written file must be free of the raw secrets.
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
      );
    for (const f of walk(skillDir)) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("topsecret42");
      expect(text).not.toContain("sk-ant-LEAKLEAKLEAK123456");
    }
    // Frontmatter is still valid (description quoted as a YAML scalar).
    const md = readFileSync(join(skillDir, "skill", "SKILL.md"), "utf8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/description:\s*"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── stale candidates.json: missing cluster row → deterministic fallback ───────
test("getClusterMembers returns [] for an unknown cluster", () => {
  const db = openDb(":memory:");
  expect(getClusterMembers(db, "does-not-exist")).toEqual([]);
  db.close();
});

test(
  "stale cluster ids fall back to deterministic drafts; batch continues",
  async () => {
    const root = tmpDir("draft-stale-");
    try {
      // A real (existing) DB file with an EMPTY task_clusters table → every cluster_id
      // is "missing" → the rich path is skipped per-candidate (no LLM call).
      const dbPath = join(root, "empty.db");
      openDb(dbPath).close();
      const candPath = join(root, "candidates.json");
      writeFileSync(
        candPath,
        JSON.stringify({
          machine_id: "M-test",
          candidates: [
            cand({ cluster_id: "missing-1", label: "alpha flow", recommended_intervention: "sop" }),
            cand({ cluster_id: "missing-2", label: "beta flow", recommended_intervention: "script" }),
          ],
          contrasts: {},
          generated_at: "2026-01-01T00:00:00Z",
        }),
        "utf8"
      );
      const outRoot = join(root, "out");
      const results = await draftFromCandidates(candPath, outRoot, true, { llm: true, db: dbPath });
      expect(results.length).toBe(2);
      for (const r of results) {
        expect(r.authored).toBe(false); // deterministic fallback, no LLM
        expect(r.selfEval.passed).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000
);

// ── writeRichDraft seam (LLM-free): full authored write path ──────────────────
function richAuthored(over: Partial<AuthoredSkill> = {}): AuthoredSkill {
  return authored({
    description: "Use when shipping a new feature end to end.",
    when_to_use: "When adding a feature to an existing codebase.",
    optimal_workflow: "Clarify, explore, implement, verify.",
    steps: [
      step({ name: "Clarify scope", detail: "pin requirements", ask_user: "what is in scope?" }),
      step({
        name: "Implement",
        detail: "write the code",
        script: { filename: "build.sh", language: "sh", purpose: "build it", body: "bun run build" },
      }),
      step({ name: "Verify", detail: "run tests", error_handling: "re-run on flake" }),
    ],
    errors: [{ error: "tests flake", how_to_handle: "isolate and rerun" }],
    ...over,
  });
}

test(
  "writeRichDraft: stage files match SKILL.md links; script written + linked; manifest cleanup spares human files; counts only in audit/",
  async () => {
    const root = tmpDir("draft-rich-");
    try {
      const c = cand({ cluster_id: "k", label: "ship feature", n_judged: 8 });
      const dir = draftSkill(c, root, true); // lay down deterministic tree + manifest

      // Seed a human-added reference file that must SURVIVE manifest cleanup.
      const humanFile = join(dir, "skill", "references", "my-notes.md");
      writeFileSync(humanFile, "# my hand-written notes\n", "utf8");

      const ev = evidence({
        clusterId: "k",
        label: "ship feature",
        successWorkflows: [{ text: "explore then edit then verify", count: 4 }],
        frictionPoints: [{ text: "flaky tests", count: 3 }],
      });
      const res = writeRichDraft(c, ev, richAuthored(), dir);
      expect(res.authored).toBe(true);

      const skillMd = readFileSync(join(dir, "skill", "SKILL.md"), "utf8");

      // (a) Every references/<stage>.md link in SKILL.md points to a file that exists.
      const linked = [...skillMd.matchAll(/`references\/([a-z0-9_]+\.md)`/g)].map((m) => m[1]);
      expect(linked.length).toBeGreaterThanOrEqual(3);
      for (const f of linked) {
        expect(existsSync(join(dir, "skill", "references", f))).toBe(true);
      }
      expect(linked).toContain("clarify_scope.md");

      // (b) The authored script is written to skill/scripts/ and linked from its stage file.
      expect(existsSync(join(dir, "skill", "scripts", "build.sh"))).toBe(true);
      const implRef = readFileSync(join(dir, "skill", "references", "implement.md"), "utf8");
      expect(implRef).toContain("`scripts/build.sh`");

      // (c) Stale deterministic stubs (explore/edit/test) removed; human file survives.
      expect(existsSync(humanFile)).toBe(true);
      for (const stub of ["explore.md", "edit.md", "test.md"]) {
        expect(existsSync(join(dir, "skill", "references", stub))).toBe(false);
      }

      // (d) audit/meta.json marks authored=true.
      const meta = JSON.parse(readFileSync(join(dir, "audit", "meta.json"), "utf8"));
      expect(meta.authored).toBe(true);

      // Publish/audit split: mined counts live ONLY under audit/, never in skill/.
      const observed = readFileSync(join(dir, "audit", "observed.md"), "utf8");
      expect(observed).toContain("4×");
      expect(skillMd).not.toContain("Observed");
      expect(skillMd).not.toContain("## Evidence");
      expect(skillMd).not.toMatch(/\d+×/);

      // (e) selfEval passes against the new tree.
      const se = await selfEval(dir);
      expect(se.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000
);

test(
  "re-draft: a prior rich run's stage files are cleaned, not orphaned (no stale published files)",
  async () => {
    const root = tmpDir("draft-redraft-");
    try {
      const c = cand({ cluster_id: "k", label: "ship feature", n_judged: 8 });
      const ev = evidence({ clusterId: "k", label: "ship feature" });
      const refsDir = join(root, slugify(c.label), "skill", "references");

      // Rich run 1 — authored stages design_api / migrate_db (the real flow is
      // draftSkill() then writeRichDraft(), so mirror both steps each run).
      draftSkill(c, root, true);
      const humanFile = join(refsDir, "my-notes.md");
      writeFileSync(humanFile, "# hand-written\n", "utf8");
      writeRichDraft(
        c,
        ev,
        richAuthored({
          steps: [step({ name: "Design API", detail: "spec it" }), step({ name: "Migrate DB", detail: "alter schema" })],
        }),
        join(root, slugify(c.label))
      );
      expect(existsSync(join(refsDir, "design_api.md"))).toBe(true);
      expect(existsSync(join(refsDir, "migrate_db.md"))).toBe(true);

      // Rich run 2 — a DIFFERENT authored stage set; run-1's files must not linger.
      draftSkill(c, root, true);
      writeRichDraft(c, ev, richAuthored({ steps: [step({ name: "Write handler", detail: "wire it" })] }), join(root, slugify(c.label)));

      // Run-1 stage files are gone (cleaned via the prior manifest, not orphaned).
      expect(existsSync(join(refsDir, "design_api.md"))).toBe(false);
      expect(existsSync(join(refsDir, "migrate_db.md"))).toBe(false);
      // Run-2 stage file is present and linked from SKILL.md.
      expect(existsSync(join(refsDir, "write_handler.md"))).toBe(true);
      const skillMd = readFileSync(join(root, slugify(c.label), "skill", "SKILL.md"), "utf8");
      const linked = [...skillMd.matchAll(/`references\/([a-z0-9_]+\.md)`/g)].map((m) => m[1]);
      expect(linked).toContain("write_handler.md");
      expect(linked).not.toContain("design_api.md");
      // Human file and FIXED_REFS survive both runs.
      expect(existsSync(humanFile)).toBe(true);
      expect(existsSync(join(refsDir, "success-patterns.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000
);

test("script filename policy: traversal / path segments are REJECTED, not salvaged", () => {
  const root = tmpDir("draft-scriptname-");
  try {
    const c = cand({ cluster_id: "k", label: "evil flow", n_judged: 8 });
    const dir = draftSkill(c, root, true);
    const ev = evidence({ clusterId: "k", label: "evil flow" });
    writeRichDraft(
      c,
      ev,
      richAuthored({
        steps: [
          step({
            name: "Traverse",
            script: { filename: "../etc/passwd", language: "sh", purpose: "bad", body: "echo x" },
          }),
          step({
            name: "Nested",
            script: { filename: "a/b.sh", language: "sh", purpose: "bad", body: "echo x" },
          }),
        ],
      }),
      dir
    );
    // No script escaped skill/scripts/, and the basenames were NOT salvaged.
    expect(existsSync(join(dir, "skill", "scripts", "passwd"))).toBe(false);
    expect(existsSync(join(dir, "skill", "scripts", "b.sh"))).toBe(false);
    // The stage files must not link a rejected script.
    const traverseRef = readFileSync(join(dir, "skill", "references", "traverse.md"), "utf8");
    expect(traverseRef).not.toContain("scripts/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("script safety-scan: dangerous body flagged + recorded; benign body not", () => {
  const root = tmpDir("draft-scan-");
  try {
    const c = cand({ cluster_id: "k", label: "scan flow", n_judged: 8 });
    const dir = draftSkill(c, root, true);
    const ev = evidence({ clusterId: "k", label: "scan flow" });
    writeRichDraft(
      c,
      ev,
      richAuthored({
        steps: [
          step({
            name: "Wipe",
            script: { filename: "wipe.sh", language: "sh", purpose: "danger", body: "rm -rf /tmp/x" },
          }),
          step({
            name: "Test",
            script: { filename: "test.sh", language: "sh", purpose: "safe", body: "bun test" },
          }),
        ],
      }),
      dir
    );
    const wipe = readFileSync(join(dir, "skill", "scripts", "wipe.sh"), "utf8");
    expect(wipe).toContain("⚠️ UNVETTED");
    const safe = readFileSync(join(dir, "skill", "scripts", "test.sh"), "utf8");
    expect(safe).not.toContain("⚠️ UNVETTED");
    const meta = JSON.parse(readFileSync(join(dir, "audit", "meta.json"), "utf8"));
    expect(meta.flagged_scripts.some((f: { file: string }) => f.file === "wipe.sh")).toBe(true);
    expect(meta.flagged_scripts.some((f: { file: string }) => f.file === "test.sh")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── rich SKILL.md depth sections (Quick checklist / Constraints / Workflow table) ──
test("rich SKILL.md renders Quick checklist, Constraints (MUST DO/MUST NOT), Workflow table, Reference guide — still no counts", () => {
  const root = tmpDir("draft-richmd-");
  try {
    const c = cand({ cluster_id: "k", label: "ship feature", n_judged: 8 });
    const dir = draftSkill(c, root, true);
    const ev = evidence({ clusterId: "k", label: "ship feature" });
    writeRichDraft(
      c,
      ev,
      richAuthored({
        checklist: ["QC_confirm scope with the user", "QC_write tests first"],
        constraints: { must_do: ["MUSTDO_keep changes reversible"], must_not: ["MUSTNOT_push or open a PR unless asked"] },
      }),
      dir
    );
    const md = readFileSync(join(dir, "skill", "SKILL.md"), "utf8");
    // (c) skill-level checklist is rendered (the previously-dropped field).
    expect(md).toContain("## Quick checklist");
    expect(md).toContain("- [ ] QC_confirm scope with the user");
    // (d) constraints render MUST DO / MUST NOT.
    expect(md).toContain("## Constraints");
    expect(md).toContain("MUST DO");
    expect(md).toContain("MUST NOT");
    expect(md).toContain("MUSTDO_keep changes reversible");
    expect(md).toContain("MUSTNOT_push or open a PR unless asked");
    // Workflow is now a table; a Reference guide closes the doc.
    expect(md).toContain("| # | Step | What it does | Reference |");
    expect(md).toContain("## Reference guide");
    // Publish/audit split unchanged: no mined counts in the published SKILL.md.
    expect(md).not.toContain("Observed");
    expect(md).not.toContain("## Evidence");
    expect(md).not.toMatch(/\d+×/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (e) privacy: a secret seeded in a NEW depth field is redacted before disk ──
test("rich path redacts secrets seeded in new depth fields (examples[].good / edge_cases)", () => {
  const root = tmpDir("draft-rich-redact-");
  try {
    const c = cand({ cluster_id: "k", label: "ship feature", n_judged: 8 });
    const dir = draftSkill(c, root, true);
    const ev = evidence({ clusterId: "k", label: "ship feature" });
    writeRichDraft(
      c,
      ev,
      richAuthored({
        steps: [
          step({
            name: "Implement",
            examples: [{ good: "use api_key=sk-ant-SECRETLEAK1234567 to auth", bad: "left password: hunter2leak in code" }],
            edge_cases: ["rotate token=sk-ant-EDGELEAK7654321 before release"],
          }),
        ],
      }),
      dir
    );
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
      );
    for (const f of walk(dir)) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("sk-ant-SECRETLEAK1234567");
      expect(text).not.toContain("hunter2leak");
      expect(text).not.toContain("sk-ant-EDGELEAK7654321");
    }
    // The example still rendered into the stage file (redacted, not dropped).
    const implRef = readFileSync(join(dir, "skill", "references", "implement.md"), "utf8");
    expect(implRef).toContain("[REDACTED");
    expect(implRef).toContain("## Examples");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Multi-judge panel (efficiency + quality + consolidator). All LLM-FREE — they
// exercise validators, the cache-key discriminator, the consolidation seam (in
// deterministic mode), mine null-safety, the migration guard, and the upsert
// round-trip. None call Claude.
// ══════════════════════════════════════════════════════════════════════════════

// ── (1) score validators ────────────────────────────────────────────────────────
test("validateEfficiency/validateQuality accept 1..5 integers; reject 0/6/NaN/float/missing", () => {
  expect(validateEfficiency({ score: 1, rationale: "x", evidence: [] }).score).toBe(1);
  expect(validateEfficiency({ score: 5, rationale: "x", evidence: ["a", "b"] }).evidence).toEqual([
    "a",
    "b",
  ]);
  expect(validateQuality({ score: 3, rationale: "ok", evidence: [] }).score).toBe(3);

  // Out-of-range / non-integer / non-number scores all force a retry (throw), never round.
  for (const bad of [0, 6, -1, 3.5, NaN, Infinity, "4", null, undefined]) {
    expect(() => validateEfficiency({ score: bad, rationale: "x", evidence: [] })).toThrow();
    expect(() => validateQuality({ score: bad, rationale: "x", evidence: [] })).toThrow();
  }
  // rationale must be a string; evidence must be a string[].
  expect(() => validateEfficiency({ score: 3, rationale: 5, evidence: [] })).toThrow();
  expect(() => validateEfficiency({ score: 3, rationale: "x", evidence: [1, 2] })).toThrow();
  expect(() => validateEfficiency({ score: 3, rationale: "x", evidence: "nope" })).toThrow();
  expect(() => validateEfficiency(null)).toThrow();
  expect(() => validateEfficiency([1, 2, 3])).toThrow();
});

// ── (2) panel hash is distinct from the single-judge hash and is stable ─────────
test("getPanelPromptHash differs from getJudgePromptHash and is stable across calls", () => {
  const p1 = getPanelPromptHash();
  const p2 = getPanelPromptHash();
  expect(p1).toBe(p2); // cached → stable
  expect(p1).not.toBe(getJudgePromptHash()); // distinct cache-key space
  expect(p1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
});

// ── consolidation seam fixtures ─────────────────────────────────────────────────
function judgeLabel(over: Partial<JudgeLabel> = {}): JudgeLabel {
  return {
    episode_id: "e",
    task_type: "bug fix",
    task_difficulty: "moderate",
    outcome: "success",
    outcome_confidence: 0.9,
    workflow_pattern: ["explore", "edit", "test"],
    good_practices: [],
    friction_points: [],
    root_cause: "none",
    outcome_evidence: ["user said thanks"],
    skill_opportunity: { worth_codifying: false, type: "none", rationale: "n/a" },
    ...over,
  };
}
const eff = (score: number): EfficiencyAssessment => ({ score, rationale: "r", evidence: [] });
const qual = (score: number): QualityAssessment => ({ score, rationale: "r", evidence: [] });

// ── (3) consolidateDeterministic rules ──────────────────────────────────────────
test("consolidateDeterministic: low quality (≤2) + success → partial + clamped confidence + assessments attached", () => {
  const out = consolidateDeterministic({
    rendered: "",
    episodeId: "e1",
    outcome: judgeLabel({ outcome: "success", outcome_confidence: 0.95 }),
    efficiency: eff(3),
    quality: { score: 2, rationale: "test left red", evidence: ["assert failed"] },
  });
  expect(out.outcome).toBe("partial");
  expect(out.outcome_confidence).toBeLessThanOrEqual(0.6);
  expect(out.episode_id).toBe("e1");
  expect(out.efficiency).toEqual(eff(3));
  expect(out.quality?.score).toBe(2);
});

test("consolidateDeterministic: quality 4 keeps the outcome and confidence", () => {
  const out = consolidateDeterministic({
    rendered: "",
    episodeId: "e2",
    outcome: judgeLabel({ outcome: "success", outcome_confidence: 0.88 }),
    efficiency: eff(2), // poor efficiency must NOT change the outcome
    quality: qual(4),
  });
  expect(out.outcome).toBe("success");
  expect(out.outcome_confidence).toBe(0.88);
  expect(out.efficiency?.score).toBe(2);
  expect(out.quality?.score).toBe(4);
});

// ── (4) consolidate(mode:"deterministic") returns a schema-valid label, no network ─
test("consolidate(deterministic) yields a schema-valid panel label without any network call", async () => {
  const label = await consolidate(
    {
      rendered: "USER: do it\nASSISTANT: done",
      episodeId: "e3",
      outcome: judgeLabel({ episode_id: "e3" }),
      efficiency: eff(5),
      quality: qual(5),
    },
    { mode: "deterministic" }
  );
  expect(label.episode_id).toBe("e3");
  expect(["success", "partial", "failed", "abandoned", "qa_only"]).toContain(label.outcome);
  expect(label.efficiency?.score).toBe(5);
  expect(label.quality?.score).toBe(5);
  // base label fields survive intact
  expect(Array.isArray(label.workflow_pattern)).toBe(true);
  expect(label.skill_opportunity.type).toBe("none");
});

// ── (5) mine null-safety: NULL panel JSON vs panel rows ─────────────────────────
// Insert episodes whose task_type all normalize to ONE cluster ("bug fix") so mine's
// optional LLM grouping pass is skipped (distinctNorm.size === 1) — fully offline.
function seedEpisode(
  db: Database,
  o: {
    episodeId: string;
    sessionId: string;
    taskType: string;
    outcome: string;
    efficiency?: EfficiencyAssessment | null;
    quality?: QualityAssessment | null;
  }
): void {
  db.query(
    `INSERT INTO episodes (episode_id, session_id, idx, n_corrections, n_interruptions, first_prompt, content_hash)
     VALUES (?,?,?,?,?,?,?)`
  ).run(o.episodeId, o.sessionId, 0, 0, 0, "do the thing", "h");
  db.query(
    `INSERT INTO episode_labels (episode_id, task_type, outcome, workflow_pattern_json,
       skill_opportunity_json, efficiency_json, quality_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    o.episodeId,
    o.taskType,
    o.outcome,
    JSON.stringify(["explore", "edit"]),
    JSON.stringify({ worth_codifying: false, type: "none", rationale: "" }),
    o.efficiency ? JSON.stringify(o.efficiency) : null,
    o.quality ? JSON.stringify(o.quality) : null
  );
}

test("mine: panel medians computed over panel-scored members; single-mode rows ignored", async () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  seedEpisode(db, {
    episodeId: "p1",
    sessionId: "s1",
    taskType: "bug fix",
    outcome: "success",
    efficiency: eff(4),
    quality: qual(5),
  });
  seedEpisode(db, {
    episodeId: "p2",
    sessionId: "s2",
    taskType: "bug fix",
    outcome: "success",
    efficiency: null, // single-mode member in the same cluster → no panel score
    quality: null,
  });
  const { candidates } = await mine(db);
  expect(candidates.length).toBe(1);
  const c = candidates[0]!;
  expect(c.median_efficiency).toBe(4);
  expect(c.median_quality).toBe(5);
  expect(c.n_panel_judged).toBe(1);
  db.close();
});

test("mine: all-NULL panel cluster → null medians, n_panel_judged 0, no throw", async () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  seedEpisode(db, { episodeId: "n1", sessionId: "s1", taskType: "bug fix", outcome: "success" });
  seedEpisode(db, { episodeId: "n2", sessionId: "s2", taskType: "bug fix", outcome: "partial" });
  const { candidates } = await mine(db);
  expect(candidates.length).toBe(1);
  const c = candidates[0]!;
  expect(c.median_efficiency).toBeNull();
  expect(c.median_quality).toBeNull();
  expect(c.n_panel_judged).toBe(0);
  db.close();
});

// ── (6) migration guard: panel columns present + idempotent ─────────────────────
test("migrate: a fresh DB has both panel columns; calling migrate twice is idempotent", () => {
  const db = openDb(":memory:");
  const colNames = () =>
    (db.query(`PRAGMA table_info(episode_labels)`).all() as { name: string }[]).map((c) => c.name);
  expect(colNames()).toContain("efficiency_json");
  expect(colNames()).toContain("quality_json");
  migrate(db); // second pass — ensureColumn must no-op, never throw
  expect(colNames()).toContain("efficiency_json");
  db.close();
});

test("migrate: ALTERs a pre-panel episode_labels missing the columns", () => {
  const db = new Database(":memory:");
  // Simulate an OLD analysis.db: episode_labels exists WITHOUT the panel columns, so
  // schema.sql's CREATE IF NOT EXISTS is a no-op and only ensureColumn can add them.
  db.exec(`CREATE TABLE episode_labels (episode_id TEXT PRIMARY KEY, outcome TEXT)`);
  migrate(db);
  const cols = (db.query(`PRAGMA table_info(episode_labels)`).all() as { name: string }[]).map(
    (c) => c.name
  );
  expect(cols).toContain("efficiency_json");
  expect(cols).toContain("quality_json");
  migrate(db); // idempotent
  db.close();
});

// ── (7) upsertLabel round-trip: single-mode writes NULL; panel writes JSON ───────
function judgeMeta(): JudgeMeta {
  return {
    model: "claude-opus-4-8",
    judge_prompt_hash: "h",
    label_schema_version: "1",
    cli_version: "x",
    judged_at: "2026-01-01T00:00:00Z",
  };
}

test("upsertLabel: single-mode label stores NULL panel columns; panel label round-trips", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");

  // single-mode (no efficiency/quality) → both columns NULL
  upsertLabel(db, judgeLabel({ episode_id: "single" }), judgeMeta());
  const r1 = db
    .query(`SELECT efficiency_json, quality_json FROM episode_labels WHERE episode_id=?`)
    .get("single") as { efficiency_json: string | null; quality_json: string | null };
  expect(r1.efficiency_json).toBeNull();
  expect(r1.quality_json).toBeNull();

  // panel label → JSON round-trips exactly
  const panel = judgeLabel({
    episode_id: "panel",
    efficiency: { score: 4, rationale: "lean", evidence: ["one pass"] },
    quality: { score: 3, rationale: "rough", evidence: [] },
  });
  upsertLabel(db, panel, judgeMeta());
  const r2 = db
    .query(`SELECT efficiency_json, quality_json FROM episode_labels WHERE episode_id=?`)
    .get("panel") as { efficiency_json: string; quality_json: string };
  expect(JSON.parse(r2.efficiency_json)).toEqual({
    score: 4,
    rationale: "lean",
    evidence: ["one pass"],
  });
  expect(JSON.parse(r2.quality_json)).toEqual({ score: 3, rationale: "rough", evidence: [] });
  db.close();
});
