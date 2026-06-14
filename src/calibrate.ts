// Calibration — stratified human spot-check + judge self-consistency + auto cross-check.
//
// This is the P0 trust gate before believing the full judge run. It:
//  1. draws a STRATIFIED sample (~25–30) across outcomes + cross-cutting strata,
//  2. in interactive mode, walks you through each (evidence + label + snippet) and
//     records agree/disagree + correct outcome + note → `calibration` table, then
//     reports per-stratum agreement %,
//  3. re-judges ~10 episodes to measure self-consistency (outcome stability),
//  4. runs a tightened auto cross-check that flags only HIGH-PRECISION contradictions.
//
// CLI: bun run src/calibrate.ts [--non-interactive] [--sample N] [--self-consistency K]

import { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { upsertCalibration } from "./db.ts";
import { judgeEpisode } from "./judge.ts";
import { sanitizeRendered } from "./privacy.ts";
import type { CalibrationRow, Outcome } from "./types.ts";

const OUTCOMES: readonly Outcome[] = [
  "success",
  "partial",
  "failed",
  "abandoned",
  "qa_only",
];

const DEFAULT_SAMPLE = 28;
const DEFAULT_SELF_CONSISTENCY = 10;

// ── Stratified sampling ────────────────────────────────────────────────────────

interface SampledEpisode {
  episodeId: string;
  stratum: string;
  outcome: Outcome | null;
  outcomeConfidence: number | null;
  firstPrompt: string;
  workflowPattern: string[];
  frictionPoints: { what: string; evidence: string }[];
  rootCause: string;
}

// A small set of cross-cutting strata, each defined by a SQL predicate over the
// labels/episodes/features/evidence joins. Outcome strata come first so every
// outcome class is represented; cross-cutting strata catch risky episode shapes.
const STRATA: { name: string; where: string }[] = [
  { name: "outcome:success", where: `l.outcome = 'success'` },
  { name: "outcome:partial", where: `l.outcome = 'partial'` },
  { name: "outcome:failed", where: `l.outcome = 'failed'` },
  { name: "outcome:abandoned", where: `l.outcome = 'abandoned'` },
  {
    name: "high-error",
    where: `EXISTS (SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal = 'api_errors')`,
  },
  {
    name: "no-test",
    where: `COALESCE(f.n_test_runs, 0) = 0`,
  },
  {
    name: "pr-created",
    where: `EXISTS (SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal = 'created_pr')`,
  },
  {
    name: "image-heavy",
    where: `COALESCE(e.n_images, 0) > 0`,
  },
  {
    name: "subagent-heavy",
    where: `COALESCE(e.used_subagents, 0) = 1`,
  },
];

function rowToSampled(row: any, stratum: string): SampledEpisode {
  let workflowPattern: string[] = [];
  let frictionPoints: { what: string; evidence: string }[] = [];
  try {
    const wp = JSON.parse(row.workflow_pattern_json ?? "[]");
    if (Array.isArray(wp)) workflowPattern = wp.filter((x) => typeof x === "string");
  } catch {
    /* ignore */
  }
  try {
    const fp = JSON.parse(row.friction_points_json ?? "[]");
    if (Array.isArray(fp)) frictionPoints = fp;
  } catch {
    /* ignore */
  }
  return {
    episodeId: row.episode_id,
    stratum,
    outcome: OUTCOMES.includes(row.outcome) ? row.outcome : null,
    outcomeConfidence:
      typeof row.outcome_confidence === "number" ? row.outcome_confidence : null,
    firstPrompt: row.first_prompt ?? "",
    workflowPattern,
    frictionPoints,
    rootCause: row.root_cause ?? "",
  };
}

// Draw the stratified sample. Round-robin across strata until we hit sampleSize,
// never double-counting an episode (first stratum that claims it wins its tag).
function drawStratifiedSample(db: Database, sampleSize: number): SampledEpisode[] {
  const perStratum: Map<string, any[]> = new Map();
  for (const s of STRATA) {
    const rows = db
      .query(
        `SELECT l.episode_id, l.outcome, l.outcome_confidence,
                l.workflow_pattern_json, l.friction_points_json, l.root_cause,
                e.first_prompt
         FROM episode_labels l
         JOIN episodes e ON e.episode_id = l.episode_id
         LEFT JOIN episode_features f ON f.episode_id = l.episode_id
         WHERE ${s.where}
         ORDER BY RANDOM()`
      )
      .all() as any[];
    perStratum.set(s.name, rows);
  }

  const chosen: SampledEpisode[] = [];
  const taken = new Set<string>();
  const cursors: Map<string, number> = new Map(STRATA.map((s) => [s.name, 0]));

  let progressed = true;
  while (chosen.length < sampleSize && progressed) {
    progressed = false;
    for (const s of STRATA) {
      if (chosen.length >= sampleSize) break;
      const rows = perStratum.get(s.name)!;
      let cur = cursors.get(s.name)!;
      // advance past already-taken episodes
      while (cur < rows.length && taken.has(rows[cur].episode_id)) cur++;
      if (cur < rows.length) {
        const row = rows[cur];
        taken.add(row.episode_id);
        chosen.push(rowToSampled(row, s.name));
        cursors.set(s.name, cur + 1);
        progressed = true;
      } else {
        cursors.set(s.name, cur);
      }
    }
  }
  return chosen;
}

// ── Self-consistency reconstruction ────────────────────────────────────────────
//
// LIMITATION (documented): the full rendered episode is NOT persisted in the DB
// (render.ts output is transient), and rebuilding the exact Episode would require
// re-reading each session's jsonl + re-running classify/segment/signals/subagents.
// For the self-consistency check we therefore re-judge a COMPACT RECONSTRUCTION
// assembled from stored columns: first_prompt + evidence rows + the prior
// workflow_pattern + friction. This is lossier than the original render, so the
// self-consistency rate is a LOWER BOUND on the judge's true stability (a stable
// judge on the lossy input is at least as stable on the full input). We print this
// caveat in the output.

function reconstructCompact(db: Database, ep: SampledEpisode): string {
  const evid = db
    .query(
      `SELECT signal, direction, weight, value, reason
       FROM episode_evidence WHERE episode_id = ? ORDER BY signal`
    )
    .all(ep.episodeId) as any[];

  const lines: string[] = [];
  lines.push(`USER: ${ep.firstPrompt}`);
  lines.push("");
  lines.push(
    "(NOTE: compact reconstruction from stored columns — the full transcript was not persisted.)"
  );
  if (ep.workflowPattern.length) {
    lines.push(`OBSERVED WORKFLOW PHASES: ${ep.workflowPattern.join(" > ")}`);
  }
  if (ep.frictionPoints.length) {
    lines.push("FRICTION OBSERVED:");
    for (const fp of ep.frictionPoints) {
      lines.push(`  - ${fp.what} (${fp.evidence})`);
    }
  }
  lines.push("");
  lines.push("--- EVIDENCE SIGNALS ---");
  if (evid.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of evid) {
      const val = s.value === null || s.value === undefined ? "null" : String(s.value);
      lines.push(`${s.signal} (${s.direction}${s.weight}): ${val} — ${s.reason}`);
    }
  }
  return lines.join("\n");
}

async function runSelfConsistency(
  db: Database,
  sample: SampledEpisode[],
  k: number
): Promise<{ checked: number; matched: number; details: string[] }> {
  const subset = sample.slice(0, k);
  const details: string[] = [];
  let matched = 0;
  let checked = 0;
  for (const ep of subset) {
    // PRIVACY GATE — sanitize the reconstruction before it reaches the LLM judge.
    const rendered = sanitizeRendered(reconstructCompact(db, ep)).text;
    try {
      const { label } = await judgeEpisode(rendered, ep.episodeId);
      checked++;
      const agree = label.outcome === ep.outcome;
      if (agree) matched++;
      details.push(
        `  ${ep.episodeId}: original=${ep.outcome} rejudge=${label.outcome} ${
          agree ? "MATCH" : "DIFFER"
        }`
      );
    } catch (e: any) {
      details.push(`  ${ep.episodeId}: re-judge ERROR — ${e?.message ?? e}`);
    }
  }
  return { checked, matched, details };
}

// ── Auto cross-check (tightened) ───────────────────────────────────────────────
//
// Flag needs_review ONLY on high-precision contradictions. Weak signals
// (api_errors, no-PR, single correction) MUST NOT trigger review.

function runAutoCrossCheck(db: Database): { episodeId: string; reason: string }[] {
  const rows = db
    .query(
      `SELECT l.episode_id, l.outcome,
        EXISTS(SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal='explicit_user_rejection') AS rej,
        EXISTS(SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal='abandoned_mid_edit') AS aband,
        EXISTS(SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal='created_pr') AS pr,
        EXISTS(SELECT 1 FROM episode_evidence ev WHERE ev.episode_id = l.episode_id AND ev.signal='explicit_user_approval') AS appr
       FROM episode_labels l`
    )
    .all() as any[];

  const flagged: { episodeId: string; reason: string }[] = [];
  for (const r of rows) {
    if (r.outcome === "success" && (r.rej || r.aband)) {
      const why = [r.rej ? "explicit_user_rejection" : null, r.aband ? "abandoned_mid_edit" : null]
        .filter(Boolean)
        .join("+");
      flagged.push({ episodeId: r.episode_id, reason: `judge=success but ${why}` });
    } else if (r.outcome === "failed" && (r.pr || r.appr)) {
      const why = [r.pr ? "created_pr" : null, r.appr ? "explicit_user_approval" : null]
        .filter(Boolean)
        .join("+");
      flagged.push({ episodeId: r.episode_id, reason: `judge=failed but ${why}` });
    }
  }
  return flagged;
}

// ── Interactive prompting (Bun stdin) ──────────────────────────────────────────

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length) yield buf;
}

function printEpisodeForReview(db: Database, ep: SampledEpisode): void {
  const evid = db
    .query(
      `SELECT signal, direction, weight, value, reason
       FROM episode_evidence WHERE episode_id = ? ORDER BY signal`
    )
    .all(ep.episodeId) as any[];

  console.log("\n" + "=".repeat(72));
  console.log(`EPISODE ${ep.episodeId}   [stratum: ${ep.stratum}]`);
  console.log("-".repeat(72));
  console.log(`first_prompt: ${ep.firstPrompt.slice(0, 400)}`);
  console.log(
    `judge outcome: ${ep.outcome} (confidence ${ep.outcomeConfidence ?? "?"})`
  );
  console.log(`workflow_pattern: ${ep.workflowPattern.join(" > ") || "(none)"}`);
  if (ep.frictionPoints.length) {
    console.log("friction_points:");
    for (const fp of ep.frictionPoints) console.log(`  - ${fp.what} :: ${fp.evidence}`);
  }
  console.log(`root_cause: ${ep.rootCause || "(none)"}`);
  console.log("evidence:");
  if (evid.length === 0) console.log("  (none)");
  for (const s of evid) {
    const val = s.value === null || s.value === undefined ? "null" : String(s.value);
    console.log(`  ${s.signal} (${s.direction}${s.weight}): ${val} — ${s.reason}`);
  }
  console.log("-".repeat(72));
}

async function interactiveReview(
  db: Database,
  sample: SampledEpisode[]
): Promise<void> {
  console.log(
    `\nInteractive calibration: ${sample.length} episodes.\n` +
      `For each: enter agree? [y/n], correct outcome (${OUTCOMES.join("|")} or blank to keep), note.\n`
  );
  const lines = readLines();
  const now = new Date().toISOString();

  for (const ep of sample) {
    printEpisodeForReview(db, ep);

    process.stdout.write("agree with judge outcome? [y/n] (q to quit): ");
    const a = (await lines.next()).value?.trim().toLowerCase() ?? "";
    if (a === "q") {
      console.log("Quitting interactive review early.");
      break;
    }
    const agrees = a === "y" || a === "yes";

    process.stdout.write(
      `correct outcome [${OUTCOMES.join("|")}] (blank = ${
        agrees ? `keep ${ep.outcome}` : "none recorded"
      }): `
    );
    let humanRaw = (await lines.next()).value?.trim() ?? "";
    // The human label must reflect what the HUMAN said — never silently echo the
    // judge's label on a blank disagreement (that would inflate label agreement).
    //  - typed valid outcome     → that label
    //  - blank + agreed          → the judge's outcome (they endorsed it)
    //  - blank + disagreed       → null (we have no human label; don't fabricate one)
    let humanOutcome: Outcome | null;
    if (humanRaw && OUTCOMES.includes(humanRaw as Outcome)) {
      humanOutcome = humanRaw as Outcome;
    } else {
      if (humanRaw) console.log(`  (unrecognized "${humanRaw}", recording agreement only)`);
      humanOutcome = agrees ? ep.outcome : null;
    }

    process.stdout.write("note (optional): ");
    const note = (await lines.next()).value?.trim() ?? "";

    const row: CalibrationRow = {
      episodeId: ep.episodeId,
      stratum: ep.stratum,
      humanOutcome,
      humanNotes: note,
      agrees,
      checkedAt: now,
    };
    upsertCalibration(db, row);
  }
}

// ── Reporting ──────────────────────────────────────────────────────────────────

function reportPerStratumAgreement(db: Database): void {
  const rows = db
    .query(
      `SELECT stratum,
              COUNT(*) AS n,
              SUM(CASE WHEN agrees = 1 THEN 1 ELSE 0 END) AS agree,
              SUM(CASE WHEN agrees IS NULL THEN 1 ELSE 0 END) AS pending
       FROM calibration
       GROUP BY stratum
       ORDER BY stratum`
    )
    .all() as any[];

  console.log("\n--- Per-stratum agreement ---");
  if (rows.length === 0) {
    console.log("(no calibration rows)");
    return;
  }
  let totN = 0;
  let totAgree = 0;
  let totScored = 0;
  for (const r of rows) {
    const scored = r.n - r.pending;
    const pct = scored > 0 ? ((r.agree / scored) * 100).toFixed(0) + "%" : "—";
    console.log(
      `  ${r.stratum.padEnd(20)} n=${r.n}  scored=${scored}  agree=${pct}` +
        (r.pending ? `  (pending=${r.pending})` : "")
    );
    totN += r.n;
    totScored += scored;
    totAgree += r.agree;
  }
  const overall = totScored > 0 ? ((totAgree / totScored) * 100).toFixed(0) + "%" : "—";
  console.log(`  ${"OVERALL".padEnd(20)} n=${totN}  scored=${totScored}  agree=${overall}`);
}

// Label-based agreement: compare the recorded human_outcome against the judge's
// outcome directly (the y/n tally above can hide WHICH outcomes get confused).
// This is the measure the calibration set actually exists to produce.
function reportLabelAgreement(db: Database): void {
  const rows = db
    .query(
      `SELECT c.human_outcome AS human, l.outcome AS judge
       FROM calibration c
       JOIN episode_labels l ON l.episode_id = c.episode_id
       WHERE c.human_outcome IS NOT NULL`
    )
    .all() as { human: string; judge: string }[];

  console.log("\n--- Label agreement (human_outcome vs judge outcome) ---");
  if (rows.length === 0) {
    console.log("  (no human outcomes recorded — agree without a correction counts; blank disagreements are excluded)");
    return;
  }
  let match = 0;
  const confusion = new Map<string, number>();
  for (const r of rows) {
    if (r.human === r.judge) match++;
    else {
      const k = `${r.judge} → ${r.human}`;
      confusion.set(k, (confusion.get(k) ?? 0) + 1);
    }
  }
  const pct = ((match / rows.length) * 100).toFixed(0);
  console.log(`  ${match}/${rows.length} exact-outcome match (${pct}%)`);
  if (confusion.size) {
    console.log("  disagreements (judge → human):");
    for (const [k, n] of [...confusion.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}: ${n}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function runCalibration(
  db: Database,
  opts?: { sampleSize?: number; selfConsistency?: number; nonInteractive?: boolean }
): Promise<void> {
  const sampleSize = opts?.sampleSize ?? DEFAULT_SAMPLE;
  const k = opts?.selfConsistency ?? DEFAULT_SELF_CONSISTENCY;
  const nonInteractive = opts?.nonInteractive ?? false;

  const sample = drawStratifiedSample(db, sampleSize);
  console.log(`Stratified sample: ${sample.length} episodes (requested ${sampleSize}).`);
  for (const ep of sample) {
    console.log(
      `  [${ep.stratum.padEnd(18)}] ${ep.episodeId}  outcome=${ep.outcome}  ${ep.firstPrompt.slice(0, 60)}`
    );
  }

  const now = new Date().toISOString();

  if (nonInteractive) {
    // Populate calibration rows with no human verdict so the sample machinery is
    // testable in the smoke run. human_outcome=null, agrees=null.
    for (const ep of sample) {
      const row: CalibrationRow = {
        episodeId: ep.episodeId,
        stratum: ep.stratum,
        humanOutcome: null,
        humanNotes: "",
        agrees: null,
        checkedAt: now,
      };
      upsertCalibration(db, row);
    }
    console.log("\n(non-interactive: recorded sample rows with no human verdict)");
  } else {
    await interactiveReview(db, sample);
    reportPerStratumAgreement(db);
    reportLabelAgreement(db);
  }

  // Self-consistency (re-judge a subset on a compact reconstruction).
  if (k > 0 && sample.length > 0) {
    console.log(
      `\n--- Self-consistency: re-judging ${Math.min(k, sample.length)} episodes ---`
    );
    console.log(
      "NOTE: re-judged on a COMPACT RECONSTRUCTION (first_prompt + evidence + " +
        "workflow_pattern), not the original full transcript (not persisted). " +
        "The match rate is a LOWER BOUND on true judge stability."
    );
    const sc = await runSelfConsistency(db, sample, k);
    for (const line of sc.details) console.log(line);
    const rate =
      sc.checked > 0 ? ((sc.matched / sc.checked) * 100).toFixed(0) + "%" : "—";
    console.log(
      `self-consistency: ${sc.matched}/${sc.checked} outcomes stable (${rate})`
    );
  }

  // Auto cross-check (tightened, high-precision contradictions only).
  console.log("\n--- Auto cross-check (high-precision contradictions) ---");
  const flagged = runAutoCrossCheck(db);
  if (flagged.length === 0) {
    console.log("(no contradictions flagged)");
  } else {
    for (const f of flagged) {
      console.log(`  needs_review: ${f.episodeId} — ${f.reason}`);
    }
    console.log(`flagged ${flagged.length} episode(s) for review.`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: { sampleSize?: number; selfConsistency?: number; nonInteractive?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--non-interactive") opts.nonInteractive = true;
    else if (a === "--sample") opts.sampleSize = Number(args[++i]);
    else if (a === "--self-consistency") opts.selfConsistency = Number(args[++i]);
  }
  const db = openDb();
  await runCalibration(db, opts);
}
