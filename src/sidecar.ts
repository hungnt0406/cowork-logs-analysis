// sidecar.ts — Business sidecar (merged from cowork-behavior-harness).
//
// constraint: "business is a sidecar, joined LATE; do not couple the
// reasoning to business or you lose independent evaluation." So this module runs
// AFTER mine() has already ranked candidates on user-behaviour alone. The judge and
// the miner NEVER receive business context — only this post-hoc annotator does.
//
// For each ranked candidate it produces a short business_note. With a real LLM
// runner it asks the model to relate the (behaviour-only) candidate to the supplied
// business context; offline it falls back to a deterministic note. Never throws.

import type { RankedCandidate } from "./types.ts";
import { runnerEnv } from "./runner.ts";

export interface BusinessNote {
  cluster_id: string;
  business_note: string;
}

// One cheap `claude -p` call mapping ranked candidates → business notes. Returns
// null on ANY failure so the caller falls back to deterministic notes.
async function llmBusinessNotes(
  candidates: RankedCandidate[],
  businessContext: string,
  timeoutMs: number
): Promise<Map<string, string> | null> {
  const slim = candidates.map((c) => ({
    cluster_id: c.cluster_id,
    label: c.label,
    recommended_intervention: c.recommended_intervention,
    risk_flags: c.risk_flags,
  }));
  const rubric = `You are a BUSINESS-CRITIQUE sidecar. The workflow candidates below were
ranked purely on user behaviour, with NO business context — that independence is intentional.
Your ONLY job now is to add a one-sentence business note per candidate: how it relates to the
business context, and what a domain owner should check before codifying it. Do NOT re-score.
Return ONLY a JSON object mapping cluster_id → business note string.`;
  const prompt = `${rubric}\n\n## BUSINESS CONTEXT\n${businessContext}\n\n## CANDIDATES\n${JSON.stringify(
    slim
  )}\n`;

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
    const match = inner.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : inner);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const map = new Map<string, string>();
    for (const c of candidates) {
      const v = obj[c.cluster_id];
      if (typeof v === "string" && v.trim()) map.set(c.cluster_id, v.trim());
    }
    return map;
  } catch {
    clearTimeout(timer);
    return null; // never throw — caller falls back
  }
}

function deterministicNote(c: RankedCandidate, businessContext: string): string {
  const bc = businessContext.trim();
  if (!bc) {
    return "No business context supplied — business angle skipped to preserve independent evaluation.";
  }
  const risk = c.risk_flags.length ? ` Note risk flags: ${c.risk_flags.join(", ")}.` : "";
  return `Relate "${c.label}" to: "${bc.slice(0, 80)}". A domain owner must confirm it matches the real process before codifying.${risk}`;
}

// Public: annotate ranked candidates with business notes. business context is used
// ONLY here (never by judge/mine). Returns a cluster_id → note map.
export async function runBusinessSidecar(
  candidates: RankedCandidate[],
  businessContext: string,
  opts?: { useLlm?: boolean; timeoutMs?: number }
): Promise<Map<string, string>> {
  const useLlm = (opts?.useLlm ?? true) && businessContext.trim().length > 0;
  const timeoutMs = opts?.timeoutMs ?? 30000;

  let llm: Map<string, string> | null = null;
  if (useLlm && candidates.length > 0) {
    llm = await llmBusinessNotes(candidates, businessContext, timeoutMs);
  }
  const out = new Map<string, string>();
  for (const c of candidates) {
    out.set(c.cluster_id, llm?.get(c.cluster_id) ?? deterministicNote(c, businessContext));
  }
  return out;
}
