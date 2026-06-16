// Stage 6 — judge (adapter + validate + retry + cache metadata).
//
// Calls `claude -p --output-format json` (default adapter) with the bias-anchored
// rubric (prompts/judge.md) + the rendered episode, validates the model's JSON
// against the frozen Judge label schema, retries once on malformed output, and
// stamps JudgeMeta for the multi-part cache key.
//
// The pipeline decides cache-skip via isJudged(); this module exposes the cheap,
// side-effect-free getters (getJudgePromptHash / getModel / getCliVersion) it needs
// to build a CacheKey WITHOUT judging.

import { readFileSync } from "fs";
import type {
  JudgeLabel,
  JudgeMeta,
  Outcome,
  Difficulty,
  SkillType,
  FrictionPoint,
  SkillOpportunity,
  EfficiencyAssessment,
  QualityAssessment,
} from "./types.ts";
import {
  LABEL_SCHEMA_VERSION,
  PRIVACY_RULES_VERSION,
  RENDER_CHAR_CAP,
  SCORE_MIN,
  SCORE_MAX,
} from "./types.ts";
import { sha256, extractJsonObject } from "./util.ts";
import { runnerEnv, describeRunner } from "./runner.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

// Resolved default judge model id. Overridable via getModel({model}) / opts.model.
// `claude -p` uses the CLI's configured default when no --model is passed; we name
// it explicitly here so the cache key is stable and auditable.
export const MODEL = "claude-opus-4-8";

// 600s (10 min), not 120s: through the ccs proxy the time-to-first-token alone runs
// ~100s+ (see the MINE_LLM_TIMEOUT_MS note in mine.ts), and the panel consolidator's
// prompt (full episode text + three verdict JSONs) is the heaviest call — at 120s it was
// SIGTERM-killed before responding. A generous ceiling so NO real call trips it during an
// e2e run; only a hung CLI does. This is a ceiling, not added latency: a fast call still
// returns immediately, and the consecutive-error circuit breaker (pipeline.ts) bounds a
// genuinely-hung CLI.
const DEFAULT_TIMEOUT_MS = 600_000;
const JUDGE_PROMPT_PATH = `${import.meta.dir}/../prompts/judge.md`;
// Panel-mode prompts (used only by judgeEpisodePanel; single-mode never reads these).
const JUDGE_EFFICIENCY_PROMPT_PATH = `${import.meta.dir}/../prompts/judge_efficiency.md`;
const JUDGE_QUALITY_PROMPT_PATH = `${import.meta.dir}/../prompts/judge_quality.md`;
const JUDGE_CONSOLIDATOR_PROMPT_PATH = `${import.meta.dir}/../prompts/judge_consolidator.md`;

// Consolidator (deterministic seam) policy constants — see consolidateDeterministic.
// A concrete quality failure (score ≤ 2) downgrades an apparent success to partial and
// clamps the (now more doubtful) outcome_confidence to this ceiling.
const QUALITY_DOWNGRADE_THRESHOLD = 2;
const DOWNGRADE_CONFIDENCE_CEIL = 0.6;

const OUTCOMES: readonly Outcome[] = [
  "success",
  "partial",
  "failed",
  "abandoned",
  "qa_only",
];
const DIFFICULTIES: readonly Difficulty[] = ["trivial", "moderate", "hard"];
const SKILL_TYPES: readonly SkillType[] = ["skill", "script", "sop", "none"];

// ── Cheap, cached, side-effect-free getters (used by the pipeline for cache keys) ──

let _judgePromptCache: string | null = null;
function readJudgePrompt(): string {
  if (_judgePromptCache === null) {
    _judgePromptCache = readFileSync(JUDGE_PROMPT_PATH, "utf8");
  }
  return _judgePromptCache;
}

let _judgePromptHashCache: string | null = null;
export function getJudgePromptHash(): string {
  if (_judgePromptHashCache === null) {
    // Fold in PRIVACY_RULES_VERSION: the judge reads redacted text, so a redaction
    // change must invalidate cached labels just like editing the prompt does. Cheaper
    // than a new DB column — the prompt hash is already in the cache key (db.ts).
    // "1" reproduces the legacy hash (no suffix) so existing caches stay valid; any
    // bump (-> "2", ...) invalidates and forces a re-judge on the new redaction rules.
    const prompt = readJudgePrompt();
    _judgePromptHashCache =
      PRIVACY_RULES_VERSION === "1"
        ? sha256(prompt)
        : sha256(prompt + " privacy:" + PRIVACY_RULES_VERSION);
  }
  return _judgePromptHashCache;
}

// Panel-prompt readers (cached). Separate from readJudgePrompt so single-mode never
// touches disk for the panel prompts.
let _efficiencyPromptCache: string | null = null;
function readEfficiencyPrompt(): string {
  if (_efficiencyPromptCache === null) {
    _efficiencyPromptCache = readFileSync(JUDGE_EFFICIENCY_PROMPT_PATH, "utf8");
  }
  return _efficiencyPromptCache;
}
let _qualityPromptCache: string | null = null;
function readQualityPrompt(): string {
  if (_qualityPromptCache === null) {
    _qualityPromptCache = readFileSync(JUDGE_QUALITY_PROMPT_PATH, "utf8");
  }
  return _qualityPromptCache;
}
let _consolidatorPromptCache: string | null = null;
function readConsolidatorPrompt(): string {
  if (_consolidatorPromptCache === null) {
    _consolidatorPromptCache = readFileSync(JUDGE_CONSOLIDATOR_PROMPT_PATH, "utf8");
  }
  return _consolidatorPromptCache;
}

// Panel cache discriminator. DISTINCT from getJudgePromptHash so panel-judged and
// single-judged labels for the same episode live in different cache-key space (the
// hash slot in db.ts/isJudged), never colliding in episode_labels (PK episode_id).
// Folds in: a "panel:v1" tag, ALL FOUR prompts (so editing the outcome rubric also
// invalidates panel labels), the model id list, and PRIVACY_RULES_VERSION.
let _panelPromptHashCache: string | null = null;
export function getPanelPromptHash(): string {
  if (_panelPromptHashCache === null) {
    // All four sub-calls default to MODEL; list it once as the model discriminator.
    const modelIds = [MODEL];
    _panelPromptHashCache = sha256(
      "panel:v1|" +
        readJudgePrompt() +
        readEfficiencyPrompt() +
        readQualityPrompt() +
        readConsolidatorPrompt() +
        "|models:" +
        modelIds.join(",") +
        "|privacy:" +
        PRIVACY_RULES_VERSION
    );
  }
  return _panelPromptHashCache;
}

export function getModel(opts?: { model?: string }): string {
  return opts?.model ?? MODEL;
}

let _cliVersionCache: string | null = null;
export async function getCliVersion(): Promise<string> {
  if (_cliVersionCache !== null) return _cliVersionCache;
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // e.g. "2.1.175 (Claude Code)" -> "2.1.175"
    const m = out.match(/(\d+\.\d+\.\d+)/);
    _cliVersionCache = m ? m[1] : out.trim() || "unknown";
  } catch {
    _cliVersionCache = "unknown";
  }
  return _cliVersionCache;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

// Default adapter: headless `claude -p --output-format json`. Writes `prompt` to
// stdin, parses the outer JSON envelope, returns the `.result` string. TS-level
// timeout via proc.kill() (macOS has no `timeout` cmd). Throws on non-zero exit,
// timeout, unparseable envelope, or missing `.result`.
export async function runClaudeP(
  prompt: string,
  opts?: { model?: string; timeoutMs?: number }
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["claude", "-p", "--output-format", "json"];
  if (opts?.model) args.push("--model", opts.model);

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(await runnerEnv()) },
  });

  // Feed the prompt and close stdin.
  proc.stdin.write(prompt);
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new Error(`claude -p [${describeRunner()}] timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `claude -p [${describeRunner()}] exited ${exitCode}: ${(stderr || stdout).slice(0, 500)}`
    );
  }

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(
      `claude -p returned non-JSON envelope: ${stdout.slice(0, 300)}`
    );
  }
  const result = envelope?.result;
  if (typeof result !== "string") {
    throw new Error(
      `claude -p envelope missing string .result field: ${stdout.slice(0, 300)}`
    );
  }
  return result;
}

// Stub API adapter — to be implemented later behind the same boundary.
export async function runApi(
  _prompt: string,
  _opts?: { model?: string }
): Promise<string> {
  throw new Error("API adapter not implemented");
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

// Append the rendered episode + EPISODE_ID footer to any rubric. Shared by the
// outcome / efficiency / quality prompts (the consolidator builds its own, since it
// also injects the three verdict JSON blocks).
function appendEpisode(
  rubric: string,
  rendered: string,
  episodeId: string,
  nudge?: string
): string {
  const base =
    rubric +
    "\n\n--- EPISODE ---\n" +
    rendered +
    `\n\nEPISODE_ID: ${episodeId}\nReturn ONLY the JSON object.`;
  return nudge ? base + "\n\n" + nudge : base;
}

function buildPrompt(rendered: string, episodeId: string, nudge?: string): string {
  return appendEpisode(readJudgePrompt(), rendered, episodeId, nudge);
}

const RETRY_NUDGE =
  "Your previous output was invalid JSON or was missing required fields. " +
  "Output ONLY a single valid JSON object that matches the schema exactly — " +
  "no prose, no markdown code fences.";

// ── JSON extraction + validation ─────────────────────────────────────────────

// extractJsonObject lives in util.ts (shared with skilldraft.ts) — behavior unchanged.

function isStrArray(x: any): x is string[] {
  return Array.isArray(x) && x.every((e) => typeof e === "string");
}

// Validate + coerce a parsed object into an EfficiencyAssessment/QualityAssessment, or
// throw. `score` is forced to an INTEGER in SCORE_MIN..SCORE_MAX — 0/6/NaN/floats are
// rejected (NOT rounded), so a malformed score triggers a retry rather than a silent
// coercion. Shared by both axes (identical shape); the `kind` label sharpens errors.
function validateAssessment(
  obj: any,
  kind: string
): { score: number; rationale: string; evidence: string[] } {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${kind} is not a JSON object`);
  }
  const score = obj.score;
  if (
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < SCORE_MIN ||
    score > SCORE_MAX
  ) {
    throw new Error(
      `${kind}.score not an integer in ${SCORE_MIN}..${SCORE_MAX}: ${JSON.stringify(score)}`
    );
  }
  if (typeof obj.rationale !== "string") {
    throw new Error(`${kind}.rationale not a string`);
  }
  if (!isStrArray(obj.evidence)) {
    throw new Error(`${kind}.evidence not a string[]`);
  }
  return { score, rationale: obj.rationale, evidence: obj.evidence };
}

export function validateEfficiency(obj: any): EfficiencyAssessment {
  return validateAssessment(obj, "efficiency");
}
export function validateQuality(obj: any): QualityAssessment {
  return validateAssessment(obj, "quality");
}

// Validate + coerce a parsed object into a JudgeLabel. Returns the label or throws
// with a precise reason. Forces episode_id = the caller's episodeId (never trust the
// model to echo it).
function validateLabel(obj: any, episodeId: string): JudgeLabel {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("label is not a JSON object");
  }
  const errs: string[] = [];

  if (typeof obj.task_type !== "string" || !obj.task_type.trim()) {
    errs.push("task_type missing/empty");
  }
  if (!DIFFICULTIES.includes(obj.task_difficulty)) {
    errs.push(`task_difficulty invalid: ${JSON.stringify(obj.task_difficulty)}`);
  }
  if (!OUTCOMES.includes(obj.outcome)) {
    errs.push(`outcome invalid: ${JSON.stringify(obj.outcome)}`);
  }
  const conf = obj.outcome_confidence;
  if (typeof conf !== "number" || Number.isNaN(conf) || conf < 0 || conf > 1) {
    errs.push(`outcome_confidence not in 0..1: ${JSON.stringify(conf)}`);
  }
  if (!isStrArray(obj.workflow_pattern)) {
    errs.push("workflow_pattern not a string[]");
  }
  if (!isStrArray(obj.good_practices)) {
    errs.push("good_practices not a string[]");
  }
  if (!Array.isArray(obj.friction_points)) {
    errs.push("friction_points not an array");
  } else {
    for (let i = 0; i < obj.friction_points.length; i++) {
      const fp = obj.friction_points[i];
      if (
        !fp ||
        typeof fp !== "object" ||
        typeof fp.what !== "string" ||
        typeof fp.evidence !== "string"
      ) {
        errs.push(`friction_points[${i}] missing {what,evidence}`);
      }
    }
  }
  if (typeof obj.root_cause !== "string") {
    errs.push("root_cause not a string");
  }
  if (!isStrArray(obj.outcome_evidence)) {
    errs.push("outcome_evidence not a string[]");
  }
  const so = obj.skill_opportunity;
  if (!so || typeof so !== "object" || Array.isArray(so)) {
    errs.push("skill_opportunity missing/not an object");
  } else {
    if (typeof so.worth_codifying !== "boolean") {
      errs.push("skill_opportunity.worth_codifying not a boolean");
    }
    if (!SKILL_TYPES.includes(so.type)) {
      errs.push(`skill_opportunity.type invalid: ${JSON.stringify(so.type)}`);
    }
    if (typeof so.rationale !== "string") {
      errs.push("skill_opportunity.rationale not a string");
    }
  }

  if (errs.length) {
    throw new Error("invalid label: " + errs.join("; "));
  }

  const friction_points: FrictionPoint[] = obj.friction_points.map((fp: any) => ({
    what: fp.what,
    evidence: fp.evidence,
  }));
  const skill_opportunity: SkillOpportunity = {
    worth_codifying: so.worth_codifying,
    type: so.type,
    rationale: so.rationale,
  };

  // Optional panel axes — attach only when present AND valid. A malformed axis from the
  // consolidator is DROPPED here (not fatal); consolidate() then falls back to the
  // separately-judged input assessment. Single-mode labels never carry these → undefined.
  let efficiency: EfficiencyAssessment | undefined;
  if (obj.efficiency !== undefined) {
    try {
      efficiency = validateEfficiency(obj.efficiency);
    } catch {
      /* drop — caller may re-attach from the input assessment */
    }
  }
  let quality: QualityAssessment | undefined;
  if (obj.quality !== undefined) {
    try {
      quality = validateQuality(obj.quality);
    } catch {
      /* drop — caller may re-attach from the input assessment */
    }
  }

  return {
    episode_id: episodeId, // forced — do not trust the model's echo
    task_type: obj.task_type,
    task_difficulty: obj.task_difficulty,
    outcome: obj.outcome,
    outcome_confidence: conf,
    workflow_pattern: obj.workflow_pattern,
    good_practices: obj.good_practices,
    friction_points,
    root_cause: obj.root_cause,
    outcome_evidence: obj.outcome_evidence,
    skill_opportunity,
    ...(efficiency ? { efficiency } : {}),
    ...(quality ? { quality } : {}),
  };
}

// Parse + validate one adapter response into a JudgeLabel, or throw.
function parseAndValidate(result: string, episodeId: string): JudgeLabel {
  const jsonStr = extractJsonObject(result);
  if (jsonStr === null) {
    throw new Error("no JSON object found in model response");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e: any) {
    throw new Error(`JSON.parse failed: ${e?.message ?? e}`);
  }
  return validateLabel(parsed, episodeId);
}

// Parse + validate one adapter response into a bare assessment ({score,rationale,
// evidence}), or throw — the efficiency/quality sub-judges share this path.
function parseAssessment(
  result: string,
  validate: (obj: any) => { score: number; rationale: string; evidence: string[] }
): { score: number; rationale: string; evidence: string[] } {
  const jsonStr = extractJsonObject(result);
  if (jsonStr === null) {
    throw new Error("no JSON object found in model response");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e: any) {
    throw new Error(`JSON.parse failed: ${e?.message ?? e}`);
  }
  return validate(parsed);
}

// ── Adapter selection + single-retry (shared by all four panel sub-calls) ──────

type Adapter = "claude" | "api";

// Resolve the model + adapter into one call closure. The api adapter is still a stub
// (runApi throws); the claude adapter is the headless `claude -p` path.
function makeCall(opts?: { model?: string; adapter?: Adapter }): (prompt: string) => Promise<string> {
  const model = getModel(opts);
  const adapter = opts?.adapter ?? "claude";
  return (prompt: string) =>
    adapter === "api" ? runApi(prompt, { model }) : runClaudeP(prompt, { model });
}

// Run one prompt, parse it; on ANY failure retry ONCE with RETRY_NUDGE appended; if the
// retry also fails, throw with both errors. `promptFn(nudge?)` builds the prompt so the
// nudge is appended on the second attempt. Single source of the judge try/retry shape.
async function callWithRetry<T>(
  what: string,
  call: (prompt: string) => Promise<string>,
  promptFn: (nudge?: string) => string,
  parseFn: (result: string) => T
): Promise<T> {
  try {
    return parseFn(await call(promptFn()));
  } catch (firstErr: any) {
    try {
      return parseFn(await call(promptFn(RETRY_NUDGE)));
    } catch (secondErr: any) {
      throw new Error(
        `${what} failed after retry. ` +
          `first: ${firstErr?.message ?? firstErr}; ` +
          `retry: ${secondErr?.message ?? secondErr}`
      );
    }
  }
}

// ── Public: judge one episode ─────────────────────────────────────────────────

export async function judgeEpisode(
  rendered: string,
  episodeId: string,
  opts?: { model?: string; adapter?: Adapter }
): Promise<{ label: JudgeLabel; meta: JudgeMeta }> {
  const model = getModel(opts);
  const call = makeCall(opts);

  const label = await callWithRetry(
    `judge ${episodeId}`,
    call,
    (nudge) => buildPrompt(rendered, episodeId, nudge),
    (r) => parseAndValidate(r, episodeId)
  );

  const meta: JudgeMeta = {
    model,
    judge_prompt_hash: getJudgePromptHash(),
    label_schema_version: LABEL_SCHEMA_VERSION,
    cli_version: await getCliVersion(),
    judged_at: new Date().toISOString(),
  };

  return { label, meta };
}

// ── Panel sub-judges: efficiency + quality (independent axes) ─────────────────

export async function judgeEfficiency(
  rendered: string,
  episodeId: string,
  opts?: { model?: string; adapter?: Adapter }
): Promise<EfficiencyAssessment> {
  const call = makeCall(opts);
  return callWithRetry(
    `efficiency ${episodeId}`,
    call,
    (nudge) => appendEpisode(readEfficiencyPrompt(), rendered, episodeId, nudge),
    (r) => parseAssessment(r, validateEfficiency)
  );
}

export async function judgeQuality(
  rendered: string,
  episodeId: string,
  opts?: { model?: string; adapter?: Adapter }
): Promise<QualityAssessment> {
  const call = makeCall(opts);
  return callWithRetry(
    `quality ${episodeId}`,
    call,
    (nudge) => appendEpisode(readQualityPrompt(), rendered, episodeId, nudge),
    (r) => parseAssessment(r, validateQuality)
  );
}

// ── Consolidation seam ─────────────────────────────────────────────────────────
// Default LLM; a pure deterministic path doubles as the LLM-fallback and the test
// target (so the seam is exercised WITHOUT a network call).
export type ConsolidatorMode = "llm" | "deterministic";

export interface ConsolidateCtx {
  rendered: string;
  episodeId: string;
  outcome: JudgeLabel; // the outcome judge's label — the SPINE
  efficiency: EfficiencyAssessment;
  quality: QualityAssessment;
}

function buildConsolidatorPrompt(ctx: ConsolidateCtx, nudge?: string): string {
  // The episode is the consolidator's secondary input (the 3 verdicts are primary), so
  // bound it to RENDER_CHAR_CAP defensively — the rendered text is already capped, but
  // a caller could pass an uncapped string here.
  const bounded = ctx.rendered.slice(0, RENDER_CHAR_CAP);
  const base =
    readConsolidatorPrompt() +
    "\n\n--- OUTCOME VERDICT (JSON) ---\n" +
    JSON.stringify(ctx.outcome) +
    "\n\n--- EFFICIENCY VERDICT (JSON) ---\n" +
    JSON.stringify(ctx.efficiency) +
    "\n\n--- QUALITY VERDICT (JSON) ---\n" +
    JSON.stringify(ctx.quality) +
    "\n\n--- EPISODE ---\n" +
    bounded +
    `\n\nEPISODE_ID: ${ctx.episodeId}\nReturn ONLY the JSON object.`;
  return nudge ? base + "\n\n" + nudge : base;
}

// Pure, network-free reconciliation. Outcome judge is the spine; the ONLY adjustment is
// a concrete-quality-failure downgrade of success→partial with a clamped confidence.
// Efficiency NEVER changes the outcome. Always attaches both assessments.
export function consolidateDeterministic(ctx: ConsolidateCtx): JudgeLabel {
  let outcome = ctx.outcome.outcome;
  let outcome_confidence = ctx.outcome.outcome_confidence;
  if (
    ctx.quality.score <= QUALITY_DOWNGRADE_THRESHOLD &&
    outcome === "success"
  ) {
    outcome = "partial";
    outcome_confidence = Math.min(outcome_confidence, DOWNGRADE_CONFIDENCE_CEIL);
  }
  return {
    ...ctx.outcome,
    episode_id: ctx.episodeId, // forced — keep the caller's id
    outcome,
    outcome_confidence,
    efficiency: ctx.efficiency,
    quality: ctx.quality,
  };
}

// Reconcile the three verdicts into one final label. LLM mode (default) lets the model
// apply the rubric; on a dropped panel axis it re-attaches the separately-judged input.
// Deterministic mode is the pure seam (fallback + test target).
export async function consolidate(
  ctx: ConsolidateCtx,
  opts?: { model?: string; adapter?: Adapter; mode?: ConsolidatorMode }
): Promise<JudgeLabel> {
  const mode = opts?.mode ?? "llm";
  if (mode === "deterministic") return consolidateDeterministic(ctx);

  const call = makeCall(opts);
  let label = await callWithRetry(
    `consolidate ${ctx.episodeId}`,
    call,
    (nudge) => buildConsolidatorPrompt(ctx, nudge),
    (r) => parseAndValidate(r, ctx.episodeId)
  );
  // If the model dropped (or malformed) an axis, fall back to the input assessment so the
  // panel axes are ALWAYS present on a panel label.
  if (!label.efficiency) label = { ...label, efficiency: ctx.efficiency };
  if (!label.quality) label = { ...label, quality: ctx.quality };
  return label;
}

// ── Public: judge one episode with the full panel (4 SERIAL calls) ────────────
// outcome (reuses judgeEpisode verbatim — the outcome rubric stays the single source of
// outcome) → efficiency → quality → consolidate. Serial because serial execution is the
// only rate-limit throttle (see CLAUDE.md). Returns the SAME {label, meta} shape, with
// meta.judge_prompt_hash = getPanelPromptHash() and label_schema_version still "1".
export async function judgeEpisodePanel(
  rendered: string,
  episodeId: string,
  opts?: { model?: string; adapter?: Adapter; consolidatorMode?: ConsolidatorMode }
): Promise<{ label: JudgeLabel; meta: JudgeMeta }> {
  const model = getModel(opts);
  // The three graders share model + adapter; consolidatorMode applies to the
  // consolidation step ONLY, so it is intentionally absent from subOpts and threaded
  // into consolidate() below.
  const subOpts = { model, adapter: opts?.adapter };

  const { label: outcome } = await judgeEpisode(rendered, episodeId, subOpts);
  const efficiency = await judgeEfficiency(rendered, episodeId, subOpts);
  const quality = await judgeQuality(rendered, episodeId, subOpts);
  const label = await consolidate(
    { rendered, episodeId, outcome, efficiency, quality },
    { model, adapter: opts?.adapter, mode: opts?.consolidatorMode }
  );
  // NOTE: meta.judge_prompt_hash = getPanelPromptHash(), which pins the model
  // discriminator to the default MODEL (per the plan; per-axis cheaper models are
  // deferred). The pipeline only ever panel-judges with the default model, so an
  // opts.model override here would NOT be reflected in the panel cache key — fold the
  // resolved model into getPanelPromptHash() first if per-call models are introduced.

  const meta: JudgeMeta = {
    model,
    judge_prompt_hash: getPanelPromptHash(),
    label_schema_version: LABEL_SCHEMA_VERSION,
    cli_version: await getCliVersion(),
    judged_at: new Date().toISOString(),
  };

  return { label, meta };
}

// ── CLI: judge a rendered-episode text file standalone ────────────────────────
// Usage: bun run src/judge.ts <rendered-episode.txt> <episode_id> [--model M] [--api] [--panel]
if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let model: string | undefined;
  let adapter: "claude" | "api" = "claude";
  let panel = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") model = args[++i];
    else if (a === "--api") adapter = "api";
    else if (a === "--panel") panel = true;
    else positional.push(a);
  }
  const [path, episodeId] = positional;
  if (!path || !episodeId) {
    console.error(
      "usage: bun run src/judge.ts <rendered-episode.txt> <episode_id> [--model M] [--api] [--panel]"
    );
    process.exit(2);
  }
  const rendered = readFileSync(path, "utf8");
  const { label, meta } = panel
    ? await judgeEpisodePanel(rendered, episodeId, { model, adapter })
    : await judgeEpisode(rendered, episodeId, { model, adapter });
  console.log(JSON.stringify({ label, meta }, null, 2));
}
