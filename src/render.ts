// Stage 5 — compact episode view the judge reads.
//
// Lifts the elision strategy from auto-skills/cowork-mem-pilot/extract-conversation.ts:
// keep user prompts, assistant text, and tool name + truncated input; DROP all tool
// outputs / file bodies. Scoped to ONE episode's events. Appends an evidence-signals
// block and a subagents block. Hard-capped at RENDER_CHAR_CAP via middle-elision so
// the judge always sees the start (the ask) and end (the outcome) plus the signals.
//
// Pure, synchronous, never throws.

import type { Episode, RawEvent } from "./types.ts";
import { extractUserText, countImages } from "./util.ts";
import { RENDER_CHAR_CAP } from "./types.ts";
import { sanitizeRendered } from "./privacy.ts";

const USER_TEXT_CAP = 700;
const ASSISTANT_TEXT_CAP = 1000;
const TOOL_INPUT_CAP = 160;

// Render one user turn line. Images become inline [image attached] markers; an
// image-only turn renders as "USER: [image attached]".
function renderUserLine(ev: RawEvent): string | null {
  // Skip harness-injected meta turns (skill preambles etc.) — they are not human asks.
  if (ev.isMeta) return null;
  // Skip tool-result user events (they carry no human text we keep).
  if (ev.toolUseResult !== undefined && ev.toolUseResult !== null) return null;
  const content = ev.message?.content;
  if (Array.isArray(content) && content.some((p: any) => p?.type === "tool_result")) {
    return null;
  }

  const text = extractUserText(ev.message);
  const nImages = countImages(ev.message);

  // Drop harness / slash-command envelopes (mirrors extract-conversation.ts).
  if (text && text.startsWith("<")) return null;

  if (!text && nImages === 0) return null;

  const imgMarker = nImages > 0 ? "[image attached]" : "";
  if (text && nImages > 0) {
    return `USER: ${text.slice(0, USER_TEXT_CAP)} ${imgMarker}`;
  }
  if (text) return `USER: ${text.slice(0, USER_TEXT_CAP)}`;
  return `USER: ${imgMarker}`;
}

// Render an assistant event into zero+ lines (text lines + tool-call lines).
function renderAssistantLines(ev: RawEvent): string[] {
  const lines: string[] = [];
  const content = ev.message?.content;
  if (!Array.isArray(content)) return lines;
  for (const p of content) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
      lines.push("ASSISTANT: " + p.text.trim().slice(0, ASSISTANT_TEXT_CAP));
    } else if (p?.type === "tool_use") {
      let inp = "{}";
      try {
        inp = JSON.stringify(p.input ?? {});
      } catch {
        inp = "{}";
      }
      lines.push(`  [tool:${p.name ?? "?"} ${inp.slice(0, TOOL_INPUT_CAP)}]`);
    }
  }
  return lines;
}

function buildConversation(events: RawEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type === "user") {
      const line = renderUserLine(ev);
      if (line) out.push(line);
    } else if (ev.type === "assistant") {
      out.push(...renderAssistantLines(ev));
    }
    // All other event types (system, pr-link, etc.) are elided from the body;
    // their information surfaces via the appended evidence-signals block.
  }
  return out;
}

function buildSignalsBlock(episode: Episode): string {
  const signals = Array.isArray(episode.signals) ? episode.signals : [];
  if (signals.length === 0) {
    return "--- EVIDENCE SIGNALS ---\n(none)";
  }
  const lines = ["--- EVIDENCE SIGNALS ---"];
  for (const s of signals) {
    const val = s.value === null ? "null" : String(s.value);
    lines.push(`${s.signal} (${s.direction}${s.weight}): ${val} — ${s.reason}`);
  }
  return lines.join("\n");
}

function buildSubagentsBlock(episode: Episode): string {
  const subs = Array.isArray(episode.subagentSummaries) ? episode.subagentSummaries : [];
  if (subs.length === 0) return "";
  const lines = ["--- SUBAGENTS ---"];
  for (const s of subs) {
    lines.push(
      `${s.agentType}: ${s.description} (tools=${s.toolCount}, outcome=${s.outcome})`
    );
  }
  return lines.join("\n");
}

// Middle-elide the conversation body so the appended blocks always fit and the
// judge keeps the first ~40% and last ~40% of the conversation.
function fitWithinCap(conversationBody: string, appended: string): string {
  const sep = appended ? "\n\n" + appended : "";
  const full = conversationBody + sep;
  if (full.length <= RENDER_CHAR_CAP) return full;

  // Budget for the conversation body = cap minus the appended blocks (which are
  // never elided) and the separator.
  const reserved = sep.length;
  let convBudget = RENDER_CHAR_CAP - reserved;
  if (convBudget < 0) {
    // Pathological: appended blocks alone exceed the cap. Truncate the whole thing.
    return full.slice(0, RENDER_CHAR_CAP);
  }

  const marker = (n: number) => `\n… [${n} chars elided] …\n`;
  const head = Math.floor(convBudget * 0.4);
  const tail = Math.floor(convBudget * 0.4);

  // If even head+tail+marker doesn't fit, shrink proportionally.
  const sampleMarker = marker(conversationBody.length);
  let headLen = head;
  let tailLen = tail;
  if (headLen + tailLen + sampleMarker.length > convBudget) {
    const avail = Math.max(0, convBudget - sampleMarker.length);
    headLen = Math.floor(avail / 2);
    tailLen = avail - headLen;
  }

  const headPart = conversationBody.slice(0, headLen);
  const tailPart = tailLen > 0 ? conversationBody.slice(conversationBody.length - tailLen) : "";
  const elided = conversationBody.length - headPart.length - tailPart.length;
  const body = headPart + marker(elided) + tailPart;

  const result = body + sep;
  // Final safety clamp.
  return result.length <= RENDER_CHAR_CAP ? result : result.slice(0, RENDER_CHAR_CAP);
}

// Full result including the privacy-gate redaction stats. The pipeline uses this
// to audit how much PII/credential material was stripped before the LLM saw it.
export interface RenderResult {
  text: string; // sanitized — safe to send to the judge
  rawLen: number;
  nRedactionHits: number; // total rule fires
  hadCredential: boolean;
  nStrongPii: number;
}

export function renderEpisodeSafe(episode: Episode): RenderResult {
  const events: RawEvent[] = Array.isArray(episode.events) ? episode.events : [];
  const conversationBody = buildConversation(events).join("\n");

  const signalsBlock = buildSignalsBlock(episode);
  const subagentsBlock = buildSubagentsBlock(episode);
  const appended = subagentsBlock
    ? signalsBlock + "\n\n" + subagentsBlock
    : signalsBlock;

  const raw = fitWithinCap(conversationBody, appended);
  // PRIVACY GATE — drop credentials / mask PII before this text can reach the LLM.
  const red = sanitizeRendered(raw);
  return {
    text: red.text,
    rawLen: raw.length,
    nRedactionHits: red.hits.length,
    hadCredential: red.hadCredential,
    nStrongPii: red.nStrongPii,
  };
}

// Back-compat: callers that only need the (sanitized) text.
export function renderEpisode(episode: Episode): string {
  return renderEpisodeSafe(episode).text;
}
