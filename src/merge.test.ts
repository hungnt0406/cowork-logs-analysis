// Tests for the merged shell (privacy gate, convergence, skill-draft gate).
// Run: bun test src/merge.test.ts
import { test, expect } from "bun:test";
import { sanitizeText, isExcludedSession, filterExcluded } from "./privacy.ts";
import { converge } from "./converge.ts";
import { isDraftable, slugify, draftSkill, selfEval, DraftGateError } from "./skilldraft.ts";
import type { SessionInfo, RankedCandidate } from "./types.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

// ── skill-draft gate ─────────────────────────────────────────────────────────────
test("draft gate refuses without opt-in", () => {
  expect(() => draftSkill(cand({}), mkdtempSync(join(tmpdir(), "sk-")), false)).toThrow(DraftGateError);
});

test("non-draftable intervention is refused", () => {
  expect(isDraftable(cand({ recommended_intervention: "none" }))).toBe(false);
  expect(() => draftSkill(cand({ recommended_intervention: "none" }), mkdtempSync(join(tmpdir(), "sk-")), true)).toThrow(
    DraftGateError
  );
});

test("draft produces a skill whose own tests pass (self-eval)", async () => {
  const root = mkdtempSync(join(tmpdir(), "skilldraft-"));
  const dir = draftSkill(cand({ label: "create ticket flow" }), root, true);
  expect(slugify("create ticket flow")).toBe("create-ticket-flow");
  const ev = await selfEval(dir);
  expect(ev.passed).toBe(true);
  expect(ev.nTests).toBeGreaterThanOrEqual(3);
});
