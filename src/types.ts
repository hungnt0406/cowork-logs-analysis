// Shared contract for the Cowork Workflow Miner.
// EVERY module imports its boundary types from here. Do not redefine these elsewhere.

// ── Enums / unions ────────────────────────────────────────────────────────────
export type TurnRole =
  | "new_task"
  | "correction"
  | "continuation"
  | "approval"
  | "interruption"
  | "paste";

export type Outcome = "success" | "partial" | "failed" | "abandoned" | "qa_only";
export type Difficulty = "trivial" | "moderate" | "hard";
export type SignalDirection = "+" | "-" | "0";
export type SignalWeight = "strong" | "medium" | "weak";
export type SkillType = "skill" | "script" | "sop" | "none";

// Versioning — bump LABEL_SCHEMA_VERSION whenever the judge label shape changes;
// it is part of the judge cache key.
export const LABEL_SCHEMA_VERSION = "1";
export const RENDER_CHAR_CAP = 12000;

// ── Raw transcript event (one JSON object per .jsonl line) ────────────────────
// Loosely typed: only the fields the pipeline relies on are named.
export interface RawEvent {
  type: string; // user | assistant | system | pr-link | last-prompt | mode | permission-mode | attachment | file-history-snapshot | ai-title | queue-operation
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean; // true => subagent fork
  isMeta?: boolean; // true => harness-injected meta user turn (skill preamble etc.)
  timestamp?: string;
  message?: any; // { role, content: string | Array<{type,text?,...}>, usage? }
  toolUseResult?: any; // present => this user event is a tool result, NOT a human turn
  // system-event fields
  subtype?: string; // turn_duration | api_error | compact_boundary | away_summary | local_command | ...
  durationMs?: number;
  content?: any; // system away_summary text, etc.
  // pr-link fields
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  // common context
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  agentId?: string; // present on subagent-fork events
  [k: string]: any;
}

// ── Discovery ─────────────────────────────────────────────────────────────────
export interface SessionInfo {
  sessionId: string;
  project: string; // human-readable project name (last path segment)
  projectDir: string; // encoded dir name under ~/.claude/projects
  cwd: string;
  jsonlPath: string; // absolute path to the session transcript
  subagentsDir: string | null; // absolute path to <sessionId>/subagents if it exists
  startedAt: string;
  completedAt: string;
}

// ── Classified turn (one human turn) ──────────────────────────────────────────
export interface ClassifiedTurn {
  sessionId: string;
  idx: number; // 0-based index among HUMAN turns in the session
  uuid: string;
  role: TurnRole;
  text: string; // extracted human text (image-only turn => "")
  charLen: number;
  nImages: number;
  ts: string;
  eventIndex: number; // index into the session's full ordered event array
  classifiedBy: "heuristic" | "signal" | "llm";
  episodeId?: string; // filled by segment.ts
}

// ── Subagent compaction ───────────────────────────────────────────────────────
export interface SubagentSummary {
  agentId: string;
  agentType: string;
  description: string;
  toolCount: number;
  outcome: string; // short free-text: completed | error | unknown + 1-line gist
}

// ── Evidence signals ──────────────────────────────────────────────────────────
export interface EvidenceSignal {
  signal: string;
  direction: SignalDirection;
  weight: SignalWeight;
  value: string | number | boolean | null;
  reason: string;
}

// ── Per-episode numeric features ──────────────────────────────────────────────
export interface EpisodeFeatures {
  nToolCalls: number;
  toolSequence: string; // compact arrow string e.g. "Read>Edit>Bash"
  nFilesRead: number;
  nFilesEdited: number;
  nTestRuns: number;
  durationS: number;
  idleS: number;
  tokens: number;
}

// ── Episode (the unit of analysis) ────────────────────────────────────────────
export interface Episode {
  episodeId: string; // `${sessionId}#${idx}`
  sessionId: string;
  project: string;
  idx: number; // 0-based episode index within the session
  startTurnIdx: number; // idx of the new_task turn that opened the episode
  turns: ClassifiedTurn[]; // human turns belonging to this episode
  nTurns: number;
  nCorrections: number;
  nInterruptions: number;
  nApprovals: number;
  nImages: number;
  usedSubagents: boolean;
  subagentSummaries: SubagentSummary[];
  firstPrompt: string; // first human turn text, truncated
  startedAt: string;
  endedAt: string;
  contentHash: string; // sha256 of the rendered/normalized episode content
  events: RawEvent[]; // raw event slice belonging to this episode, in order
  // Enriched downstream (signals.ts):
  signals: EvidenceSignal[];
  features: EpisodeFeatures;
  taskKey: string | null; // reserved for cross-session linking (Phase 2); null for now
}

// ── Judge label (judge.ts validates a model response into this) ───────────────
export interface FrictionPoint {
  what: string;
  evidence: string;
}
export interface SkillOpportunity {
  worth_codifying: boolean;
  type: SkillType;
  rationale: string;
}
export interface JudgeLabel {
  episode_id: string;
  task_type: string;
  task_difficulty: Difficulty;
  outcome: Outcome;
  outcome_confidence: number; // 0..1
  workflow_pattern: string[]; // ordered tags e.g. ["explore","plan","edit","test","fix"]
  good_practices: string[];
  friction_points: FrictionPoint[];
  root_cause: string;
  outcome_evidence: string[];
  skill_opportunity: SkillOpportunity;
}

// Metadata stamped alongside a label for cache invalidation + audit.
export interface JudgeMeta {
  model: string;
  judge_prompt_hash: string;
  label_schema_version: string;
  cli_version: string;
  judged_at: string;
}

// ── Calibration ───────────────────────────────────────────────────────────────
export interface CalibrationRow {
  episodeId: string;
  stratum: string;
  humanOutcome: Outcome | null;
  humanNotes: string;
  agrees: boolean | null;
  checkedAt: string;
}

// ── Mining / ranking ──────────────────────────────────────────────────────────
export interface TaskCluster {
  clusterId: string;
  label: string;
  memberEpisodeIds: string[];
}

export interface RankedCandidate {
  cluster_id: string;
  label: string;
  frequency: number; // # episodes
  n_sessions: number; // # distinct sessions
  success_rate: number; // success / judged
  median_friction: number; // median(n_corrections + n_interruptions)
  has_stable_pattern: boolean; // max single-workflow_pattern share among successes >= 0.5 AND >= MIN_PATTERN_N successes
  dominant_pattern: string | null;
  risk_flags: string[];
  est_effort: number; // median duration_s * frequency (informational)
  recommended_intervention: SkillType;
  // Honesty flag: too few judged episodes for the rate/pattern to be trustworthy.
  // True when judged-for-rate count < MIN_CONFIDENT_N. Consumers must surface it.
  low_confidence?: boolean;
  success_rate_smoothed?: number; // Laplace-smoothed (success+1)/(judged+2); robust at small N
  n_judged?: number; // denominator behind success_rate (qa_only excluded)
  // Filled LATE by the business sidecar (sidecar.ts) — never influences ranking.
  business_note?: string;
}

// ── Convergence (cross-machine) ───────────────────────────────────────────────
// A workflow that recurs across MULTIPLE machines is cross-validated → higher
// confidence for the org-wide (meta) phase. Produced by converge.ts.
export interface ConvergedWorkflow {
  converged_id: string;
  label: string;
  machines: string[];
  n_machines: number;
  total_frequency: number;
  per_machine_frequency: Record<string, number>;
  representative_clusters: string[]; // member cluster_ids
  recommended_intervention: SkillType;
  agreement: number; // n_machines / total machines contributing
  cross_validated: boolean; // n_machines >= 2
}
