// Small shared helpers. Keep dependency-free (only bun + node builtins).
import { createHash } from "crypto";
import type { RawEvent } from "./types.ts";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Parse a .jsonl transcript into ordered RawEvents (skips unparseable lines).
export async function readEvents(jsonlPath: string): Promise<RawEvent[]> {
  const text = await Bun.file(jsonlPath).text();
  const out: RawEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RawEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// Extract the human-visible text from a user event's message.content.
// Returns "" when there is no text part (e.g. image-only turn).
export function extractUserText(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("")
      .trim();
  }
  return "";
}

// Defensively extract the first balanced {...} object from a model response,
// stripping any markdown code fences or surrounding prose. Returns the JSON
// substring (caller parses) or null when no balanced object is present.
// Single source of truth for JSON-object extraction (judge.ts + skilldraft.ts).
export function extractJsonObject(raw: string): string | null {
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

// Count image parts in a user event's message.content.
export function countImages(message: any): number {
  const c = message?.content;
  if (!Array.isArray(c)) return 0;
  return c.filter((p: any) => p && p.type === "image").length;
}

// True iff a type:"user" event is a genuine HUMAN turn (image-aware,
// exact tool-result exclusion). Mixed text+image is accepted.
export function isHumanTurn(ev: RawEvent): boolean {
  if (ev.type !== "user") return false;
  if (ev.isMeta) return false;
  if (ev.toolUseResult !== undefined && ev.toolUseResult !== null) return false;
  const c = ev.message?.content;
  if (Array.isArray(c) && c.some((p: any) => p && p.type === "tool_result")) return false;
  const text = extractUserText(ev.message);
  const hasImage = countImages(ev.message) > 0;
  // image-only turn (no text) still counts as a human turn (continuation/evidence)
  if (!text && !hasImage) return false;
  // harness / slash-command envelopes are not human asks
  if (text && text.startsWith("<")) return false;
  return true;
}
