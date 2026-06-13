// Stage 3 — evidence signals (directional / weighted) + numeric features.
//
// `computeSignalsAndFeatures(episode)` mutates `episode.signals` and
// `episode.features` IN PLACE. It is pure over the episode's already-attached data
// (`events`, `turns`, `subagentSummaries`) — subagents are attached BEFORE this runs.
//
// Signals are EVIDENCE, not verdicts: each is `{signal, direction(+/-/0),
// weight(strong/medium/weak), value, reason}`. The judge weighs them.
//
// Nothing here throws: every field access is guarded.

import type {
  Episode,
  EpisodeFeatures,
  EvidenceSignal,
  RawEvent,
  SignalDirection,
  SignalWeight,
} from "./types.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function sig(
  signal: string,
  direction: SignalDirection,
  weight: SignalWeight,
  value: string | number | boolean | null,
  reason: string
): EvidenceSignal {
  // Collapse whitespace in string values so signals stay single-line / readable.
  const v = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
  return { signal, direction, weight, value: v, reason };
}

// Pull the file path off a tool_use input (Read/Edit/Write use file_path|path).
function toolPath(input: any): string | null {
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return null;
}

// Iterate every assistant tool_use part across the episode, in order.
interface ToolCall {
  name: string;
  input: any;
  id: string | undefined;
}
function collectToolCalls(events: RawEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const c = ev.message?.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p?.type === "tool_use" && typeof p.name === "string") {
        calls.push({ name: p.name, input: p.input ?? {}, id: typeof p.id === "string" ? p.id : undefined });
      }
    }
  }
  return calls;
}

// Test / build command detection on a Bash command string.
const TEST_CMD_RE =
  /\b(pytest|jest|vitest|mocha|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|bun\s+test|go\s+test|cargo\s+test|cargo\s+build|make\b|gradle\b|mvn\b|ctest|tox|rspec|phpunit|dotnet\s+test|python\s+-m\s+pytest|python\s+-m\s+unittest)\b/i;
// Bare "test" as its own word (avoids matching e.g. "latest", "contest").
const BARE_TEST_RE = /(^|\s|&&|\|\||;)test(\s|$|&&|\|\||;)/i;

function isTestCommand(cmd: string): boolean {
  if (!cmd) return false;
  return TEST_CMD_RE.test(cmd) || BARE_TEST_RE.test(cmd);
}

// Stringify a tool result (toolUseResult object/string or tool_result content part)
// into a flat lowercase haystack for pass/fail scanning.
function resultText(tur: any): string {
  if (tur == null) return "";
  if (typeof tur === "string") return tur.toLowerCase();
  if (typeof tur === "object") {
    const parts: string[] = [];
    if (typeof tur.stdout === "string") parts.push(tur.stdout);
    if (typeof tur.stderr === "string") parts.push(tur.stderr);
    if (tur.interrupted === true) parts.push("interrupted");
    if (typeof tur.content === "string") parts.push(tur.content);
    else if (Array.isArray(tur.content)) {
      for (const p of tur.content) {
        if (typeof p?.text === "string") parts.push(p.text);
      }
    }
    if (parts.length === 0) {
      try {
        parts.push(JSON.stringify(tur));
      } catch {
        /* ignore */
      }
    }
    return parts.join("\n").toLowerCase();
  }
  return "";
}

// Strong failure markers. Deliberately does NOT include a bare "error"/"errors"/
// "fail" word — those appear constantly in benign log noise (e.g. "1 error" in an
// unrelated deprecation line) and were the source of false test_failed signals.
const FAIL_RE = /\b(failed|failing|failure|failures|traceback|exception|assertionerror|panic|segfault|segmentation fault|fatal error|exit code [1-9]|exit status [1-9]|non-zero)\b/i;
// A non-zero failure/error COUNT ("3 failed", "2 errors") — a real test-summary fail.
// Failure counts are unambiguous; error counts are exempted when a benign qualifier
// follows ("1 error suppressed/ignored/as warning") so benign log noise doesn't trip.
const FAIL_COUNT_RE =
  /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\b[1-9]\d*\s+errors?\b(?!\s+(?:suppressed|ignored|tolerated|expected|allowed|as\s+warnings?|warning))/i;
const PASS_RE = /\b(pass|passed|passing|ok\b|success|succeeded|all tests passed|\d+\s+passed|exit code 0|exit status 0)\b/i;
// Clean-pass markers that VETO a fail signal (so "0 errors"/"no failures" can't trip it).
const PASS_CLEAN_RE = /\b(0 (failed|errors?|failures?)|no errors|no failures|all tests passed|tests passed|build succeeded)\b/i;

// ── main ────────────────────────────────────────────────────────────────────

export function computeSignalsAndFeatures(episode: Episode): void {
  const events: RawEvent[] = Array.isArray(episode.events) ? episode.events : [];
  const turns = Array.isArray(episode.turns) ? episode.turns : [];
  const signals: EvidenceSignal[] = [];

  const toolCalls = collectToolCalls(events);

  // ── created_pr (+ strong) ────────────────────────────────────────────────
  let prReason: string | null = null;
  let prValue: string | number | null = null;
  for (const ev of events) {
    if (ev.type === "pr-link") {
      prValue = typeof ev.prUrl === "string" ? ev.prUrl : (ev.prNumber ?? true) as any;
      prReason = `pr-link event${ev.prNumber ? ` #${ev.prNumber}` : ""}`;
      break;
    }
  }
  if (!prReason) {
    for (const call of toolCalls) {
      if (call.name === "Bash" && typeof call.input?.command === "string") {
        if (/gh\s+pr\s+create/i.test(call.input.command)) {
          prReason = "`gh pr create` Bash command";
          prValue = "gh pr create";
          break;
        }
      }
    }
  }
  if (prReason) {
    signals.push(sig("created_pr", "+", "strong", prValue, prReason));
  }

  // ── explicit_user_approval (+ strong) ────────────────────────────────────
  // An approval-role turn near the episode end, or praise text anywhere.
  const PRAISE_RE = /\b(perfect|great|awesome|excellent|nice|lgtm|looks good|well done|thanks|thank you|amazing)\b/i;
  let approvalReason: string | null = null;
  if (turns.length > 0) {
    const tailStart = Math.max(0, turns.length - 2); // "near the end" = last 2 human turns
    for (let i = tailStart; i < turns.length; i++) {
      if (turns[i].role === "approval") {
        approvalReason = `approval-role turn near episode end ("${turns[i].text.slice(0, 40)}")`;
        break;
      }
    }
    if (!approvalReason) {
      for (const t of turns) {
        if (PRAISE_RE.test(t.text)) {
          approvalReason = `praise in user turn ("${t.text.slice(0, 40)}")`;
          break;
        }
      }
    }
  }
  if (approvalReason) {
    signals.push(sig("explicit_user_approval", "+", "strong", true, approvalReason));
  }

  // ── explicit_user_rejection (− strong) ───────────────────────────────────
  const REJECT_RE = /\b(wrong|revert|undo|no\b|not right|that's not|incorrect|broke|broken)\b/i;
  let rejectReason: string | null = null;
  for (const t of turns) {
    if (t.role === "correction" && REJECT_RE.test(t.text)) {
      rejectReason = `correction turn rejecting work ("${t.text.slice(0, 40)}")`;
      break;
    }
  }
  if (rejectReason) {
    signals.push(sig("explicit_user_rejection", "-", "strong", true, rejectReason));
  }

  // ── abandoned_mid_edit (− strong) ────────────────────────────────────────
  // Episode is the last in the session AND ends on an unresolved tool_use (no
  // following user/assistant resolution). We approximate "last in session" via the
  // episode flag `isLastInSession` if the segmenter set it, else by checking that
  // the final event is an assistant tool_use with no trailing user/assistant event.
  {
    const lastIdx = events.length - 1;
    if (lastIdx >= 0) {
      const last = events[lastIdx];
      let endsOnUnresolvedTool = false;
      if (last.type === "assistant") {
        const c = last.message?.content;
        if (Array.isArray(c)) {
          const hasToolUse = c.some((p: any) => p?.type === "tool_use");
          const hasText = c.some(
            (p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim()
          );
          // Unresolved if the very last assistant message issued a tool call and
          // produced no concluding text, and nothing follows it.
          endsOnUnresolvedTool = hasToolUse && !hasText;
        }
      }
      // `isLastInSession` is an optional hint the segmenter may stamp; default to the
      // structural check when absent.
      const isLast = (episode as any).isLastInSession;
      const treatAsLast = isLast === undefined ? true : !!isLast;
      if (endsOnUnresolvedTool && treatAsLast) {
        signals.push(
          sig(
            "abandoned_mid_edit",
            "-",
            "strong",
            true,
            "episode ends on an unresolved tool_use with no following resolution"
          )
        );
      }
    }
  }

  // ── test_passed / test_failed (± medium) ─────────────────────────────────
  // Walk events; on a test/build Bash tool_use, inspect the FOLLOWING tool result.
  {
    // Build a quick index: for each Bash tool_use id, find the result text that
    // follows it (toolUseResult on the next user event, or matching tool_result part).
    const resultByToolId = new Map<string, any>();
    for (const ev of events) {
      if (ev.type !== "user") continue;
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p?.type === "tool_result" && typeof p.tool_use_id === "string") {
            resultByToolId.set(p.tool_use_id, p.content ?? ev.toolUseResult);
          }
        }
      }
    }
    // Also map: position-based fallback — the toolUseResult on the user event that
    // immediately follows an assistant Bash call.
    let emittedPass = false;
    let emittedFail = false;
    for (let i = 0; i < events.length && !(emittedPass && emittedFail); i++) {
      const ev = events[i];
      if (ev.type !== "assistant") continue;
      const c = ev.message?.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) {
        if (p?.type !== "tool_use" || p.name !== "Bash") continue;
        const cmd = typeof p.input?.command === "string" ? p.input.command : "";
        if (!isTestCommand(cmd)) continue;

        // Find result: by tool_use_id first, else the next user event's toolUseResult.
        let res: any = p.id ? resultByToolId.get(p.id) : undefined;
        if (res === undefined) {
          for (let j = i + 1; j < events.length; j++) {
            if (events[j].type === "user") {
              res = events[j].toolUseResult ?? events[j].message?.content;
              break;
            }
          }
        }
        const haystack = resultText(res);
        const interrupted = !!(res && typeof res === "object" && res.interrupted === true);
        const passClean = PASS_CLEAN_RE.test(haystack);
        const looksFail =
          interrupted ||
          (!passClean && (FAIL_RE.test(haystack) || FAIL_COUNT_RE.test(haystack)));
        const looksPass = PASS_RE.test(haystack) && !looksFail;

        if (looksFail && !emittedFail) {
          signals.push(
            sig("test_failed", "-", "medium", cmd.slice(0, 80), interrupted ? "test/build command interrupted or errored" : "test/build output indicates failure")
          );
          emittedFail = true;
        } else if (looksPass && !emittedPass) {
          signals.push(sig("test_passed", "+", "medium", cmd.slice(0, 80), "test/build output indicates pass"));
          emittedPass = true;
        }
      }
    }
  }

  // ── n_corrections (− weak) ───────────────────────────────────────────────
  const nCorrections = turns.filter((t) => t.role === "correction").length;
  if (nCorrections > 0) {
    signals.push(sig("n_corrections", "-", "weak", nCorrections, `${nCorrections} correction turn(s)`));
  }

  // ── api_errors (0/− weak) — transient infra, direction "0" ───────────────
  const apiErrors = events.filter((e) => e.type === "system" && e.subtype === "api_error").length;
  if (apiErrors > 0) {
    signals.push(
      sig("api_errors", "0", "weak", apiErrors, `${apiErrors} system/api_error event(s) — likely transient infra`)
    );
  }

  // ── compact_boundary (− weak) ────────────────────────────────────────────
  const compactBoundaries = events.filter(
    (e) => e.type === "system" && e.subtype === "compact_boundary"
  ).length;
  if (compactBoundaries > 0) {
    signals.push(
      sig("compact_boundary", "-", "weak", compactBoundaries, `${compactBoundaries} compaction boundary(ies) — context overflow`)
    );
  }

  // ── read_before_edit (+ weak) ────────────────────────────────────────────
  {
    const readPaths = new Set<string>();
    let found = false;
    for (const call of toolCalls) {
      const path = toolPath(call.input);
      if (!path) continue;
      if (call.name === "Read") {
        readPaths.add(path);
      } else if ((call.name === "Edit" || call.name === "Write") && readPaths.has(path)) {
        signals.push(sig("read_before_edit", "+", "weak", path, `Read preceded Edit on ${path}`));
        found = true;
        break;
      }
    }
    void found;
  }

  episode.signals = signals;

  // ── numeric features ─────────────────────────────────────────────────────
  episode.features = computeFeatures(episode, events, toolCalls);
}

// idleS formula: sum of gaps BETWEEN consecutive human-turn timestamps that exceed a
// threshold (60s), MINUS the assistant turn_duration that fell within the episode —
// i.e. wall-clock dead time not explained by the model working. This is an
// approximation (we don't know exactly which turn_durations sit in which gap), so we
// subtract total turn_duration from total inter-turn gap time and floor at 0.
//
// tokens formula: sum of assistant `message.usage.output_tokens` only (generation
// cost; input/cache tokens excluded for consistency and because cache-read dominates
// and is not a useful effort proxy).
function computeFeatures(
  episode: Episode,
  events: RawEvent[],
  toolCalls: { name: string; input: any }[]
): EpisodeFeatures {
  const nToolCalls = toolCalls.length;

  // toolSequence: collapse immediate repeats, cap ~40 tools.
  const seq: string[] = [];
  for (const call of toolCalls) {
    if (seq.length === 0 || seq[seq.length - 1] !== call.name) seq.push(call.name);
  }
  const CAP = 40;
  const capped = seq.length > CAP ? [...seq.slice(0, CAP), "…"] : seq;
  const toolSequence = capped.join(">");

  // distinct file paths read vs edited/written.
  const readFiles = new Set<string>();
  const editFiles = new Set<string>();
  let nTestRuns = 0;
  for (const call of toolCalls) {
    const path = toolPath(call.input);
    if (call.name === "Read" && path) readFiles.add(path);
    else if ((call.name === "Edit" || call.name === "Write") && path) editFiles.add(path);
    else if (call.name === "Bash") {
      const cmd = typeof call.input?.command === "string" ? call.input.command : "";
      if (isTestCommand(cmd)) nTestRuns++;
    }
  }

  // durationS: sum of system/turn_duration durationMs, else fallback to wall clock.
  let turnDurMs = 0;
  let sawTurnDur = false;
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "turn_duration" && typeof ev.durationMs === "number") {
      turnDurMs += ev.durationMs;
      sawTurnDur = true;
    }
  }
  let durationS: number;
  if (sawTurnDur) {
    durationS = turnDurMs / 1000;
  } else {
    durationS = wallClockSeconds(episode);
  }

  // idleS: inter-human-turn gaps over 60s, minus model working time, floored at 0.
  let interTurnGapMs = 0;
  const tsList = (Array.isArray(episode.turns) ? episode.turns : [])
    .map((t) => Date.parse(t.ts))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  for (let i = 1; i < tsList.length; i++) {
    const gap = tsList[i] - tsList[i - 1];
    if (gap > 60_000) interTurnGapMs += gap;
  }
  const idleS = Math.max(0, (interTurnGapMs - turnDurMs) / 1000);

  // tokens: sum of assistant output_tokens.
  let tokens = 0;
  for (const ev of events) {
    if (ev.type === "assistant") {
      const out = ev.message?.usage?.output_tokens;
      if (typeof out === "number") tokens += out;
    }
  }

  return {
    nToolCalls,
    toolSequence,
    nFilesRead: readFiles.size,
    nFilesEdited: editFiles.size,
    nTestRuns,
    durationS: Math.round(durationS),
    idleS: Math.round(idleS),
    tokens,
  };
}

function wallClockSeconds(episode: Episode): number {
  const a = Date.parse(episode.startedAt);
  const b = Date.parse(episode.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return (b - a) / 1000;
}
