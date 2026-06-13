// Stage 4 — subagent compaction (v1 = compact summary only).
//
// Scans each episode's events for assistant `Agent` tool_use calls and attaches a
// COMPACT SubagentSummary to the parent episode. Never loads the full nested fork
// transcript into the episode (token blow-up) — only a tool count + 1-line outcome.
//
// Linking strategy (most→least reliable, all best-effort):
//   1. The Agent toolUseResult (on the following user/tool-result event) carries
//      `agentId`, `agentType`, `totalToolUseCount`, `status` directly — when present
//      this is the ground-truth link and needs no fork file at all.
//   2. Each `subagents/agent-<agentId>.meta.json` carries `{agentType, description,
//      toolUseId}` where `toolUseId` === the parent Agent tool_use `id`. We build a
//      toolUseId→fork map and join on the Agent call id.
//   3. Fall back to matching the meta.json `description` to the Agent input.description.
//   4. Final fallback: synthesize the summary from the Agent tool_use input alone
//      (subagent_type / description), toolCount = 0.
//
// Robust by construction: missing subagentsDir / meta.json / unparseable forks are
// skipped silently; this function never throws.

import { readdir } from "fs/promises";
import { join } from "path";
import type { Episode, RawEvent, SessionInfo, SubagentSummary } from "./types.ts";
import { readEvents } from "./util.ts";

// A discovered fork file + its meta, indexed for lookup.
interface ForkMeta {
  agentId: string; // derived from the filename agent-<agentId>.jsonl
  filePath: string;
  agentType?: string;
  description?: string;
  toolUseId?: string; // === parent Agent tool_use id, when the meta records it
}

// Read the subagents dir once per session and index every fork by toolUseId,
// agentId, and (lowercased) description for best-effort joining.
async function indexForks(subagentsDir: string): Promise<{
  byToolUseId: Map<string, ForkMeta>;
  byDescription: Map<string, ForkMeta>;
  all: ForkMeta[];
}> {
  const byToolUseId = new Map<string, ForkMeta>();
  const byDescription = new Map<string, ForkMeta>();
  const all: ForkMeta[] = [];

  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return { byToolUseId, byDescription, all };
  }

  for (const name of entries) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const agentId = name.slice("agent-".length, -".jsonl".length);
    const fork: ForkMeta = { agentId, filePath: join(subagentsDir, name) };

    // Load sibling meta.json if present.
    const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
    try {
      const metaText = await Bun.file(metaPath).text();
      const meta = JSON.parse(metaText);
      if (meta && typeof meta === "object") {
        if (typeof meta.agentType === "string") fork.agentType = meta.agentType;
        if (typeof meta.description === "string") fork.description = meta.description;
        if (typeof meta.toolUseId === "string") fork.toolUseId = meta.toolUseId;
      }
    } catch {
      /* missing / unparseable meta.json → keep the bare fork */
    }

    all.push(fork);
    if (fork.toolUseId) byToolUseId.set(fork.toolUseId, fork);
    if (fork.description) byDescription.set(fork.description.toLowerCase().trim(), fork);
  }

  return { byToolUseId, byDescription, all };
}

// Count tool_use events + derive a 1-line outcome from a fork transcript.
// Returns null if the fork can't be read/parsed.
async function summarizeFork(
  filePath: string
): Promise<{ toolCount: number; outcome: string } | null> {
  let events: RawEvent[];
  try {
    events = await readEvents(filePath);
  } catch {
    return null;
  }
  if (events.length === 0) return null;

  let toolCount = 0;
  let apiError = false;
  let lastAssistantText = "";
  let lastEventResolved = true; // does the transcript end on a settled state?

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "api_error") apiError = true;
    if (ev.type === "assistant") {
      const c = ev.message?.content;
      if (Array.isArray(c)) {
        let endsOnUnresolvedToolUse = false;
        for (const p of c) {
          if (p?.type === "tool_use") {
            toolCount++;
            endsOnUnresolvedToolUse = true;
          } else if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
            lastAssistantText = p.text.trim();
            endsOnUnresolvedToolUse = false;
          }
        }
        lastEventResolved = !endsOnUnresolvedToolUse;
      }
    } else if (ev.type === "user") {
      // a tool result resolves the prior tool_use
      lastEventResolved = true;
    }
  }

  const snippet = lastAssistantText.replace(/\s+/g, " ").slice(0, 120);
  let outcome: string;
  if (apiError) outcome = "error (api_error)";
  else if (!lastEventResolved) outcome = "unknown (ended mid tool-call)";
  else if (lastAssistantText) outcome = `completed: ${snippet}`;
  else outcome = "unknown";

  return { toolCount, outcome };
}

// Outcome string derived directly from the Agent toolUseResult, when available.
function outcomeFromToolResult(tur: any): string | null {
  if (!tur || typeof tur !== "object") return null;
  const status = typeof tur.status === "string" ? tur.status : null;
  if (status) return status; // e.g. "completed"
  return null;
}

export async function attachSubagents(
  session: SessionInfo,
  episodes: Episode[]
): Promise<void> {
  // Quick exit: nothing to do if no episode used an Agent at all.
  // (Still safe & cheap to scan; we index forks lazily only when needed.)
  let forks: Awaited<ReturnType<typeof indexForks>> | null = null;
  const haveSubagentsDir = !!session.subagentsDir;

  for (const episode of episodes) {
    const events = episode.events ?? [];

    // Locate every Agent tool_use in this episode, in order.
    interface AgentCall {
      id: string | undefined;
      subagentType: string;
      description: string;
    }
    const agentCalls: AgentCall[] = [];
    // Map from Agent tool_use id → its toolUseResult (scanned from following events).
    const resultById = new Map<string, any>();

    for (const ev of events) {
      if (ev.type === "assistant") {
        const c = ev.message?.content;
        if (Array.isArray(c)) {
          for (const p of c) {
            if (p?.type === "tool_use" && p?.name === "Agent") {
              const input = p.input ?? {};
              agentCalls.push({
                id: typeof p.id === "string" ? p.id : undefined,
                subagentType:
                  typeof input.subagent_type === "string" ? input.subagent_type : "unknown",
                description: typeof input.description === "string" ? input.description : "",
              });
            }
          }
        }
      } else if (ev.type === "user" && ev.toolUseResult) {
        // Agent toolUseResult carries agentId/agentType/totalToolUseCount/status.
        // Link it back to the Agent call via the tool_result content part's tool_use_id.
        const tur = ev.toolUseResult;
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const p of content) {
            if (p?.type === "tool_result" && typeof p.tool_use_id === "string") {
              resultById.set(p.tool_use_id, tur);
            }
          }
        }
      }
    }

    if (agentCalls.length === 0) continue;

    episode.usedSubagents = true;
    if (!episode.subagentSummaries) episode.subagentSummaries = [];

    // Lazily index the fork dir the first time we actually need it.
    if (forks === null && haveSubagentsDir) {
      forks = await indexForks(session.subagentsDir!);
    }

    for (const call of agentCalls) {
      const tur = call.id ? resultById.get(call.id) : undefined;

      // Resolve the fork file (if any) for tool counting / outcome snippet.
      let fork: ForkMeta | undefined;
      if (forks) {
        if (call.id && forks.byToolUseId.has(call.id)) {
          fork = forks.byToolUseId.get(call.id);
        } else if (call.description) {
          fork = forks.byDescription.get(call.description.toLowerCase().trim());
        }
      }

      // agentId: prefer toolUseResult.agentId, then the linked fork, else "".
      const agentId: string =
        (tur && typeof tur.agentId === "string" && tur.agentId) ||
        fork?.agentId ||
        "";

      // agentType / description: prefer the richest source available.
      const agentType: string =
        (tur && typeof tur.agentType === "string" && tur.agentType) ||
        fork?.agentType ||
        call.subagentType ||
        "unknown";
      const description: string = fork?.description || call.description || "";

      // toolCount: prefer the authoritative count from toolUseResult, then the fork
      // transcript, else 0.
      let toolCount = 0;
      let outcome = "unknown";

      if (tur && typeof tur.totalToolUseCount === "number") {
        toolCount = tur.totalToolUseCount;
      }
      const resultOutcome = outcomeFromToolResult(tur);
      if (resultOutcome) outcome = resultOutcome;

      // If we still lack a count or outcome, fall back to summarizing the fork file.
      if ((toolCount === 0 || outcome === "unknown") && fork) {
        const summary = await summarizeFork(fork.filePath);
        if (summary) {
          if (toolCount === 0) toolCount = summary.toolCount;
          if (outcome === "unknown") outcome = summary.outcome;
        }
      }

      const entry: SubagentSummary = {
        agentId,
        agentType,
        description,
        toolCount,
        outcome,
      };
      episode.subagentSummaries.push(entry);
    }
  }
}
