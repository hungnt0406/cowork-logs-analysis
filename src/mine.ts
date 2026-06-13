// mine.ts — cluster task_type into task clusters, compute transparent ranking
// COMPONENTS (no composite score), and expose a good-vs-bad workflow contrast.
//
// Pipeline:
//   1. string-normalize task_type (lowercase/trim/strip-punct/canonical synonyms)
//   2. ONE cheap `claude -p --output-format json` grouping pass over the distinct
//      normalized labels → {raw -> cluster_label} mapping (gated by USE_LLM_CLUSTERING,
//      ON by default; ANY failure falls back to pure string-normalization clusters).
//   3. per cluster, compute RankedCandidate components (frequency, n_sessions,
//      success_rate, median_friction, has_stable_pattern, dominant_pattern,
//      risk_flags, est_effort, recommended_intervention).
//
// Exports: mine(db), clusterContrast(db, memberEpisodeIds).
import { Database } from "bun:sqlite";
import type {
  TaskCluster,
  RankedCandidate,
  Outcome,
  SkillType,
} from "./types.ts";
import { median } from "./util.ts";
import { runnerEnv } from "./runner.ts";

// Internal flag: LLM grouping pass ON by default, gated so it can be disabled
// (e.g. for deterministic tests) without code changes. Falls back gracefully.
const USE_LLM_CLUSTERING =
  (process.env.MINE_LLM_CLUSTERING ?? "1") !== "0";
const LLM_TIMEOUT_MS = Number(process.env.MINE_LLM_TIMEOUT_MS ?? 30000);

// Small-N honesty thresholds (the corpus is ~150–250 tasks; clusters are thin).
const MIN_PATTERN_N = 3; // min SUCCESS episodes before a pattern counts as "stable"
const MIN_CONFIDENT_N = 5; // min judged episodes before rate/pattern are trustworthy

// ── DB row shapes (loosely typed; only the columns we read) ───────────────────
interface EpisodeRow {
  episode_id: string;
  session_id: string;
  n_corrections: number;
  n_interruptions: number;
  first_prompt: string | null;
  // features (LEFT JOIN — may be null when no features row)
  duration_s: number | null;
  tool_sequence: string | null;
  n_files_read: number | null;
  n_files_edited: number | null;
  // label (LEFT JOIN — may be null when unjudged)
  task_type: string | null;
  outcome: string | null;
  workflow_pattern_json: string | null;
  skill_opportunity_json: string | null;
}

// ── String normalization + synonym canonicalization ───────────────────────────
// Maps obvious synonyms to a canonical label. Checked after base normalization.
const SYNONYMS: Array<[RegExp, string]> = [
  [/^(bug ?fix|fix ?bug|bug|fixe?s?|fixing|defect|hotfix|patch)$/, "bug fix"],
  [
    /^(feature|feature implementation|new feature|implement(ation)?|build feature)$/,
    "feature",
  ],
  [/^(refactor(ing)?|cleanup|clean up|restructur(e|ing))$/, "refactor"],
  [/^(test(ing)?|add tests?|unit tests?|write tests?)$/, "testing"],
  [/^(docs?|documentation|document(ing)?|readme)$/, "documentation"],
  [/^(config(uration)?|setup|set up|configure)$/, "configuration"],
  [/^(deploy(ment)?|release|ship(ping)?|publish)$/, "deployment"],
  [/^(perf(ormance)?|optimiz(e|ation)|speed ?up)$/, "performance"],
  [/^(research|investigat(e|ion)|explore|exploration|spike)$/, "research"],
  [/^(review|code review|pr review)$/, "review"],
  [/^(question|q ?and ?a|qa|ask|query)$/, "question"],
  [/^(ui|ux|ui ?\/? ?ux|styling|style|css|design)$/, "ui"],
  [/^(data|data analysis|analysis|analytics)$/, "data analysis"],
];

export function normalizeTaskType(raw: string): string {
  let s = (raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[_\/]+/g, " ") // underscores/slashes → space
    .replace(/[^a-z0-9 ]+/g, "") // strip remaining punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "uncategorized";
  // crude singularization for the trailing token (cats→cat, fixes→fixe handled by synonyms)
  s = s.replace(/\b(\w+?)s\b/g, (m, w) =>
    w.length > 3 && !/(ss|us|is)$/.test(m) ? w : m
  );
  for (const [re, canon] of SYNONYMS) {
    if (re.test(s)) return canon;
  }
  return s;
}

// Stable slug for a cluster label → cluster_id.
export function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "uncategorized";
}

// Canonical signature of an ordered workflow_pattern array.
function patternSignature(pattern: string[] | null | undefined): string {
  if (!Array.isArray(pattern) || pattern.length === 0) return "";
  return pattern
    .map((p) => String(p).toLowerCase().trim())
    .filter((p) => p.length > 0)
    .join(">");
}

function safeParseArray(json: string | null | undefined): any[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeParseObject(json: string | null | undefined): Record<string, any> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ── LLM grouping pass (optional, graceful fallback) ───────────────────────────
// Takes distinct normalized task_types, asks for {raw -> cluster_label}.
// Returns null on ANY failure so the caller falls back to identity clustering.
async function llmGroupTaskTypes(
  normalized: string[],
  timeoutMs = LLM_TIMEOUT_MS
): Promise<Map<string, string> | null> {
  if (normalized.length === 0) return null;
  const rubric = `You are grouping software-engineering task-type labels into a small set of clusters.
Given a JSON array of distinct task-type strings, merge near-duplicates and obvious synonyms
into shared cluster labels (e.g. "bug fix" and "defect repair" → "bug fix"). Keep labels short,
lowercase, human-readable. Do NOT invent tasks that aren't represented. Return ONLY a JSON object
mapping each input string to its cluster label: {"<input>": "<cluster label>", ...}.`;
  const prompt = `${rubric}\n\n## INPUT\n${JSON.stringify(normalized)}\n`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const proc = Bun.spawn(["claude", "-p", "--output-format", "json"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: ctrl.signal,
      env: { ...process.env, ...(await runnerEnv()) },
    });
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);

    const envelope = JSON.parse(out);
    const inner = typeof envelope?.result === "string" ? envelope.result : out;
    const match = inner.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : inner);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

    const map = new Map<string, string>();
    for (const key of normalized) {
      const v = obj[key];
      // Only accept non-empty string cluster labels; otherwise identity.
      map.set(
        key,
        typeof v === "string" && v.trim() ? v.toLowerCase().trim() : key
      );
    }
    return map;
  } catch {
    clearTimeout(timer);
    return null; // never throw, never block — caller falls back
  }
}

// ── Outcome helpers ───────────────────────────────────────────────────────────
function isSuccess(outcome: string | null): boolean {
  return outcome === "success";
}
// Judged = has a label row (outcome non-null). qa_only is EXCLUDED from the
// success-rate denominator (it is a read-only Q&A turn, not a task attempt that
// can "succeed" or "fail"); it still counts toward frequency.
function isJudgedForRate(outcome: string | null): boolean {
  return (
    outcome === "success" ||
    outcome === "partial" ||
    outcome === "failed" ||
    outcome === "abandoned"
  );
}

// ── Risk-flag scanning (DB columns only: first_prompt, tool_sequence, evidence) ─
const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/rm\s+-rf|rm\s+-fr|rm\s+-[a-z]*r[a-z]*f/i, "rm -rf"],
  [/push\s+--force|force[- ]push|push\s+-f\b|--force-with-lease/i, "force-push"],
  [/\bdrop\s+(table|database|schema|index|column)\b/i, "DROP (SQL)"],
  [/\bdeploy(ment|ing|ed)?\b|\bgit\s+push\s+.*prod|\bvercel\s+--prod|\bkubectl\s+apply/i, "deploy"],
  [/\btruncate\s+table\b/i, "TRUNCATE (SQL)"],
];
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key)\b/i, "secrets/credentials"],
  [/\bsk-[a-z0-9]{16,}\b/i, "secret-like token"],
  [/AKIA[0-9A-Z]{12,}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "PII (SSN-like)"],
];

function scanRiskFlags(rows: EpisodeRow[], evidenceTexts: string[]): string[] {
  const flags = new Set<string>();
  const corpus: string[] = [];
  for (const r of rows) {
    if (r.first_prompt) corpus.push(r.first_prompt);
    if (r.tool_sequence) corpus.push(r.tool_sequence);
  }
  corpus.push(...evidenceTexts);
  const blob = corpus.join("\n");

  for (const [re, label] of DESTRUCTIVE_PATTERNS) {
    if (re.test(blob)) flags.add(`destructive: ${label}`);
  }
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(blob)) flags.add(`sensitive: ${label}`);
  }

  // write/delete-heavy: aggregate edited vs read across the cluster.
  let edited = 0;
  let read = 0;
  for (const r of rows) {
    edited += r.n_files_edited ?? 0;
    read += r.n_files_read ?? 0;
  }
  if (edited >= 5 && edited > read * 2) {
    flags.add("write-heavy (edits >> reads)");
  }

  return [...flags];
}

// ── recommended_intervention via majority vote of skill_opportunity labels ────
function recommendIntervention(
  rows: EpisodeRow[],
  judgedCount: number,
  successRate: number
): SkillType {
  // Thin or low-success clusters default to "none".
  if (judgedCount < 3 || successRate < 0.34) return "none";

  let worthYes = 0;
  let worthTotal = 0;
  const typeVotes = new Map<SkillType, number>();
  for (const r of rows) {
    const so = safeParseObject(r.skill_opportunity_json);
    if (so.worth_codifying === undefined) continue;
    worthTotal++;
    if (so.worth_codifying === true) worthYes++;
    const t = so.type;
    if (t === "skill" || t === "script" || t === "sop" || t === "none") {
      typeVotes.set(t, (typeVotes.get(t) ?? 0) + 1);
    }
  }
  if (worthTotal === 0) return "none";
  // Majority of judged episodes must think it's worth codifying.
  if (worthYes / worthTotal < 0.5) return "none";

  // Pick the most-voted concrete type (excluding "none" unless it dominates).
  let best: SkillType = "none";
  let bestN = -1;
  for (const [t, n] of typeVotes) {
    if (t === "none") continue;
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best === "none" || bestN <= 0 ? "skill" : best;
}

// ── Core query: all episodes joined with features + labels ────────────────────
function loadEpisodes(db: Database): EpisodeRow[] {
  return db
    .query(
      `SELECT
         e.episode_id           AS episode_id,
         e.session_id           AS session_id,
         e.n_corrections        AS n_corrections,
         e.n_interruptions      AS n_interruptions,
         e.first_prompt         AS first_prompt,
         f.duration_s           AS duration_s,
         f.tool_sequence        AS tool_sequence,
         f.n_files_read         AS n_files_read,
         f.n_files_edited       AS n_files_edited,
         l.task_type            AS task_type,
         l.outcome              AS outcome,
         l.workflow_pattern_json AS workflow_pattern_json,
         l.skill_opportunity_json AS skill_opportunity_json
       FROM episodes e
       LEFT JOIN episode_features f ON f.episode_id = e.episode_id
       LEFT JOIN episode_labels   l ON l.episode_id = e.episode_id`
    )
    .all() as EpisodeRow[];
}

// Evidence reason text per episode (for risk scanning).
function loadEvidenceByEpisode(db: Database): Map<string, string[]> {
  const rows = db
    .query(`SELECT episode_id, signal, reason, value FROM episode_evidence`)
    .all() as Array<{
    episode_id: string;
    signal: string | null;
    reason: string | null;
    value: string | null;
  }>;
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.episode_id) ?? [];
    arr.push(
      [r.signal ?? "", r.reason ?? "", r.value ?? ""].filter(Boolean).join(" ")
    );
    map.set(r.episode_id, arr);
  }
  return map;
}

// ── clusterContrast: success vs fail workflow patterns + recurring friction ───
// report.ts calls this per cluster. Returns frequency-sorted [signature, count]
// pairs so the report can show "pattern A works / pattern B flails".
export async function clusterContrast(
  db: Database,
  memberEpisodeIds: string[]
): Promise<{
  successPatterns: [string, number][];
  failPatterns: [string, number][];
  recurringFriction: [string, number][];
}> {
  if (memberEpisodeIds.length === 0) {
    return { successPatterns: [], failPatterns: [], recurringFriction: [] };
  }
  const placeholders = memberEpisodeIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT l.outcome AS outcome,
              l.workflow_pattern_json AS workflow_pattern_json,
              l.friction_points_json AS friction_points_json
       FROM episode_labels l
       WHERE l.episode_id IN (${placeholders})`
    )
    .all(...memberEpisodeIds) as Array<{
    outcome: string | null;
    workflow_pattern_json: string | null;
    friction_points_json: string | null;
  }>;

  const success = new Map<string, number>();
  const fail = new Map<string, number>();
  const friction = new Map<string, number>();

  for (const r of rows) {
    const sig = patternSignature(safeParseArray(r.workflow_pattern_json));
    if (sig) {
      if (isSuccess(r.outcome)) {
        success.set(sig, (success.get(sig) ?? 0) + 1);
      } else if (
        r.outcome === "failed" ||
        r.outcome === "partial" ||
        r.outcome === "abandoned"
      ) {
        fail.set(sig, (fail.get(sig) ?? 0) + 1);
      }
    }
    for (const fp of safeParseArray(r.friction_points_json)) {
      const what =
        fp && typeof fp === "object" && typeof fp.what === "string"
          ? fp.what.toLowerCase().trim()
          : typeof fp === "string"
            ? fp.toLowerCase().trim()
            : "";
      if (what) friction.set(what, (friction.get(what) ?? 0) + 1);
    }
  }

  const sortDesc = (m: Map<string, number>): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    successPatterns: sortDesc(success),
    failPatterns: sortDesc(fail),
    recurringFriction: sortDesc(friction),
  };
}

// ── mine: cluster + rank ──────────────────────────────────────────────────────
export async function mine(
  db: Database
): Promise<{ clusters: TaskCluster[]; candidates: RankedCandidate[] }> {
  const episodes = loadEpisodes(db);
  const evidenceByEp = loadEvidenceByEpisode(db);

  // Step 1: normalize task_type for every JUDGED episode (unjudged → no task_type,
  // cannot be clustered by type; they still exist in DB but aren't grouped here).
  // We map each episode to a normalized label; unlabeled ones get "uncategorized".
  const normByEp = new Map<string, string>();
  const distinctNorm = new Set<string>();
  for (const e of episodes) {
    if (e.task_type == null) continue; // unjudged: not clusterable by task_type
    const norm = normalizeTaskType(e.task_type);
    normByEp.set(e.episode_id, norm);
    distinctNorm.add(norm);
  }

  // Step 2: optional LLM grouping pass over the distinct normalized labels.
  let groupMap: Map<string, string> | null = null;
  if (USE_LLM_CLUSTERING && distinctNorm.size > 1) {
    groupMap = await llmGroupTaskTypes([...distinctNorm]);
  }
  // Fallback: identity map (each normalized label is its own cluster).
  const clusterLabelOf = (norm: string): string =>
    groupMap?.get(norm) ?? norm;

  // Build clusters: label -> member episode ids.
  const clusterMembers = new Map<string, string[]>();
  const clusterLabelById = new Map<string, string>();
  for (const e of episodes) {
    const norm = normByEp.get(e.episode_id);
    if (norm == null) continue;
    const label = clusterLabelOf(norm);
    const cid = slugify(label);
    clusterLabelById.set(cid, label);
    const arr = clusterMembers.get(cid) ?? [];
    arr.push(e.episode_id);
    clusterMembers.set(cid, arr);
  }

  // Index episodes by id for per-cluster component computation.
  const epById = new Map<string, EpisodeRow>();
  for (const e of episodes) epById.set(e.episode_id, e);

  // Build + persist TaskClusters.
  const clusters: TaskCluster[] = [];
  for (const [cid, members] of clusterMembers) {
    const cluster: TaskCluster = {
      clusterId: cid,
      label: clusterLabelById.get(cid) ?? cid,
      memberEpisodeIds: members,
    };
    clusters.push(cluster);
  }
  // Persist (separate from build so a DB hiccup on one doesn't lose the rest).
  const { upsertCluster } = await import("./db.ts");
  for (const c of clusters) {
    try {
      upsertCluster(db, c);
    } catch {
      /* never block mining on a persistence hiccup */
    }
  }

  // Step 3: ranking components per cluster (all clusters, even <3 — flagged via
  // frequency so report can mark "insufficient evidence"; columns best-effort).
  const candidates: RankedCandidate[] = [];
  for (const c of clusters) {
    const rows = c.memberEpisodeIds
      .map((id) => epById.get(id))
      .filter((r): r is EpisodeRow => !!r);

    const frequency = rows.length;
    const n_sessions = new Set(rows.map((r) => r.session_id)).size;

    // success_rate over judged-for-rate episodes (qa_only excluded from denom).
    const judgedRows = rows.filter((r) => isJudgedForRate(r.outcome));
    const successCount = judgedRows.filter((r) => isSuccess(r.outcome)).length;
    const success_rate =
      judgedRows.length > 0 ? successCount / judgedRows.length : 0;

    // median friction over ALL member episodes.
    const median_friction = median(
      rows.map((r) => (r.n_corrections ?? 0) + (r.n_interruptions ?? 0))
    );

    // has_stable_pattern: max share of one workflow signature among SUCCESS eps.
    const successSigs = rows
      .filter((r) => isSuccess(r.outcome))
      .map((r) => patternSignature(safeParseArray(r.workflow_pattern_json)))
      .filter((s) => s.length > 0);
    let dominant_pattern: string | null = null;
    let has_stable_pattern = false;
    if (successSigs.length > 0) {
      const counts = new Map<string, number>();
      for (const s of successSigs) counts.set(s, (counts.get(s) ?? 0) + 1);
      let bestSig = "";
      let bestN = 0;
      for (const [s, n] of counts) {
        if (n > bestN) {
          bestN = n;
          bestSig = s;
        }
      }
      const share = bestN / successSigs.length;
      // Require a MINIMUM number of successes before a pattern can be called "stable" —
      // otherwise 1/1 = 1.0 trivially clears the 0.5 bar and overclaims at n=1.
      has_stable_pattern = successSigs.length >= MIN_PATTERN_N && share >= 0.5;
      dominant_pattern = bestSig || null;
    }

    // risk flags.
    const evidenceTexts: string[] = [];
    for (const r of rows) {
      const ev = evidenceByEp.get(r.episode_id);
      if (ev) evidenceTexts.push(...ev);
    }
    const risk_flags = scanRiskFlags(rows, evidenceTexts);

    // est_effort = median(duration_s) * frequency (informational).
    const durations = rows
      .map((r) => r.duration_s)
      .filter((d): d is number => typeof d === "number" && !isNaN(d));
    const est_effort = Math.round(median(durations) * frequency);

    const recommended_intervention = recommendIntervention(
      rows,
      judgedRows.length,
      success_rate
    );

    // Laplace-smoothed rate ((s+1)/(n+2)) pulls tiny samples toward 0.5 so a 1/1
    // cluster (raw 100%) can't outrank a 47/50 cluster (raw 94%) on the smoothed view.
    const success_rate_smoothed =
      (successCount + 1) / (judgedRows.length + 2);
    const low_confidence = judgedRows.length < MIN_CONFIDENT_N;

    candidates.push({
      cluster_id: c.clusterId,
      label: c.label,
      frequency,
      n_sessions,
      success_rate: Number(success_rate.toFixed(4)),
      median_friction,
      has_stable_pattern,
      dominant_pattern,
      risk_flags,
      est_effort,
      recommended_intervention,
      low_confidence,
      success_rate_smoothed: Number(success_rate_smoothed.toFixed(4)),
      n_judged: judgedRows.length,
    });
  }

  // Default DISPLAY ordering: frequency desc, then success_rate desc. The DB and
  // candidates.json keep every component separate — this sort is for display only.
  candidates.sort(
    (a, b) => b.frequency - a.frequency || b.success_rate - a.success_rate
  );

  return { clusters, candidates };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { openDb } = await import("./db.ts");
  const db = openDb();
  const { candidates } = await mine(db);

  if (candidates.length === 0) {
    console.log("No clusters found (is the DB populated with labels?).");
  } else {
    console.log(
      `\n${candidates.length} task cluster(s) — ranked (display: frequency, then success_rate):\n`
    );
    const header = [
      "cluster",
      "freq",
      "sess",
      "succ%",
      "smTH%",
      "n_jd",
      "fric",
      "stable",
      "conf",
      "rec",
      "risk",
    ];
    console.log(header.join("\t"));
    for (const c of candidates) {
      console.log(
        [
          c.label.slice(0, 24),
          c.frequency,
          c.n_sessions,
          (c.success_rate * 100).toFixed(0) + "%",
          ((c.success_rate_smoothed ?? 0) * 100).toFixed(0) + "%",
          c.n_judged ?? 0,
          c.median_friction,
          c.has_stable_pattern ? "y" : "n",
          c.low_confidence ? "LOW" : "ok",
          c.recommended_intervention,
          c.risk_flags.length ? c.risk_flags.join("; ") : "-",
        ].join("\t")
      );
    }
    console.log(
      "\n(succ% = raw success rate; smTH% = Laplace-smoothed; conf=LOW means < " +
        MIN_CONFIDENT_N +
        " judged episodes — treat as a lead, not a statistic.)\n"
    );
  }
  db.close();
}
