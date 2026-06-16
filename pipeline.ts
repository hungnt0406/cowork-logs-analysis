// Orchestrator (resumable): discover → classify → group → signals → subagents → render → judge → store.
// Usage:
//   bun run pipeline.ts [--project <substr>] [--limit N] [--since ISO] [--resume]
//                       [--classify-llm] [--max-episodes N] [--no-judge]
//                       [--max-cost USD] [--yes] [--db <path>] [--mine] [--panel]
//                       [--runner ccs|claude] [--ccs-profile <name>]
//
// --panel runs the multi-judge panel (outcome + efficiency + quality + consolidator =
//   4 SERIAL calls/episode, ~4× cost & latency) instead of the single outcome judge.
//   OFF by default → byte-for-byte the existing single-judge behavior. Panel labels use
//   a DISTINCT judge_prompt_hash (getPanelPromptHash) so switching modes never collides
//   in cache but does re-pay for the toggled episodes (transparent, accepted).
//
// --runner picks how the headless `claude -p` calls are routed (default: ccs):
//   ccs    → real `claude` binary with the ccs profile's env injected
//            (ANTHROPIC_BASE_URL/_AUTH_TOKEN from `ccs env <--ccs-profile>`, default my-api)
//   claude → plain `claude` with the ambient environment
//
// Resume model: all writes are idempotent upserts and the judge is cache-keyed on
// content+prompt+schema+model+cli, so re-running simply skips already-judged episodes.
import { discoverSessions } from "./src/discover.ts";
import { classifyTurns } from "./src/classify.ts";
import { segmentEpisodes } from "./src/segment.ts";
import { attachSubagents } from "./src/subagents.ts";
import { computeSignalsAndFeatures } from "./src/signals.ts";
import { renderEpisodeSafe } from "./src/render.ts";
import { filterExcluded } from "./src/privacy.ts";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  judgeEpisode,
  judgeEpisodePanel,
  getJudgePromptHash,
  getPanelPromptHash,
  getModel,
  getCliVersion,
} from "./src/judge.ts";
import { mine } from "./src/mine.ts";
import { report } from "./src/report.ts";
import { configureRunner, describeRunner, type RunnerName } from "./src/runner.ts";
import {
  openDb,
  upsertSession,
  upsertTurn,
  upsertEpisode,
  upsertLabel,
  isJudged,
  pruneSessionEpisodes,
  type CacheKey,
} from "./src/db.ts";
import { readEvents } from "./src/util.ts";
import { LABEL_SCHEMA_VERSION, type Episode } from "./src/types.ts";

// Rough metered cost of one headless judge call (used only for the est-cost gate;
// actual cost varies with episode size and the retry path).
const COST_PER_JUDGE_USD = 0.4;
const AVG_EPISODES_PER_SESSION = 3; // corpus ≈ 329 episodes / 111 sessions
const CONFIRM_COST_THRESHOLD_USD = 5; // only prompt above this estimated spend
const MAX_CONSEC_JUDGE_ERRORS = 5; // circuit breaker for a broken judge/CLI

interface Flags {
  project?: string;
  limit?: number;
  since?: string;
  resume: boolean;
  classifyLlm: boolean;
  maxEpisodes?: number;
  noJudge: boolean;
  maxCost?: number;
  yes: boolean;
  dbPath?: string;
  mine: boolean;
  panel: boolean;
  runner?: RunnerName;
  ccsProfile?: string;
  business?: string;
}

// Parse a numeric flag, failing CLOSED on a missing/non-numeric value. A cost-bearing
// run must never silently fall back to "unbounded" because a flag value was a typo.
function numFlag(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) {
    console.error(
      `[pipeline] flag ${name} requires a numeric value (got ${JSON.stringify(raw)}). Aborting.`
    );
    process.exit(2);
  }
  return n;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { resume: false, classifyLlm: false, noJudge: false, yes: false, mine: false, panel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--project": f.project = next(); break;
      case "--limit": f.limit = numFlag("--limit", next()); break;
      case "--since": f.since = next(); break;
      case "--resume": f.resume = true; break;
      case "--classify-llm": f.classifyLlm = true; break;
      case "--max-episodes": f.maxEpisodes = numFlag("--max-episodes", next()); break;
      case "--no-judge": f.noJudge = true; break;
      case "--max-cost": f.maxCost = numFlag("--max-cost", next()); break;
      case "--yes": case "-y": f.yes = true; break;
      case "--db": f.dbPath = next(); break;
      case "--mine": f.mine = true; break;
      case "--panel": f.panel = true; break;
      case "--runner": {
        const v = next();
        if (v !== "ccs" && v !== "claude") {
          console.error(
            `[pipeline] --runner must be "ccs" or "claude" (got ${JSON.stringify(v)}). Aborting.`
          );
          process.exit(2);
        }
        f.runner = v;
        break;
      }
      case "--ccs-profile": f.ccsProfile = next(); break;
      case "--business": f.business = next(); break;
      default:
        if (a.startsWith("--")) console.warn(`[pipeline] unknown flag ignored: ${a}`);
    }
  }
  if (f.limit !== undefined && f.limit < 0) {
    console.error("[pipeline] --limit must be >= 0. Aborting.");
    process.exit(2);
  }
  if (f.maxEpisodes !== undefined && f.maxEpisodes < 0) {
    console.error("[pipeline] --max-episodes must be >= 0. Aborting.");
    process.exit(2);
  }
  return f;
}

function log(msg: string) {
  console.log(`[pipeline] ${msg}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const db = openDb(flags.dbPath);

  // Select the LLM runner before any headless `claude -p` call. Default: ccs:my-api.
  configureRunner({ runner: flags.runner, ccsProfile: flags.ccsProfile });
  log(`LLM runner: ${describeRunner()}`);

  // Cache-key constants (cheap, side-effect-free getters) — resolved once.
  // Panel mode keys on a DISTINCT prompt hash so its labels never collide with
  // single-mode labels in episode_labels (PK episode_id).
  const judgePromptHash = flags.panel ? getPanelPromptHash() : getJudgePromptHash();
  const model = getModel();
  const cliVersion = flags.noJudge ? "" : await getCliVersion();

  // Panel = 4 serial calls/episode (outcome+efficiency+quality+consolidator); single = 1.
  // Drives the est-cost gate, the --max-cost ceiling, and the spend accumulator.
  const costPerEpisode = COST_PER_JUDGE_USD * (flags.panel ? 4 : 1);
  if (flags.panel) log(`panel mode: ~4 calls/episode (~$${costPerEpisode.toFixed(2)}/episode)`);

  log(`discovering sessions${flags.project ? ` (project~="${flags.project}")` : ""}…`);
  const discovered = await discoverSessions({
    project: flags.project,
    since: flags.since,
    limit: flags.limit,
  });
  // PRIVACY / worker-protection — drop opt-out sessions BEFORE reading content.
  const { kept: sessions, excluded } = filterExcluded(discovered);
  log(`found ${discovered.length} session(s); ${sessions.length} kept, ${excluded.length} opted-out.`);
  for (const e of excluded) {
    log(`  · opt-out: ${e.project}/${e.sessionId.slice(0, 8)} — ${e.reason}`);
  }
  // Redaction audit accumulators (transparency — POLICY §4).
  let redactionHits = 0;
  let credentialEpisodes = 0;
  let strongPiiHits = 0;

  // ── Cost gate (H2) ────────────────────────────────────────────────────────
  // Confirm before an expensive serial judge run. Upper-bound estimate (ignores
  // cache); --yes skips it; --no-judge has no cost. Fails CLOSED on non-TTY.
  if (!flags.noJudge && !flags.yes) {
    const estEpisodes =
      flags.maxEpisodes !== undefined
        ? Math.min(flags.maxEpisodes, sessions.length * AVG_EPISODES_PER_SESSION)
        : sessions.length * AVG_EPISODES_PER_SESSION;
    const estCost = estEpisodes * costPerEpisode;
    if (estCost > CONFIRM_COST_THRESHOLD_USD) {
      const answer = prompt(
        `[pipeline] About to judge up to ~${estEpisodes} uncached episodes ` +
          `(~$${estCost.toFixed(0)} at $${costPerEpisode.toFixed(2)}/episode${flags.panel ? " — panel: 4 calls/episode" : ""}; ` +
          `cache reduces this). Proceed? [y/N] `
      );
      if (!answer || !/^y(es)?$/i.test(answer.trim())) {
        log("aborted at cost gate (pass --yes to skip, or --max-episodes/--max-cost to bound).");
        db.close();
        return;
      }
    }
  }

  let totalEpisodes = 0;
  let judged = 0;
  let skipped = 0;
  let judgeErrors = 0;
  let sessionErrors = 0;
  let spentUsd = 0;
  let consecErrors = 0;
  let stopJudging = false;
  let episodeBudget = flags.maxEpisodes ?? Infinity; // flags validated → never NaN

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si];

    // ── Structure phase (H6: one bad session must skip, not abort the run) ──
    let episodes: Episode[];
    let turns: Awaited<ReturnType<typeof classifyTurns>>;
    try {
      const events = await readEvents(session.jsonlPath);
      turns = await classifyTurns(session, events, { classifyLlm: flags.classifyLlm });
      episodes = segmentEpisodes(session, events, turns);
      episodes.forEach((ep, i) => {
        // consumed by signals.ts abandoned_mid_edit heuristic
        (ep as any).isLastInSession = i === episodes.length - 1;
      });
      await attachSubagents(session, episodes);
      for (const ep of episodes) computeSignalsAndFeatures(ep);

      // persist structure: prune orphans first, then session, turns, episodes
      pruneSessionEpisodes(db, session.sessionId, episodes.map((e) => e.episodeId));
      upsertSession(db, session, episodes.length);
      for (const t of turns) upsertTurn(db, t);
      for (const ep of episodes) upsertEpisode(db, ep);
    } catch (e) {
      sessionErrors++;
      log(`  ! skip session ${session.project}/${session.sessionId.slice(0, 8)} (${(e as Error).message})`);
      continue;
    }

    totalEpisodes += episodes.length;
    log(
      `[${si + 1}/${sessions.length}] ${session.project}/${session.sessionId.slice(0, 8)} ` +
        `— ${turns.length} turns → ${episodes.length} episodes`
    );

    // ── Judge phase ──────────────────────────────────────────────────────────
    if (flags.noJudge || stopJudging) continue;
    for (const ep of episodes) {
      if (episodeBudget <= 0) {
        log(`reached --max-episodes budget; stopping judge phase.`);
        stopJudging = true;
        break;
      }
      const key: CacheKey = {
        episodeId: ep.episodeId,
        contentHash: ep.contentHash,
        judgePromptHash,
        labelSchemaVersion: LABEL_SCHEMA_VERSION,
        model,
        cliVersion,
      };
      if (isJudged(db, key)) {
        skipped++;
        continue;
      }
      if (flags.maxCost !== undefined && spentUsd + costPerEpisode > flags.maxCost) {
        log(`reached --max-cost ceiling ($${flags.maxCost}); stopping judge phase.`);
        stopJudging = true;
        break;
      }
      episodeBudget--;
      spentUsd += costPerEpisode;
      try {
        const r = renderEpisodeSafe(ep);
        redactionHits += r.nRedactionHits;
        strongPiiHits += r.nStrongPii;
        if (r.hadCredential) credentialEpisodes++;
        const { label, meta } = flags.panel
          ? await judgeEpisodePanel(r.text, ep.episodeId, { model })
          : await judgeEpisode(r.text, ep.episodeId, { model });
        upsertLabel(db, label, meta);
        judged++;
        consecErrors = 0;
        process.stdout.write(`\r  judged ${judged} (skipped ${skipped}, errors ${judgeErrors})   `);
      } catch (e) {
        judgeErrors++;
        consecErrors++;
        log(`  ! judge failed for ${ep.episodeId}: ${(e as Error).message}`);
        if (consecErrors >= MAX_CONSEC_JUDGE_ERRORS) {
          log(
            `circuit breaker: ${consecErrors} consecutive judge failures — stopping judge ` +
              `phase (structure for remaining sessions still persists). Check the claude CLI.`
          );
          stopJudging = true;
          break;
        }
      }
    }
    if (!flags.noJudge) process.stdout.write("\n");
  }

  log(
    `done. sessions=${sessions.length} (errors=${sessionErrors}) episodes=${totalEpisodes} ` +
      `judged=${judged} cached/skipped=${skipped} judgeErrors=${judgeErrors} ` +
      `est_spend=$${spentUsd.toFixed(2)}`
  );

  // Privacy/worker-protection audit (POLICY §4 transparency).
  try {
    const stateDir = join(import.meta.dir, "out", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "audit.json"),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          sessions_discovered: discovered.length,
          sessions_kept: sessions.length,
          sessions_opted_out: excluded,
          episodes_judged: judged,
          redaction_hits: redactionHits,
          episodes_with_credentials_redacted: credentialEpisodes,
          strong_pii_masked: strongPiiHits,
        },
        null,
        2
      ),
      "utf8"
    );
    log(
      `privacy audit → out/state/audit.json (redaction_hits=${redactionHits}, ` +
        `credential_eps=${credentialEpisodes}, strong_pii=${strongPiiHits})`
    );
  } catch {
    /* never block on audit write */
  }
  if (flags.mine && !flags.noJudge) {
    log("running mine + report…");
    await mine(db);
    await report(db, { businessContext: flags.business ?? "" });
    log("wrote out/report.md and out/candidates.json");
  }
  db.close();
}

main().catch((e) => {
  console.error("[pipeline] fatal:", e);
  process.exit(1);
});
