// SQLite persistence layer (bun:sqlite). Open + migrate + idempotent upserts + judge cache check.
// All modules persist through these functions — do not write raw SQL elsewhere.
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import type {
  SessionInfo,
  ClassifiedTurn,
  Episode,
  JudgeLabel,
  JudgeMeta,
  CalibrationRow,
  TaskCluster,
} from "./types.ts";

export const DEFAULT_DB_PATH = `${import.meta.dir}/../analysis.db`;

export function openDb(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const ddl = readFileSync(`${import.meta.dir}/schema.sql`, "utf8");
  db.exec(ddl);
}

// ── Sessions ──────────────────────────────────────────────────────────────────
export function upsertSession(db: Database, s: SessionInfo, nEpisodes: number): void {
  db.query(
    `INSERT INTO sessions (session_id, project, path, started_at, completed_at, n_episodes)
     VALUES ($id, $project, $path, $start, $end, $n)
     ON CONFLICT(session_id) DO UPDATE SET
       project=excluded.project, path=excluded.path, started_at=excluded.started_at,
       completed_at=excluded.completed_at, n_episodes=excluded.n_episodes`
  ).run({
    $id: s.sessionId,
    $project: s.project,
    $path: s.jsonlPath,
    $start: s.startedAt,
    $end: s.completedAt,
    $n: nEpisodes,
  });
}

// ── Turns ─────────────────────────────────────────────────────────────────────
export function upsertTurn(db: Database, t: ClassifiedTurn): void {
  db.query(
    `INSERT INTO turns (turn_id, session_id, idx, role, char_len, n_images, ts, episode_id, classified_by, text_preview)
     VALUES ($id, $session, $idx, $role, $clen, $nimg, $ts, $ep, $by, $prev)
     ON CONFLICT(turn_id) DO UPDATE SET
       role=excluded.role, char_len=excluded.char_len, n_images=excluded.n_images,
       ts=excluded.ts, episode_id=excluded.episode_id, classified_by=excluded.classified_by,
       text_preview=excluded.text_preview`
  ).run({
    $id: `${t.sessionId}#t${t.idx}`,
    $session: t.sessionId,
    $idx: t.idx,
    $role: t.role,
    $clen: t.charLen,
    $nimg: t.nImages,
    $ts: t.ts,
    $ep: t.episodeId ?? null,
    $by: t.classifiedBy,
    $prev: t.text.slice(0, 200),
  });
}

// ── Episodes (+ features + evidence) ──────────────────────────────────────────
export function upsertEpisode(db: Database, e: Episode): void {
  db.query(
    `INSERT INTO episodes (episode_id, session_id, idx, task_key, start_turn, n_turns,
       n_corrections, n_interruptions, n_approvals, n_images, used_subagents,
       subagent_summary, first_prompt, started_at, ended_at, content_hash)
     VALUES ($id,$session,$idx,$tk,$start,$nturns,$ncorr,$nint,$napp,$nimg,$sub,
       $subsum,$fp,$sa,$ea,$ch)
     ON CONFLICT(episode_id) DO UPDATE SET
       idx=excluded.idx, task_key=excluded.task_key, start_turn=excluded.start_turn,
       n_turns=excluded.n_turns, n_corrections=excluded.n_corrections,
       n_interruptions=excluded.n_interruptions, n_approvals=excluded.n_approvals,
       n_images=excluded.n_images, used_subagents=excluded.used_subagents,
       subagent_summary=excluded.subagent_summary, first_prompt=excluded.first_prompt,
       started_at=excluded.started_at, ended_at=excluded.ended_at, content_hash=excluded.content_hash`
  ).run({
    $id: e.episodeId,
    $session: e.sessionId,
    $idx: e.idx,
    $tk: e.taskKey ?? null,
    $start: e.startTurnIdx,
    $nturns: e.nTurns,
    $ncorr: e.nCorrections,
    $nint: e.nInterruptions,
    $napp: e.nApprovals,
    $nimg: e.nImages,
    $sub: e.usedSubagents ? 1 : 0,
    $subsum: JSON.stringify(e.subagentSummaries ?? []),
    $fp: e.firstPrompt,
    $sa: e.startedAt,
    $ea: e.endedAt,
    $ch: e.contentHash,
  });

  // features
  const f = e.features;
  if (f) {
    db.query(
      `INSERT INTO episode_features (episode_id, n_tool_calls, tool_sequence, n_files_read,
         n_files_edited, n_test_runs, duration_s, idle_s, tokens)
       VALUES ($id,$ntc,$seq,$nr,$ne,$nt,$dur,$idle,$tok)
       ON CONFLICT(episode_id) DO UPDATE SET
         n_tool_calls=excluded.n_tool_calls, tool_sequence=excluded.tool_sequence,
         n_files_read=excluded.n_files_read, n_files_edited=excluded.n_files_edited,
         n_test_runs=excluded.n_test_runs, duration_s=excluded.duration_s,
         idle_s=excluded.idle_s, tokens=excluded.tokens`
    ).run({
      $id: e.episodeId,
      $ntc: f.nToolCalls,
      $seq: f.toolSequence,
      $nr: f.nFilesRead,
      $ne: f.nFilesEdited,
      $nt: f.nTestRuns,
      $dur: f.durationS,
      $idle: f.idleS,
      $tok: f.tokens,
    });
  }

  // evidence — replace-all for this episode (idempotent re-runs)
  db.query(`DELETE FROM episode_evidence WHERE episode_id = ?`).run(e.episodeId);
  const ins = db.query(
    `INSERT INTO episode_evidence (episode_id, signal, direction, weight, value, reason)
     VALUES ($id,$sig,$dir,$w,$val,$reason)`
  );
  for (const sig of e.signals ?? []) {
    ins.run({
      $id: e.episodeId,
      $sig: sig.signal,
      $dir: sig.direction,
      $w: sig.weight,
      $val: sig.value === null ? null : String(sig.value),
      $reason: sig.reason,
    });
  }
}

// Remove episodes (and their features/evidence/labels) for a session that are NOT
// in `keepEpisodeIds` — i.e. orphans left behind when a regrown transcript
// re-segments into fewer/different episodes. Surviving episodes keep their cached
// labels (we only delete what no longer exists), so re-runs don't re-spend on them.
export function pruneSessionEpisodes(
  db: Database,
  sessionId: string,
  keepEpisodeIds: string[]
): number {
  const existing = db
    .query(`SELECT episode_id FROM episodes WHERE session_id = ?`)
    .all(sessionId) as { episode_id: string }[];
  const keep = new Set(keepEpisodeIds);
  const orphans = existing.map((r) => r.episode_id).filter((id) => !keep.has(id));
  if (orphans.length === 0) return 0;
  const delFeat = db.query(`DELETE FROM episode_features WHERE episode_id = ?`);
  const delEvid = db.query(`DELETE FROM episode_evidence WHERE episode_id = ?`);
  const delLabel = db.query(`DELETE FROM episode_labels WHERE episode_id = ?`);
  const delEp = db.query(`DELETE FROM episodes WHERE episode_id = ?`);
  const delTurnLink = db.query(
    `UPDATE turns SET episode_id = NULL WHERE episode_id = ?`
  );
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      delFeat.run(id);
      delEvid.run(id);
      delLabel.run(id);
      delTurnLink.run(id);
      delEp.run(id);
    }
  });
  tx(orphans);
  return orphans.length;
}

// ── Judge labels + cache ──────────────────────────────────────────────────────
export interface CacheKey {
  episodeId: string;
  contentHash: string;
  judgePromptHash: string;
  labelSchemaVersion: string;
  model: string;
  cliVersion: string;
}

// True iff a valid label already exists for this exact (content+prompt+schema+model+cli).
export function isJudged(db: Database, k: CacheKey): boolean {
  const row = db
    .query(
      `SELECT l.judge_prompt_hash, l.label_schema_version, l.model, l.cli_version, e.content_hash
       FROM episode_labels l JOIN episodes e ON e.episode_id = l.episode_id
       WHERE l.episode_id = ?`
    )
    .get(k.episodeId) as any;
  if (!row) return false;
  return (
    row.content_hash === k.contentHash &&
    row.judge_prompt_hash === k.judgePromptHash &&
    row.label_schema_version === k.labelSchemaVersion &&
    row.model === k.model &&
    row.cli_version === k.cliVersion
  );
}

export function upsertLabel(db: Database, label: JudgeLabel, meta: JudgeMeta): void {
  db.query(
    `INSERT INTO episode_labels (episode_id, task_type, task_difficulty, outcome,
       outcome_confidence, workflow_pattern_json, good_practices_json, friction_points_json,
       root_cause, outcome_evidence, skill_opportunity_json, judged_at, model,
       judge_prompt_hash, label_schema_version, cli_version)
     VALUES ($id,$tt,$td,$oc,$conf,$wp,$gp,$fp,$rc,$oe,$so,$ja,$model,$jph,$lsv,$cli)
     ON CONFLICT(episode_id) DO UPDATE SET
       task_type=excluded.task_type, task_difficulty=excluded.task_difficulty,
       outcome=excluded.outcome, outcome_confidence=excluded.outcome_confidence,
       workflow_pattern_json=excluded.workflow_pattern_json,
       good_practices_json=excluded.good_practices_json,
       friction_points_json=excluded.friction_points_json, root_cause=excluded.root_cause,
       outcome_evidence=excluded.outcome_evidence, skill_opportunity_json=excluded.skill_opportunity_json,
       judged_at=excluded.judged_at, model=excluded.model, judge_prompt_hash=excluded.judge_prompt_hash,
       label_schema_version=excluded.label_schema_version, cli_version=excluded.cli_version`
  ).run({
    $id: label.episode_id,
    $tt: label.task_type,
    $td: label.task_difficulty,
    $oc: label.outcome,
    $conf: label.outcome_confidence,
    $wp: JSON.stringify(label.workflow_pattern ?? []),
    $gp: JSON.stringify(label.good_practices ?? []),
    $fp: JSON.stringify(label.friction_points ?? []),
    $rc: label.root_cause,
    $oe: JSON.stringify(label.outcome_evidence ?? []),
    $so: JSON.stringify(label.skill_opportunity ?? {}),
    $ja: meta.judged_at,
    $model: meta.model,
    $jph: meta.judge_prompt_hash,
    $lsv: meta.label_schema_version,
    $cli: meta.cli_version,
  });
}

// ── Calibration ───────────────────────────────────────────────────────────────
export function upsertCalibration(db: Database, c: CalibrationRow): void {
  db.query(
    `INSERT INTO calibration (episode_id, stratum, human_outcome, human_notes, agrees, checked_at)
     VALUES ($id,$st,$ho,$notes,$agrees,$ca)
     ON CONFLICT(episode_id) DO UPDATE SET
       stratum=excluded.stratum, human_outcome=excluded.human_outcome,
       human_notes=excluded.human_notes, agrees=excluded.agrees, checked_at=excluded.checked_at`
  ).run({
    $id: c.episodeId,
    $st: c.stratum,
    $ho: c.humanOutcome,
    $notes: c.humanNotes,
    $agrees: c.agrees === null ? null : c.agrees ? 1 : 0,
    $ca: c.checkedAt,
  });
}

// ── Clusters ──────────────────────────────────────────────────────────────────
export function upsertCluster(db: Database, c: TaskCluster): void {
  db.query(
    `INSERT INTO task_clusters (cluster_id, label, member_episode_ids_json)
     VALUES ($id,$label,$members)
     ON CONFLICT(cluster_id) DO UPDATE SET
       label=excluded.label, member_episode_ids_json=excluded.member_episode_ids_json`
  ).run({
    $id: c.clusterId,
    $label: c.label,
    $members: JSON.stringify(c.memberEpisodeIds),
  });
}

// Read the persisted member episode ids for a cluster. Returns [] when the cluster
// row is absent (stale candidates.json) or the JSON is unparseable — callers treat
// an empty result as "fall back to the deterministic path for this candidate".
export function getClusterMembers(db: Database, clusterId: string): string[] {
  const row = db
    .query(`SELECT member_episode_ids_json FROM task_clusters WHERE cluster_id = ?`)
    .get(clusterId) as { member_episode_ids_json: string | null } | null;
  if (!row || !row.member_episode_ids_json) return [];
  try {
    const parsed = JSON.parse(row.member_episode_ids_json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
