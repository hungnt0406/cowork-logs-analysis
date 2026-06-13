// check.ts — structural sanity gate for analysis.db (Tier-1 validation).
//
// Run AFTER a structure pass (`bun run pipeline.ts --no-judge`) to answer
// "is the structure good or nah?" for $0, without any LLM call.
//
//   bun run check                 # uses ./analysis.db
//   bun run check --db other.db
//
// Gate 1 (informational): counts vs the recorded baseline + key distributions.
//   The corpus is the user's own LIVE logs, so small drift is expected and never
//   fails the run — the shape is what matters.
// Gate 2 (hard invariants): each query must return 0. Any non-zero is a FAIL and
//   the process exits non-zero (so this is usable as a CI / pre-judge guard).
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { DEFAULT_DB_PATH } from "./db.ts";

// Recorded baseline (see memory: cowork-logs-analysis-status). Informational only.
const BASELINE = { sessions: 111, turns: 695, episodes: 329, turnsPerEp: 2.11 };

function parseDbPath(argv: string[]): string {
  const i = argv.indexOf("--db");
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : DEFAULT_DB_PATH;
}

// Hard invariants: name + SQL returning a single count column. 0 = pass.
const INVARIANTS: { name: string; sql: string; hint: string }[] = [
  {
    name: "zero_turn_episodes",
    sql: "SELECT COUNT(*) n FROM episodes WHERE n_turns IS NULL OR n_turns < 1",
    hint: "segment synthesized an episode for a human-turn-free session",
  },
  {
    name: "empty_first_prompt",
    sql: "SELECT COUNT(*) n FROM episodes WHERE first_prompt IS NULL OR first_prompt=''",
    hint: "episode has no captured ask (usually same rows as zero_turn_episodes)",
  },
  {
    name: "empty_content_hash",
    sql: "SELECT COUNT(*) n FROM episodes WHERE content_hash IS NULL OR content_hash=''",
    hint: "judge cache key is broken/unstable — would mis-cache or re-pay",
  },
  {
    name: "episodes_missing_features",
    sql: "SELECT COUNT(*) n FROM episodes e LEFT JOIN episode_features f USING(episode_id) WHERE f.episode_id IS NULL",
    hint: "signals/features stage did not run for some episodes",
  },
  {
    name: "orphan_turns",
    sql: "SELECT COUNT(*) n FROM turns t WHERE t.episode_id IS NOT NULL AND t.episode_id NOT IN (SELECT episode_id FROM episodes)",
    hint: "turn points at a non-existent episode (segment/prune bug)",
  },
  {
    name: "orphan_episodes",
    sql: "SELECT COUNT(*) n FROM episodes e WHERE e.session_id NOT IN (SELECT session_id FROM sessions)",
    hint: "episode points at a non-existent session",
  },
  {
    name: "n_episodes_mismatch",
    sql: "SELECT COUNT(*) n FROM sessions s WHERE COALESCE(s.n_episodes,-1) <> (SELECT COUNT(*) FROM episodes e WHERE e.session_id=s.session_id)",
    hint: "sessions.n_episodes disagrees with actual episode rows",
  },
  {
    name: "negative_durations",
    sql: "SELECT COUNT(*) n FROM episode_features WHERE duration_s < 0 OR idle_s < 0",
    hint: "duration/idle computed negative",
  },
  {
    name: "orphan_labels",
    sql: "SELECT COUNT(*) n FROM episode_labels l WHERE l.episode_id NOT IN (SELECT episode_id FROM episodes)",
    hint: "a label references an episode that no longer exists (stale cache)",
  },
];

function num(db: Database, sql: string): number {
  const row = db.query(sql).get() as { [k: string]: number } | null;
  if (!row) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

function main() {
  const dbPath = parseDbPath(process.argv.slice(2));
  if (!existsSync(dbPath)) {
    console.error(
      `[check] no DB at ${dbPath}. Run \`bun run pipeline.ts --no-judge\` first.`
    );
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });

  const sessions = num(db, "SELECT COUNT(*) FROM sessions");
  const turns = num(db, "SELECT COUNT(*) FROM turns");
  const episodes = num(db, "SELECT COUNT(*) FROM episodes");
  if (episodes === 0) {
    console.error(`[check] DB ${dbPath} has 0 episodes — nothing to check.`);
    process.exit(2);
  }
  const turnsPerEp = num(db, "SELECT ROUND(AVG(n_turns),2) FROM episodes");

  // ── Gate 1: counts vs baseline (informational) ──────────────────────────────
  console.log(`Gate 1 — counts (baseline ${BASELINE.sessions}/${BASELINE.turns}/${BASELINE.episodes}/${BASELINE.turnsPerEp}, live corpus so drift is OK)`);
  const pct = (a: number, b: number) => (b ? (((a - b) / b) * 100).toFixed(1) : "—");
  console.log(`  sessions  ${sessions}\t(${pct(sessions, BASELINE.sessions)}%)`);
  console.log(`  turns     ${turns}\t(${pct(turns, BASELINE.turns)}%)`);
  console.log(`  episodes  ${episodes}\t(${pct(episodes, BASELINE.episodes)}%)`);
  console.log(`  turns/ep  ${turnsPerEp}`);

  const dist = db
    .query("SELECT n_turns, COUNT(*) c FROM episodes GROUP BY n_turns ORDER BY n_turns")
    .all() as { n_turns: number; c: number }[];
  const singletons = dist.filter((d) => d.n_turns <= 1).reduce((a, d) => a + d.c, 0);
  const maxTurns = dist.length ? dist[dist.length - 1]!.n_turns : 0;
  console.log(
    `  split: ${singletons}/${episodes} episodes ≤1 turn (${((singletons / episodes) * 100).toFixed(0)}%), ` +
      `largest = ${maxTurns} turns  [watch for over/under-split]`
  );

  // ── Gate 2: hard invariants (each must be 0) ────────────────────────────────
  console.log(`\nGate 2 — hard invariants (each must be 0)`);
  let failed = 0;
  for (const inv of INVARIANTS) {
    const n = num(db, inv.sql);
    const ok = n === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${inv.name.padEnd(26)} ${n}${ok ? "" : `   ← ${inv.hint}`}`);
  }

  db.close();

  console.log("");
  if (failed === 0) {
    console.log(`✅ Gate 2 PASS — ${INVARIANTS.length}/${INVARIANTS.length} invariants clean.`);
    process.exit(0);
  } else {
    console.log(`❌ Gate 2 FAIL — ${failed}/${INVARIANTS.length} invariant(s) broken (see above).`);
    process.exit(1);
  }
}

main();
