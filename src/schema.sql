-- Cowork Workflow Miner — standalone analysis DB (bun:sqlite).
-- All tables use IF NOT EXISTS so migrate() is idempotent.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  project       TEXT,
  path          TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  n_episodes    INTEGER
);

-- Classifier audit + per-turn features.
CREATE TABLE IF NOT EXISTS turns (
  turn_id     TEXT PRIMARY KEY,            -- `${session_id}#t${idx}`
  session_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,            -- 0-based among human turns
  role        TEXT NOT NULL,               -- new_task|correction|continuation|approval|interruption|paste
  char_len    INTEGER,
  n_images    INTEGER,
  ts          TEXT,
  episode_id  TEXT,
  classified_by TEXT,                      -- heuristic|signal|llm
  text_preview  TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_episode ON turns(episode_id);

CREATE TABLE IF NOT EXISTS episodes (
  episode_id        TEXT PRIMARY KEY,      -- `${session_id}#${idx}`
  session_id        TEXT NOT NULL,
  idx               INTEGER NOT NULL,
  task_key          TEXT,                  -- nullable: reserved for cross-session linking (Phase 2)
  start_turn        INTEGER,
  n_turns           INTEGER,
  n_corrections     INTEGER,
  n_interruptions   INTEGER,
  n_approvals       INTEGER,
  n_images          INTEGER,
  used_subagents    INTEGER,               -- 0/1
  subagent_summary  TEXT,                  -- JSON array of SubagentSummary
  first_prompt      TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  content_hash      TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

CREATE TABLE IF NOT EXISTS episode_features (
  episode_id     TEXT PRIMARY KEY,
  n_tool_calls   INTEGER,
  tool_sequence  TEXT,
  n_files_read   INTEGER,
  n_files_edited INTEGER,
  n_test_runs    INTEGER,
  duration_s     REAL,
  idle_s         REAL,
  tokens         INTEGER,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);

-- Long format: many rows per episode.
CREATE TABLE IF NOT EXISTS episode_evidence (
  episode_id  TEXT NOT NULL,
  signal      TEXT NOT NULL,
  direction   TEXT,                        -- + | - | 0
  weight      TEXT,                        -- strong | medium | weak
  value       TEXT,
  reason      TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_episode ON episode_evidence(episode_id);

CREATE TABLE IF NOT EXISTS episode_labels (
  episode_id            TEXT PRIMARY KEY,
  task_type             TEXT,
  task_difficulty       TEXT,              -- trivial|moderate|hard
  outcome               TEXT,              -- success|partial|failed|abandoned|qa_only
  outcome_confidence    REAL,
  workflow_pattern_json TEXT,
  good_practices_json   TEXT,
  friction_points_json  TEXT,
  root_cause            TEXT,
  outcome_evidence      TEXT,              -- JSON array
  skill_opportunity_json TEXT,
  efficiency_json       TEXT,              -- nullable; panel mode only: {score,rationale,evidence}
  quality_json          TEXT,              -- nullable; panel mode only: {score,rationale,evidence}
  judged_at             TEXT,
  model                 TEXT,
  judge_prompt_hash     TEXT,
  label_schema_version  TEXT,
  cli_version           TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);

CREATE TABLE IF NOT EXISTS calibration (
  episode_id    TEXT PRIMARY KEY,
  stratum       TEXT,
  human_outcome TEXT,
  human_notes   TEXT,
  agrees        INTEGER,                   -- 0/1, nullable
  checked_at    TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);

CREATE TABLE IF NOT EXISTS task_clusters (
  cluster_id              TEXT PRIMARY KEY,
  label                   TEXT,
  member_episode_ids_json TEXT
);
