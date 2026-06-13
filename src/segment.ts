// segment.ts — group classified turns into episodes.
// An episode = maximal run starting at a `new_task` turn, absorbing all following
// correction/continuation/approval/interruption/paste turns AND all assistant/
// tool/system/pr-link events, until the next `new_task` turn.
import type {
  Episode,
  ClassifiedTurn,
  RawEvent,
  SessionInfo,
  EpisodeFeatures,
} from "./types.ts";
import { sha256, truncate } from "./util.ts";

function zeroFeatures(): EpisodeFeatures {
  return {
    nToolCalls: 0,
    toolSequence: "",
    nFilesRead: 0,
    nFilesEdited: 0,
    nTestRuns: 0,
    durationS: 0,
    idleS: 0,
    tokens: 0,
  };
}

// Stable content signature for the judge cache key. Deterministic, depends only
// on episode content: human-turn texts, assistant text parts, tool_use name+input.
function computeContentHash(events: RawEvent[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type === "user") {
      // human-turn texts only (tool results carry toolUseResult / tool_result)
      if (ev.toolUseResult !== undefined && ev.toolUseResult !== null) continue;
      const c = ev.message?.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        if (c.some((p: any) => p && p.type === "tool_result")) continue;
        text = c
          .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("");
      }
      if (text) parts.push(`USER:${text}`);
    } else if (ev.type === "assistant") {
      const c = ev.message?.content;
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type === "text" && typeof p.text === "string") {
            parts.push(`A:${p.text}`);
          } else if (p?.type === "tool_use") {
            let inputStr = "";
            try {
              inputStr = JSON.stringify(p.input ?? {});
            } catch {
              inputStr = "";
            }
            parts.push(`T:${p.name}${inputStr}`);
          }
        }
      }
    }
  }
  return sha256(parts.join("\n"));
}

// First/last event timestamp in a slice.
function sliceTimespan(events: RawEvent[]): { startedAt: string; endedAt: string } {
  let startedAt = "";
  let endedAt = "";
  for (const ev of events) {
    if (typeof ev.timestamp === "string" && ev.timestamp) {
      if (!startedAt) startedAt = ev.timestamp;
      endedAt = ev.timestamp;
    }
  }
  return { startedAt, endedAt };
}

function buildEpisode(
  session: SessionInfo,
  idx: number,
  startTurnIdx: number,
  epTurns: ClassifiedTurn[],
  epEvents: RawEvent[]
): Episode {
  const episodeId = `${session.sessionId}#${idx}`;
  // stamp episodeId on the member turns
  for (const t of epTurns) t.episodeId = episodeId;

  let nCorrections = 0;
  let nInterruptions = 0;
  let nApprovals = 0;
  let nImages = 0;
  for (const t of epTurns) {
    if (t.role === "correction") nCorrections++;
    else if (t.role === "interruption") nInterruptions++;
    else if (t.role === "approval") nApprovals++;
    nImages += t.nImages;
  }

  const firstPrompt = epTurns.length ? truncate(epTurns[0].text, 200) : "";
  const { startedAt, endedAt } = sliceTimespan(epEvents);

  return {
    episodeId,
    sessionId: session.sessionId,
    project: session.project,
    idx,
    startTurnIdx,
    turns: epTurns,
    nTurns: epTurns.length,
    nCorrections,
    nInterruptions,
    nApprovals,
    nImages,
    usedSubagents: false,
    subagentSummaries: [],
    firstPrompt,
    startedAt,
    endedAt,
    contentHash: computeContentHash(epEvents),
    events: epEvents,
    signals: [],
    features: zeroFeatures(),
    taskKey: null,
  };
}

export function segmentEpisodes(
  session: SessionInfo,
  events: RawEvent[],
  turns: ClassifiedTurn[]
): Episode[] {
  // Boundary turns = those classified new_task, in event order.
  const newTaskTurns = turns.filter((t) => t.role === "new_task");

  // Fallback: no new_task boundary => whole session is one episode.
  if (newTaskTurns.length === 0) {
    // ...but a session with NO human turns at all (e.g. /clear, resumed, or
    // tool-only sessions) must produce NO episode — otherwise we synthesize a
    // degenerate empty episode (n_turns=0, first_prompt="") that still gets a
    // content_hash, so it looks judgeable+cacheable and would waste a judge
    // call and pollute mine/report with a no-ask noise label.
    if (turns.length === 0) return [];
    const ep = buildEpisode(session, 0, turns[0].idx, turns, events);
    return [ep];
  }

  const episodes: Episode[] = [];

  // Episode 0 may have leading events before the first new_task (e.g. setup,
  // a non-new_task turn). Per spec, include leading events only in fallback;
  // here, the first episode starts at the first new_task's eventIndex.
  // Any human turns before the first new_task are attached to episode 0 as
  // context (they are non-boundary roles), and leading events are absorbed.
  for (let b = 0; b < newTaskTurns.length; b++) {
    const startTurn = newTaskTurns[b];
    const nextTurn = newTaskTurns[b + 1];

    // event slice: from this new_task's eventIndex up to (excluding) the next
    // new_task's eventIndex. For the first episode, absorb leading events from 0.
    const eventLo = b === 0 ? 0 : startTurn.eventIndex;
    const eventHi = nextTurn ? nextTurn.eventIndex : events.length;
    const epEvents = events.slice(eventLo, eventHi);

    // member human turns: those whose eventIndex falls in [eventLo, eventHi).
    const epTurns = turns.filter(
      (t) => t.eventIndex >= eventLo && t.eventIndex < eventHi
    );

    episodes.push(
      buildEpisode(session, b, startTurn.idx, epTurns, epEvents)
    );
  }

  return episodes;
}

// ── tiny demo CLI (optional) ──────────────────────────────────────────────────
if (import.meta.main) {
  const { discoverSessions } = await import("./discover.ts");
  const { classifyTurns } = await import("./classify.ts");
  const { readEvents } = await import("./util.ts");
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun run src/segment.ts <sessionId>");
    process.exit(1);
  }
  const all = await discoverSessions();
  const session =
    all.find((s) => s.sessionId === arg) ||
    all.find((s) => s.sessionId.startsWith(arg));
  if (!session) {
    console.error(`session not found: ${arg}`);
    process.exit(1);
  }
  const events = await readEvents(session.jsonlPath);
  const turns = await classifyTurns(session, events);
  const episodes = segmentEpisodes(session, events, turns);
  console.log(`${episodes.length} episodes from ${turns.length} human turns\n`);
  for (const ep of episodes) {
    console.log(
      `#${ep.idx}  turns=${ep.nTurns} corr=${ep.nCorrections} int=${ep.nInterruptions} app=${ep.nApprovals} img=${ep.nImages}  "${ep.firstPrompt.replace(/\s+/g, " ").slice(0, 70)}"`
    );
  }
}
