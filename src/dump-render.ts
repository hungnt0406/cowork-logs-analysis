// dump-render.ts — Gate 3: eyeball EXACTLY what the judge will read ($0, no LLM).
//
// The render is reconstructed per-session at judge time and never persisted, so to
// inspect it we re-run the (free) structure phase for the target session(s) and
// print renderEpisode(ep) — the identical string judgeEpisode() would send.
//
//   bun run dump-render <episodeId>          # one episode, full body   (e.g. <sid>#2)
//   bun run dump-render --session <id|prefix># every episode in a session
//   bun run dump-render --sample [N]         # N representative episodes across the corpus
//   bun run dump-render --list               # metadata table only (cap/elision scan), no bodies
//   bun run dump-render --random N           # N random episodes
//
// Filters (corpus modes): --project <substr>  --limit <N sessions>
//
// What to look for: the ASK at the top, the OUTCOME at the bottom, a plausible
// EVIDENCE SIGNALS block, subagents summarized, and chars ≤ RENDER_CHAR_CAP. A
// render that lost the ask or the outcome = every label for it is garbage.
import { discoverSessions } from "./discover.ts";
import { classifyTurns } from "./classify.ts";
import { segmentEpisodes } from "./segment.ts";
import { attachSubagents } from "./subagents.ts";
import { computeSignalsAndFeatures } from "./signals.ts";
import { renderEpisode } from "./render.ts";
import { readEvents } from "./util.ts";
import { RENDER_CHAR_CAP, type Episode, type SessionInfo } from "./types.ts";

interface Flags {
  episodeId?: string;
  session?: string;
  sample?: number;
  random?: number;
  list: boolean;
  project?: string;
  limit?: number;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session": f.session = argv[++i]; break;
      case "--sample": {
        const n = Number(argv[i + 1]);
        if (Number.isFinite(n)) { f.sample = n; i++; } else f.sample = 3;
        break;
      }
      case "--random": f.random = Number(argv[++i]) || 1; break;
      case "--list": f.list = true; break;
      case "--project": f.project = argv[++i]; break;
      case "--limit": f.limit = Number(argv[++i]); break;
      default:
        if (!a.startsWith("--") && !f.episodeId) f.episodeId = a;
        else if (a.startsWith("--")) console.warn(`[dump-render] unknown flag: ${a}`);
    }
  }
  return f;
}

// Build a session's episodes EXACTLY as pipeline.ts does before judging
// (incl. the isLastInSession flag signals.ts reads + subagents + signals).
async function buildEpisodes(session: SessionInfo): Promise<Episode[]> {
  const events = await readEvents(session.jsonlPath);
  const turns = await classifyTurns(session, events, { classifyLlm: false });
  const episodes = segmentEpisodes(session, events, turns);
  episodes.forEach((ep, i) => {
    (ep as any).isLastInSession = i === episodes.length - 1;
  });
  await attachSubagents(session, episodes);
  for (const ep of episodes) computeSignalsAndFeatures(ep);
  return episodes;
}

interface Rendered { ep: Episode; text: string; }

function meta(r: Rendered): string {
  const elided = r.text.includes("chars elided");
  const capFlag = r.text.length >= RENDER_CHAR_CAP ? " AT-CAP" : "";
  return (
    `${r.ep.episodeId}  turns=${r.ep.nTurns} corr=${r.ep.nCorrections} ` +
    `subagents=${r.ep.usedSubagents ? r.ep.subagentSummaries.length : 0} ` +
    `chars=${r.text.length}/${RENDER_CHAR_CAP}${elided ? " ELIDED" : ""}${capFlag}`
  );
}

function printBody(r: Rendered) {
  console.log("\n" + "─".repeat(80));
  console.log(meta(r));
  console.log("─".repeat(80));
  console.log(r.text);
}

async function main() {
  const f = parseFlags(process.argv.slice(2));

  // ── single episode by id (sessionId#idx) ──────────────────────────────────
  if (f.episodeId) {
    const hash = f.episodeId.lastIndexOf("#");
    if (hash === -1) {
      console.error(`[dump-render] episode id must look like <sessionId>#<idx>; got ${f.episodeId}`);
      process.exit(2);
    }
    const sid = f.episodeId.slice(0, hash);
    const all = await discoverSessions();
    const session = all.find((s) => s.sessionId === sid) || all.find((s) => s.sessionId.startsWith(sid));
    if (!session) { console.error(`[dump-render] session not found: ${sid}`); process.exit(2); }
    const eps = await buildEpisodes(session);
    const ep = eps.find((e) => e.episodeId === f.episodeId);
    if (!ep) { console.error(`[dump-render] episode ${f.episodeId} not in session (has ${eps.length})`); process.exit(2); }
    printBody({ ep, text: renderEpisode(ep) });
    return;
  }

  // ── whole session ─────────────────────────────────────────────────────────
  if (f.session) {
    const all = await discoverSessions();
    const session = all.find((s) => s.sessionId === f.session) || all.find((s) => s.sessionId.startsWith(f.session!));
    if (!session) { console.error(`[dump-render] session not found: ${f.session}`); process.exit(2); }
    const eps = await buildEpisodes(session);
    console.log(`[dump-render] ${session.project}/${session.sessionId.slice(0, 8)} — ${eps.length} episode(s)`);
    for (const ep of eps) printBody({ ep, text: renderEpisode(ep) });
    return;
  }

  // ── corpus modes: build everything matching the filter (fast, <1s) ─────────
  const sessions = await discoverSessions({ project: f.project, limit: f.limit });
  const rendered: Rendered[] = [];
  for (const s of sessions) {
    let eps: Episode[];
    try { eps = await buildEpisodes(s); } catch { continue; }
    for (const ep of eps) rendered.push({ ep, text: renderEpisode(ep) });
  }
  if (rendered.length === 0) { console.error("[dump-render] no episodes matched."); process.exit(2); }

  if (f.list) {
    rendered.sort((a, b) => b.ep.nTurns - a.ep.nTurns);
    for (const r of rendered) console.log(meta(r));
    console.log(`\n[dump-render] ${rendered.length} episodes. ` +
      `${rendered.filter((r) => r.text.includes("chars elided")).length} elided, ` +
      `${rendered.filter((r) => r.ep.usedSubagents).length} with subagents.`);
    return;
  }

  if (f.random) {
    for (let i = rendered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rendered[i], rendered[j]] = [rendered[j]!, rendered[i]!];
    }
    rendered.slice(0, f.random).forEach(printBody);
    return;
  }

  // default / --sample N: a representative spread — longest, an elided one, one
  // with subagents, one with a correction — so you see the interesting shapes.
  const n = f.sample ?? 3;
  const byTurns = [...rendered].sort((a, b) => b.ep.nTurns - a.ep.nTurns);
  const picks = new Map<string, Rendered>();
  const add = (r?: Rendered) => { if (r) picks.set(r.ep.episodeId, r); };
  add(byTurns[0]); // longest
  add(rendered.find((r) => r.text.includes("chars elided"))); // elided (cap stress)
  add(rendered.find((r) => r.ep.usedSubagents)); // has subagents
  add(rendered.find((r) => r.ep.nCorrections > 0)); // has a correction
  for (const r of byTurns) { if (picks.size >= n) break; add(r); } // fill to N
  console.log(`[dump-render] ${picks.size} representative episode(s) of ${rendered.length} ` +
    `(${f.project ? `project~="${f.project}", ` : ""}use --list for the full table)`);
  [...picks.values()].slice(0, n).forEach(printBody);
}

main().catch((e) => { console.error("[dump-render] fatal:", e); process.exit(1); });
