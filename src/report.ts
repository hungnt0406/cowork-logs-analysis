// report.ts — exemplar-driven report (out/report.md) + machine-readable
// candidates (out/candidates.json) for the later skill-draft phase.
//
// Calls mine() for clusters + ranked components, then clusterContrast() per
// cluster for the good-vs-bad workflow contrast. Thin clusters (frequency < 3
// OR judged < 3) are rendered under "Insufficient evidence", not overclaimed.
//
// Export: report(db, opts?).
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { RankedCandidate } from "./types.ts";
import { mine, clusterContrast } from "./mine.ts";

const DEFAULT_OUT_DIR = join(import.meta.dir, "..", "out");

// ── small helpers ─────────────────────────────────────────────────────────────
function safeParseArray(json: string | null | undefined): any[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function oneLine(s: string | null | undefined, n = 100): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

interface ExemplarRow {
  episode_id: string;
  first_prompt: string | null;
  outcome: string | null;
  n_corrections: number;
  n_interruptions: number;
}

// Corpus totals for the header.
function corpusTotals(db: Database): {
  nSessions: number;
  nEpisodes: number;
  nJudged: number;
  overallSuccess: number;
} {
  const nSessions =
    (db.query(`SELECT COUNT(*) AS c FROM sessions`).get() as any)?.c ?? 0;
  const nEpisodes =
    (db.query(`SELECT COUNT(*) AS c FROM episodes`).get() as any)?.c ?? 0;
  const nJudged =
    (
      db
        .query(
          `SELECT COUNT(*) AS c FROM episode_labels
           WHERE outcome IN ('success','partial','failed','abandoned')`
        )
        .get() as any
    )?.c ?? 0;
  const nSuccess =
    (
      db
        .query(`SELECT COUNT(*) AS c FROM episode_labels WHERE outcome='success'`)
        .get() as any
    )?.c ?? 0;
  return {
    nSessions,
    nEpisodes,
    nJudged,
    overallSuccess: nJudged > 0 ? nSuccess / nJudged : 0,
  };
}

// Pick one good + one bad exemplar from a cluster's members.
function pickExemplars(
  db: Database,
  memberEpisodeIds: string[]
): { good: ExemplarRow | null; bad: ExemplarRow | null } {
  if (memberEpisodeIds.length === 0) return { good: null, bad: null };
  const placeholders = memberEpisodeIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT e.episode_id AS episode_id,
              e.first_prompt AS first_prompt,
              e.n_corrections AS n_corrections,
              e.n_interruptions AS n_interruptions,
              l.outcome AS outcome
       FROM episodes e
       LEFT JOIN episode_labels l ON l.episode_id = e.episode_id
       WHERE e.episode_id IN (${placeholders})`
    )
    .all(...memberEpisodeIds) as ExemplarRow[];

  const friction = (r: ExemplarRow) =>
    (r.n_corrections ?? 0) + (r.n_interruptions ?? 0);

  // Good: outcome success, lowest friction.
  const goods = rows
    .filter((r) => r.outcome === "success")
    .sort((a, b) => friction(a) - friction(b));
  const good = goods[0] ?? null;

  // Bad: failed/abandoned first; else highest-friction partial/judged; else
  // highest-friction overall.
  const badPriority = rows
    .filter((r) => r.outcome === "failed" || r.outcome === "abandoned")
    .sort((a, b) => friction(b) - friction(a));
  let bad: ExemplarRow | null = badPriority[0] ?? null;
  if (!bad) {
    const partials = rows
      .filter((r) => r.outcome === "partial")
      .sort((a, b) => friction(b) - friction(a));
    bad = partials[0] ?? null;
  }
  if (!bad) {
    const byFriction = [...rows].sort((a, b) => friction(b) - friction(a));
    // only use as "bad" if it actually has friction and isn't the good one
    const cand = byFriction.find(
      (r) => friction(r) > 0 && r.episode_id !== good?.episode_id
    );
    bad = cand ?? null;
  }
  // avoid citing the same episode as both good and bad
  if (bad && good && bad.episode_id === good.episode_id) bad = null;

  return { good, bad };
}

function fmtExemplar(r: ExemplarRow | null): string {
  if (!r) return "_none available_";
  const fric = (r.n_corrections ?? 0) + (r.n_interruptions ?? 0);
  return `\`${r.episode_id}\` : ${oneLine(r.first_prompt, 120)} _(outcome: ${r.outcome ?? "unjudged"}, friction: ${fric})_`;
}

function fmtPatternList(pairs: [string, number][], limit = 3): string {
  if (pairs.length === 0) return "_none_";
  return pairs
    .slice(0, limit)
    .map(([sig, n]) => `\`${sig}\` (×${n})`)
    .join(", ");
}

function fmtFrictionList(pairs: [string, number][], limit = 3): string {
  if (pairs.length === 0) return "_none recorded_";
  return pairs
    .slice(0, limit)
    .map(([what, n]) => `${what} (×${n})`)
    .join("; ");
}

// ── main ──────────────────────────────────────────────────────────────────────
export async function report(
  db: Database,
  opts?: { outDir?: string }
): Promise<void> {
  const outDir = opts?.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const { clusters, candidates } = await mine(db);

  // index candidate by cluster_id; map cluster members.
  const candById = new Map<string, RankedCandidate>();
  for (const c of candidates) candById.set(c.cluster_id, c);
  const membersById = new Map<string, string[]>();
  for (const cl of clusters) membersById.set(cl.clusterId, cl.memberEpisodeIds);

  // compute contrast per cluster (report-side, as the contract intends).
  const contrasts: Record<
    string,
    {
      successPatterns: [string, number][];
      failPatterns: [string, number][];
      recurringFriction: [string, number][];
    }
  > = {};
  for (const cl of clusters) {
    contrasts[cl.clusterId] = await clusterContrast(db, cl.memberEpisodeIds);
  }

  const totals = corpusTotals(db);

  // Split clusters into substantive vs thin (frequency < 3 OR judged < 3).
  const judgedCount = (clusterId: string): number => {
    const members = membersById.get(clusterId) ?? [];
    if (members.length === 0) return 0;
    const placeholders = members.map(() => "?").join(",");
    const r = db
      .query(
        `SELECT COUNT(*) AS c FROM episode_labels
         WHERE outcome IN ('success','partial','failed','abandoned')
           AND episode_id IN (${placeholders})`
      )
      .get(...members) as any;
    return r?.c ?? 0;
  };

  // candidates already sorted by frequency desc; keep that order.
  const substantive: RankedCandidate[] = [];
  const thin: RankedCandidate[] = [];
  for (const c of candidates) {
    const judged = judgedCount(c.cluster_id);
    if (c.frequency < 3 || judged < 3) thin.push(c);
    else substantive.push(c);
  }

  // ── build report.md ─────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Cowork Workflow Miner — Report`);
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push(`## Corpus`);
  lines.push("");
  lines.push(`- Sessions: **${totals.nSessions}**`);
  lines.push(`- Episodes: **${totals.nEpisodes}**`);
  lines.push(
    `- Judged episodes (success/partial/failed/abandoned): **${totals.nJudged}**`
  );
  lines.push(
    `- Overall success rate: **${(totals.overallSuccess * 100).toFixed(0)}%** (of judged)`
  );
  lines.push(`- Task clusters: **${candidates.length}**`);
  lines.push("");
  lines.push(`> **Confidence caveat.** This report is _exemplar-driven, not statistical_.`);
  lines.push(
    `> The corpus is small (N≈${totals.nEpisodes} episodes), clusters are often thin, and`
  );
  lines.push(
    `> outcomes are self-graded by an LLM judge — a bias bounded by a user-behaviour-anchored`
  );
  lines.push(
    `> rubric and stratified calibration, but not eliminated. Treat clusters as leads to`
  );
  lines.push(
    `> investigate (with cited exemplar episodes), not as proven win-rates. \`qa_only\``
  );
  lines.push(`> episodes are excluded from success-rate denominators.`);
  lines.push("");

  const renderCluster = (c: RankedCandidate): void => {
    const members = membersById.get(c.cluster_id) ?? [];
    const contrast = contrasts[c.cluster_id] ?? {
      successPatterns: [],
      failPatterns: [],
      recurringFriction: [],
    };
    const { good, bad } = pickExemplars(db, members);

    lines.push(`### ${c.label}`);
    lines.push("");
    lines.push(
      `- Frequency: **${c.frequency}** episodes across **${c.n_sessions}** session(s)`
    );
    lines.push(`- Success rate: **${(c.success_rate * 100).toFixed(0)}%**`);
    lines.push(`- Median friction (corrections + interruptions): **${c.median_friction}**`);
    lines.push(
      `- Stable success pattern: **${c.has_stable_pattern ? "yes" : "no"}**${
        c.dominant_pattern ? ` — dominant: \`${c.dominant_pattern}\`` : ""
      }`
    );
    lines.push(
      `- Recommended intervention: **${c.recommended_intervention}**`
    );
    if (c.risk_flags.length) {
      lines.push(`- Risk flags: ${c.risk_flags.map((f) => `\`${f}\``).join(", ")}`);
    }
    lines.push(`- Est. effort (median duration × frequency): ~${c.est_effort}s`);
    lines.push("");
    lines.push(`**Good vs bad workflow contrast**`);
    lines.push("");
    lines.push(`- Works (success patterns): ${fmtPatternList(contrast.successPatterns)}`);
    lines.push(`- Flails (fail/partial patterns): ${fmtPatternList(contrast.failPatterns)}`);
    lines.push("");
    lines.push(`**Recurring friction:** ${fmtFrictionList(contrast.recurringFriction)}`);
    lines.push("");
    lines.push(`**Exemplars**`);
    lines.push("");
    lines.push(`- Good: ${fmtExemplar(good)}`);
    lines.push(`- Bad: ${fmtExemplar(bad)}`);
    lines.push("");
  };

  lines.push(`## Task clusters (sufficient evidence)`);
  lines.push("");
  if (substantive.length === 0) {
    lines.push(`_No cluster yet meets the ≥3 episodes AND ≥3 judged bar._`);
    lines.push("");
  } else {
    for (const c of substantive) renderCluster(c);
  }

  lines.push(`## Insufficient evidence`);
  lines.push("");
  lines.push(
    `_These clusters have <3 episodes or <3 judged outcomes. Components are computed best-effort but should not be over-interpreted._`
  );
  lines.push("");
  if (thin.length === 0) {
    lines.push(`_None._`);
    lines.push("");
  } else {
    for (const c of thin) {
      const { good, bad } = pickExemplars(db, membersById.get(c.cluster_id) ?? []);
      lines.push(
        `- **${c.label}** — ${c.frequency} ep / ${c.n_sessions} sess, success ${(c.success_rate * 100).toFixed(0)}%, friction ${c.median_friction}, rec: ${c.recommended_intervention}`
      );
      if (good) lines.push(`  - good exemplar: ${fmtExemplar(good)}`);
      if (bad) lines.push(`  - bad exemplar: ${fmtExemplar(bad)}`);
    }
    lines.push("");
  }

  const mdPath = join(outDir, "report.md");
  writeFileSync(mdPath, lines.join("\n"), "utf8");

  // ── candidates.json ─────────────────────────────────────────────────────────
  const jsonPath = join(outDir, "candidates.json");
  const payload = {
    candidates,
    contrasts,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { openDb } = await import("./db.ts");
  const db = openDb();
  await report(db);
  const outDir = DEFAULT_OUT_DIR;
  console.log(`Wrote:`);
  console.log(`  ${join(outDir, "report.md")}`);
  console.log(`  ${join(outDir, "candidates.json")}`);
  db.close();
}
