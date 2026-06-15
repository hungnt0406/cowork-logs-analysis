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
} from "./types.ts";
import { LABEL_SCHEMA_VERSION, PRIVACY_RULES_VERSION } from "./types.ts";
import { sha256 } from "./util.ts";
import { runnerEnv, describeRunner } from "./runner.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

// Resolved default judge model id. Overridable via getModel({model}) / opts.model.
// `claude -p` uses the CLI's configured default when no --model is passed; we name
// it explicitly here so the cache key is stable and auditable.
export const MODEL = "claude-opus-4-8";

const DEFAULT_TIMEOUT_MS = 120_000;
const JUDGE_PROMPT_PATH = `${import.meta.dir}/../prompts/judge.md`;

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

function buildPrompt(rendered: string, episodeId: string, nudge?: string): string {
  const base =
    readJudgePrompt() +
    "\n\n--- EPISODE ---\n" +
    rendered +
    `\n\nEPISODE_ID: ${episodeId}\nReturn ONLY the JSON object.`;
  return nudge ? base + "\n\n" + nudge : base;
}

const RETRY_NUDGE =
  "Your previous output was invalid JSON or was missing required fields. " +
  "Output ONLY a single valid JSON object that matches the schema exactly — " +
  "no prose, no markdown code fences.";

// ── JSON extraction + validation ─────────────────────────────────────────────

// Defensively extract the first balanced {...} object from a model response,
// stripping any markdown code fences or surrounding prose.
function extractJsonObject(raw: string): string | null {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function isStrArray(x: any): x is string[] {
  return Array.isArray(x) && x.every((e) => typeof e === "string");
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

// ── Public: judge one episode ─────────────────────────────────────────────────

export async function judgeEpisode(
  rendered: string,
  episodeId: string,
  opts?: { model?: string; adapter?: "claude" | "api" }
): Promise<{ label: JudgeLabel; meta: JudgeMeta }> {
  const model = getModel(opts);
  const adapter = opts?.adapter ?? "claude";
  const call = (prompt: string) =>
    adapter === "api"
      ? runApi(prompt, { model })
      : runClaudeP(prompt, { model });

  let label: JudgeLabel;
  try {
    const first = await call(buildPrompt(rendered, episodeId));
    label = parseAndValidate(first, episodeId);
  } catch (firstErr: any) {
    // Retry ONCE with a terse nudge appended.
    try {
      const second = await call(buildPrompt(rendered, episodeId, RETRY_NUDGE));
      label = parseAndValidate(second, episodeId);
    } catch (secondErr: any) {
      throw new Error(
        `judge failed for ${episodeId} after retry. ` +
          `first: ${firstErr?.message ?? firstErr}; ` +
          `retry: ${secondErr?.message ?? secondErr}`
      );
    }
  }

  const meta: JudgeMeta = {
    model,
    judge_prompt_hash: getJudgePromptHash(),
    label_schema_version: LABEL_SCHEMA_VERSION,
    cli_version: await getCliVersion(),
    judged_at: new Date().toISOString(),
  };

  return { label, meta };
}

// ── CLI: judge a rendered-episode text file standalone ────────────────────────
// Usage: bun run src/judge.ts <rendered-episode.txt> <episode_id> [--model M] [--api]
if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let model: string | undefined;
  let adapter: "claude" | "api" = "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") model = args[++i];
    else if (a === "--api") adapter = "api";
    else positional.push(a);
  }
  const [path, episodeId] = positional;
  if (!path || !episodeId) {
    console.error(
      "usage: bun run src/judge.ts <rendered-episode.txt> <episode_id> [--model M] [--api]"
    );
    process.exit(2);
  }
  const rendered = readFileSync(path, "utf8");
  const { label, meta } = await judgeEpisode(rendered, episodeId, { model, adapter });
  console.log(JSON.stringify({ label, meta }, null, 2));
}
