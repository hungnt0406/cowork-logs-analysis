// classify.ts — assign a role to every human turn in a session.
// Roles: new_task | correction | continuation | approval | interruption | paste.
// Hybrid: heuristics for easy cases, signals (time-gap + topic/file overlap) for
// the ambiguous new_task vs correction/continuation boundary, optional one cheap
// `claude -p` batch pass behind opts.classifyLlm for the still-ambiguous turns.
import { join } from "path";
import { homedir } from "os";
import type { ClassifiedTurn, RawEvent, SessionInfo, TurnRole } from "./types.ts";
import { extractUserText, countImages, readEvents, isHumanTurn } from "./util.ts";
import { runnerEnv } from "./runner.ts";

const INTERRUPT_MARKER = "[Request interrupted by user]";

// ── Approval (short acknowledgements) ─────────────────────────────────────────
const APPROVAL_PHRASES = [
  "ok",
  "okay",
  "yes",
  "yep",
  "yeah",
  "go",
  "go ahead",
  "continue",
  "lgtm",
  "perfect",
  "great",
  "thanks",
  "thank you",
  "do it",
  "sounds good",
  "proceed",
  "👍",
];

// Strip trailing punctuation/whitespace and lowercase for ack matching.
function normalizeAck(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.!,]+$/g, "")
    .trim();
}

function isApproval(text: string): boolean {
  if (text.length === 0 || text.length > 40) return false;
  const norm = normalizeAck(text);
  if (APPROVAL_PHRASES.includes(norm)) return true;
  // allow "ok go", "yes do it", "ok continue" style two-word acks
  if (norm.length <= 20) {
    const words = norm.split(/\s+/);
    if (words.length <= 3 && words.every((w) => APPROVAL_PHRASES.includes(w))) return true;
  }
  return false;
}

// ── Correction cues ───────────────────────────────────────────────────────────
const CORRECTION_PREFIXES = [
  "no ",
  "no,",
  "nope",
  "actually",
  "instead",
  "wait",
  "that's wrong",
  "thats wrong",
  "wrong",
  "revert",
  "undo",
  "not ",
  "don't",
  "dont",
  "stop",
];

function isCorrection(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t === "no" || t === "nope") return true;
  for (const p of CORRECTION_PREFIXES) {
    if (t.startsWith(p)) return true;
  }
  // "still <problem>" — e.g. "still failing", "still broken", "still not working"
  if (/^still\b/.test(t)) return true;
  return false;
}

// ── Continuation cues ─────────────────────────────────────────────────────────
// Additive follow-ups that extend the in-progress task rather than open a new one.
// "also ...", "and also ...", "then ...", "plus ..." are near-certain follow-ups
// in this corpus. (A correction cue still wins if both match.)
function isContinuationCue(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^also\b/.test(t)) return true;
  if (/^and\s+(also|then)\b/.test(t)) return true;
  if (/^then\b/.test(t)) return true;
  if (/^plus\b/.test(t)) return true;
  if (/^and\s+/.test(t)) return true;
  return false;
}

// ── Paste detection ─────────────────────────────────────────────────────────
// Pasted log/listing/output with no request cue. Tuned against the real corpus:
// rsync transfers, file listings (-rwx...), tracebacks, "reset by peer", shell echoes.
const LOG_TOKENS = [
  "rsync:",
  "xfer#",
  "to-check=",
  "reset by peer",
  "broken pipe",
  "client_loop:",
  "traceback (most recent call last)",
  "send disconnect",
  "connection reset",
  "permission denied (publickey",
];

const REQUEST_CUES = [
  "?",
  "can you",
  "could you",
  "please",
  "let",
  "write",
  "add",
  "create",
  "make",
  "fix",
  "update",
  "remove",
  "implement",
  "how",
  "why",
  "what",
  "should",
  "i want",
  "i need",
  "i think",
];

function hasRequestCue(text: string): boolean {
  const t = text.toLowerCase();
  return REQUEST_CUES.some((c) => t.includes(c));
}

function isPaste(text: string): boolean {
  if (text.length < 60) return false; // pastes are bulky
  const lower = text.toLowerCase();

  // classic log tokens are a near-certain paste signal
  const hasLogToken = LOG_TOKENS.some((tok) => lower.includes(tok));

  const lines = text.split("\n");
  // shell-prompt echo: line containing "user@host ... %" or "$ "
  const shellEcho = lines.some(
    (l) => /\w+@[\w.-]+.*[%$]\s/.test(l) || /^\s*\$ /.test(l)
  );
  // stack-trace frames: "  at file:line" or 'File "...", line N'
  const traceFrames =
    /\n\s*at\s+\S+:\d+/.test(text) || /File ".*", line \d+/.test(text);
  // file-listing rows: permission bits or many "size date path" rows
  const listingRows = lines.filter((l) =>
    /^[-d][rwx-]{9}/.test(l.trim()) || /\b\d{2,}%\b.*\d{2}:\d{2}:\d{2}/.test(l)
  ).length;
  // process-table rows (top/ps/htop dumps): a long run of whitespace-separated
  // numeric columns, e.g. "1002677 root 20 0 2031404 518696 8688 S 102.6 ..."
  const procTableRows = lines.filter((l) => {
    const cols = l.trim().split(/\s+/);
    if (cols.length < 6) return false;
    const numeric = cols.filter((c) => /^\d[\d.,%]*$/.test(c)).length;
    return numeric >= 4;
  }).length;

  // ratio of lines that start with a non-letter (logs/listings tend to)
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const nonLetterStart = nonEmpty.filter(
    (l) => !/^[A-Za-z]/.test(l.trim())
  ).length;
  const nonLetterRatio = nonEmpty.length ? nonLetterStart / nonEmpty.length : 0;

  const looksLikeLog =
    hasLogToken ||
    shellEcho ||
    traceFrames ||
    listingRows >= 2 ||
    procTableRows >= 2 ||
    (nonEmpty.length >= 4 && nonLetterRatio >= 0.6);

  if (!looksLikeLog) return false;

  // A paste must NOT carry a request cue. But a hard log token (rsync/traceback/
  // process-table/listing) overrides a stray cue word, since users paste these
  // raw without asking anything.
  if (
    hasLogToken ||
    traceFrames ||
    listingRows >= 2 ||
    procTableRows >= 2 ||
    shellEcho
  ) {
    // even with these, if the FIRST line is clearly an instruction, it's not a paste
    const firstLine = (nonEmpty[0] || "").toLowerCase();
    if (/[?]/.test(firstLine) && firstLine.length < 120) return false;
    return true;
  }
  return !hasRequestCue(text);
}

// ── Topic / file overlap signals ──────────────────────────────────────────────
const STOPWORDS = new Set([
  "the","a","an","and","or","but","to","of","in","on","for","with","is","it",
  "this","that","i","you","we","u","me","my","your","can","should","add","also",
  "do","it","let","make","update","use","using","need","want","will","be","are",
  "now","just","some","each","its","have","has","not","no","yes","go","ok","fix",
]);

function keywordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9_./]+/)) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

// Containment of `turn` in `window`: fraction of the TURN's keywords that also
// appear in the in-progress episode window. Asymmetric on purpose — the episode
// window is large (accumulated assistant prose), so Jaccard would dilute to ~0.
// We care whether the turn's content is ABOUT the in-progress work.
function containment(turn: Set<string>, window: Set<string>): number {
  if (turn.size === 0 || window.size === 0) return 0;
  let inter = 0;
  for (const x of turn) if (window.has(x)) inter++;
  return inter / turn.size;
}

// Collect file paths + tool keywords from assistant tool_use events in a window.
function windowKeywords(events: RawEvent[], lo: number, hi: number): Set<string> {
  const out = new Set<string>();
  for (let i = lo; i < hi && i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "assistant") {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string") {
            for (const k of keywordsOf(part.text)) out.add(k);
          } else if (part?.type === "tool_use") {
            const input = part.input || {};
            const fp: string | undefined = input.file_path || input.path;
            if (fp) {
              for (const seg of String(fp).split(/[/.]/)) {
                if (seg.length >= 3 && !STOPWORDS.has(seg.toLowerCase()))
                  out.add(seg.toLowerCase());
              }
            }
            if (typeof input.command === "string") {
              for (const k of keywordsOf(input.command)) out.add(k);
            }
          }
        }
      }
    }
  }
  return out;
}

function tsToMs(ts: string | undefined): number {
  if (!ts) return NaN;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? NaN : n;
}

// ── Heuristic-only role (returns null when ambiguous new_task/follow-up) ───────
type HeuristicResult = { role: TurnRole; ambiguous: boolean };

function heuristicRole(text: string, nImages: number): HeuristicResult {
  if (text.includes(INTERRUPT_MARKER)) {
    return { role: "interruption", ambiguous: false };
  }
  if (isApproval(text)) {
    return { role: "approval", ambiguous: false };
  }
  if (isPaste(text)) {
    return { role: "paste", ambiguous: false };
  }
  // image-only turn => continuation (never a boundary)
  if (text === "" && nImages > 0) {
    return { role: "continuation", ambiguous: false };
  }
  if (isCorrection(text)) {
    return { role: "correction", ambiguous: false };
  }
  // Everything else is provisionally new_task but flagged AMBIGUOUS so the
  // signal pass can demote short low-content follow-ups to correction/continuation.
  return { role: "new_task", ambiguous: true };
}

// ── Optional LLM batch pass ───────────────────────────────────────────────────
interface LlmCandidate {
  idx: number;
  text: string;
  gapSeconds: number;
  topicOverlap: number;
}

async function runClassifyLlm(
  priorTask: string,
  candidates: LlmCandidate[],
  timeoutMs = 60000
): Promise<Map<number, TurnRole>> {
  const result = new Map<number, TurnRole>();
  if (candidates.length === 0) return result;

  let rubric = "";
  try {
    const promptPath = join(import.meta.dir, "..", "prompts", "classify.md");
    rubric = await Bun.file(promptPath).text();
  } catch {
    return result; // no rubric, skip silently
  }

  const payload = {
    priorTask,
    turns: candidates.map((c) => ({
      idx: c.idx,
      text: c.text.slice(0, 600),
      gapSeconds: Math.round(c.gapSeconds),
      topicOverlap: Number(c.topicOverlap.toFixed(2)),
    })),
  };
  const prompt = `${rubric}\n\n## INPUT\n${JSON.stringify(payload)}\n`;

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
    // tolerate code fences / surrounding prose: grab the first JSON array
    const match = inner.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : inner);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (
          item &&
          typeof item.idx === "number" &&
          (item.role === "new_task" ||
            item.role === "correction" ||
            item.role === "continuation")
        ) {
          result.set(item.idx, item.role as TurnRole);
        }
      }
    }
  } catch {
    clearTimeout(timer);
    // fall back to heuristic/signal labels — never throw
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function classifyTurns(
  session: SessionInfo,
  events: RawEvent[],
  opts?: { classifyLlm?: boolean }
): Promise<ClassifiedTurn[]> {
  const turns: ClassifiedTurn[] = [];

  // First pass: build ClassifiedTurns with heuristic roles + ambiguity flag.
  const ambiguousIdx: number[] = [];
  const meta: { ambiguous: boolean }[] = [];
  let humanIdx = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!isHumanTurn(ev)) continue;
    const text = extractUserText(ev.message);
    const nImages = countImages(ev.message);
    const h = heuristicRole(text, nImages);

    turns.push({
      sessionId: session.sessionId,
      idx: humanIdx,
      uuid: ev.uuid ?? `${session.sessionId}#u${i}`,
      role: h.role,
      text,
      charLen: text.length,
      nImages,
      ts: ev.timestamp ?? "",
      eventIndex: i,
      classifiedBy: "heuristic",
    });
    meta.push({ ambiguous: h.ambiguous });
    if (h.ambiguous) ambiguousIdx.push(humanIdx);
    humanIdx++;
  }

  // Second pass: signal-based disambiguation for the ambiguous (provisional
  // new_task) turns. Demote to correction/continuation when the turn is a tight
  // follow-up (small gap + high overlap), keep new_task otherwise.
  // Track which remain ambiguous after signals for the optional LLM pass.
  const stillAmbiguous: number[] = [];

  // index of the last turn currently considered a new_task boundary (for window)
  let lastNewTaskTurn = -1;

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    if (turn.role === "new_task" && !meta[t].ambiguous) {
      lastNewTaskTurn = t;
      continue;
    }
    if (!meta[t].ambiguous) {
      // non-boundary roles do not reset the in-progress episode window
      continue;
    }

    // Strong text cue: an additive continuation ("also ...", "and ...", "then ...")
    // with an episode already in progress is a follow-up, not a fresh task.
    if (lastNewTaskTurn >= 0 && isContinuationCue(turn.text)) {
      turn.role = isCorrection(turn.text) ? "correction" : "continuation";
      turn.classifiedBy = "signal";
      meta[t].ambiguous = false;
      continue;
    }

    // Signals: time gap vs previous human turn.
    const prev = t > 0 ? turns[t - 1] : null;
    const gapMs =
      prev && turn.ts && prev.ts ? tsToMs(turn.ts) - tsToMs(prev.ts) : NaN;
    const gapSeconds = Number.isNaN(gapMs) ? Infinity : gapMs / 1000;

    // Near-identical consecutive turn => a resend/duplicate, always a continuation
    // (or correction) of the same in-progress task, never a new boundary.
    if (
      prev &&
      lastNewTaskTurn >= 0 &&
      turn.text.length > 0 &&
      turn.text === prev.text
    ) {
      turn.role = isCorrection(turn.text) ? "correction" : "continuation";
      turn.classifiedBy = "signal";
      meta[t].ambiguous = false;
      continue;
    }

    // Topic/file overlap vs the in-progress episode window (assistant activity
    // between the last new_task boundary and this turn). Containment, not Jaccard:
    // the window accumulates the whole task's prose, so we ask "is this turn ABOUT
    // the in-progress work?" rather than symmetric similarity.
    const winLo =
      lastNewTaskTurn >= 0 ? turns[lastNewTaskTurn].eventIndex : 0;
    const winHi = turn.eventIndex;
    const winKw = windowKeywords(events, winLo, winHi);
    const turnKw = keywordsOf(turn.text);
    const overlap = containment(turnKw, winKw);

    // Decision signals (heuristic, no LLM). The time GAP gates overlap-based
    // merging — a shared project vocabulary means even unrelated tasks share
    // keywords, so high overlap alone cannot merge tasks that are hours apart.
    //   small gap (<10 min) + some overlap        => tight iteration, same task
    //   medium gap (<30 min) + very high overlap   => quick resume of same topic
    //   short correction with small gap            => correction in-place
    //   weak/ambiguous                             => optional LLM pass (default new_task)
    //   else (large gap, low overlap)              => fresh task
    const smallGap = gapSeconds < 600; // 10 min
    const mediumGap = gapSeconds < 1800; // 30 min
    const someOverlap = overlap >= 0.2;
    const highOverlap = overlap >= 0.4;
    const veryHighOverlap = overlap >= 0.6;
    const veryShort = turn.charLen <= 40;

    const tightIteration = smallGap && (someOverlap || veryShort);
    const quickResume = mediumGap && veryHighOverlap;
    const inPlaceCorrection = smallGap && veryShort && isCorrection(turn.text);

    const isFollowUp =
      lastNewTaskTurn >= 0 &&
      (tightIteration || quickResume || inPlaceCorrection);

    if (isFollowUp) {
      // it's a follow-up on the current episode, not a fresh task
      if (veryShort && !highOverlap && !isCorrection(turn.text)) {
        turn.role = "continuation";
      } else {
        // re-check correction cue now that we know it's same-topic
        turn.role = isCorrection(turn.text) ? "correction" : "continuation";
      }
      turn.classifiedBy = "signal";
      meta[t].ambiguous = false;
    } else if (lastNewTaskTurn < 0) {
      // no prior boundary yet: this IS the first new_task
      turn.role = "new_task";
      turn.classifiedBy = "signal";
      meta[t].ambiguous = false;
      lastNewTaskTurn = t;
    } else if (someOverlap) {
      // same-ish topic but not strong enough to merge confidently (e.g. a doc-edit
      // follow-up hours later: "i think u should update subsection 3.6"). Text+gap
      // can't separate these from a fresh ask => genuinely ambiguous. Routed to the
      // optional LLM pass; defaults to new_task when --classify-llm is off.
      stillAmbiguous.push(t);
      // provisional new_task IS a boundary so the window resets for later turns
      lastNewTaskTurn = t;
    } else {
      // low overlap => fresh task
      turn.role = "new_task";
      turn.classifiedBy = "signal";
      meta[t].ambiguous = false;
      lastNewTaskTurn = t;
    }
  }

  // Third pass (optional): one cheap LLM batch over still-ambiguous boundaries.
  if (opts?.classifyLlm && stillAmbiguous.length > 0) {
    // build a tiny prior-task summary from the most recent new_task firstline
    let priorTask = "";
    for (let t = stillAmbiguous[0] - 1; t >= 0; t--) {
      if (turns[t].role === "new_task") {
        priorTask = turns[t].text.slice(0, 200);
        break;
      }
    }
    const candidates: LlmCandidate[] = stillAmbiguous.map((t) => {
      const turn = turns[t];
      const prev = t > 0 ? turns[t - 1] : null;
      const gapMs =
        prev && turn.ts && prev.ts ? tsToMs(turn.ts) - tsToMs(prev.ts) : NaN;
      const winLo =
        // recompute window lo for this turn
        (() => {
          for (let k = t - 1; k >= 0; k--)
            if (turns[k].role === "new_task") return turns[k].eventIndex;
          return 0;
        })();
      const winKw = windowKeywords(events, winLo, turn.eventIndex);
      const overlap = containment(keywordsOf(turn.text), winKw);
      return {
        idx: turn.idx,
        text: turn.text,
        gapSeconds: Number.isNaN(gapMs) ? 99999 : gapMs / 1000,
        topicOverlap: overlap,
      };
    });

    const llmRoles = await runClassifyLlm(priorTask, candidates);
    for (const t of stillAmbiguous) {
      const role = llmRoles.get(turns[t].idx);
      if (role) {
        turns[t].role = role;
        turns[t].classifiedBy = "llm";
      }
      // else: keep the provisional new_task / heuristic label (graceful fallback)
    }
  }

  return turns;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { discoverSessions } = await import("./discover.ts");
  const arg = process.argv[2];
  const wantLlm = process.argv.includes("--classify-llm");
  if (!arg) {
    console.error("usage: bun run src/classify.ts <sessionId|path> [--classify-llm]");
    process.exit(1);
  }

  // Resolve arg to a session + jsonl path.
  let session: SessionInfo | undefined;
  let jsonlPath: string;

  if (arg.endsWith(".jsonl")) {
    jsonlPath = arg;
    const all = await discoverSessions();
    session = all.find((s) => s.jsonlPath === arg);
  } else {
    const all = await discoverSessions();
    session = all.find((s) => s.sessionId === arg);
    if (!session) {
      // maybe a partial/short id
      session = all.find((s) => s.sessionId.startsWith(arg));
    }
    if (!session) {
      console.error(`session not found: ${arg}`);
      process.exit(1);
    }
    jsonlPath = session.jsonlPath;
  }

  if (!session) {
    // synthesize a minimal SessionInfo from the path
    const events0 = await readEvents(jsonlPath);
    const sessionId = jsonlPath.split("/").pop()!.replace(/\.jsonl$/, "");
    session = {
      sessionId,
      project: "unknown",
      projectDir: "",
      cwd: events0.find((e) => e.cwd)?.cwd ?? "",
      jsonlPath,
      subagentsDir: null,
      startedAt: "",
      completedAt: "",
    };
  }

  const events = await readEvents(jsonlPath);
  const turns = await classifyTurns(session, events, { classifyLlm: wantLlm });

  const hist: Record<string, number> = {};
  for (const t of turns) {
    hist[t.role] = (hist[t.role] || 0) + 1;
    const first = t.text.replace(/\s+/g, " ").slice(0, 80);
    const tag = `${String(t.idx).padStart(3)}  ${t.role.padEnd(12)} (${String(
      t.charLen
    ).padStart(4)}c,${t.nImages}i) [${t.classifiedBy[0]}]`;
    console.log(`${tag}  ${JSON.stringify(first)}`);
  }
  console.log(`\n── role histogram (${turns.length} human turns) ──`);
  for (const [role, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(13)} ${n}`);
  }
}
