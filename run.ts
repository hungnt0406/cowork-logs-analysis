// run.ts — interactive single-entry wizard for the Cowork Workflow Miner.
//
// Launched via `./start.sh` (which installs Bun if missing) or `bun run start`.
// It preflights the environment, lets you pick which sessions to analyze (specific
// ones or all), runs the pipeline (mine + report), and optionally drafts skills —
// all without hand-crafting flags.
//
// This file orchestrates ONLY: it reuses discoverSessions()/filterExcluded() to build
// the list and shells out to the existing `pipeline.ts` / `src/skilldraft.ts`. No
// analysis logic is duplicated here.
import { stat } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { discoverSessions } from "./src/discover.ts";
import { filterExcluded } from "./src/privacy.ts";
import type { SessionInfo } from "./src/types.ts";

// ── Small interactive helpers (built on Bun's global prompt()) ────────────────
function ask(q: string, def = ""): string {
  const suffix = def ? ` [${def}]` : "";
  const ans = prompt(`${q}${suffix}: `);
  if (ans === null) return def; // EOF / non-interactive
  const t = ans.trim();
  return t === "" ? def : t;
}

function askYesNo(q: string, def: boolean): boolean {
  const ans = (prompt(`${q} [${def ? "Y/n" : "y/N"}]: `) ?? "").trim().toLowerCase();
  if (ans === "") return def;
  return /^y(es)?$/.test(ans);
}

// Parse "all"/"" → all; else a list like "1,3,5-8" → sorted unique 1-based indices in [1,n].
function parseSelection(input: string, n: number): number[] {
  const out = new Set<number>();
  for (const tok of input.split(",").map((t) => t.trim()).filter(Boolean)) {
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) if (i >= 1 && i <= n) out.add(i);
    } else if (/^\d+$/.test(tok)) {
      const i = parseInt(tok, 10);
      if (i >= 1 && i <= n) out.add(i);
    }
  }
  return [...out].sort((x, y) => x - y);
}

// Spawn a subprocess with inherited stdio; resolve to its exit code.
async function run(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return await proc.exited;
}

function line() {
  console.log("─".repeat(72));
}

// ── ccs profile discovery + validation ───────────────────────────────────────
// ccs stores each API profile as ~/.ccs/<name>.settings.json (see `ccs api list`).
// We enumerate those names rather than hardcoding "my-api" (which only exists on
// the author's machine) so a teammate sees THEIR profiles.
function listCcsProfiles(): string[] {
  try {
    return readdirSync(join(homedir(), ".ccs"))
      .filter((f) => f.endsWith(".settings.json"))
      .map((f) => f.slice(0, -".settings.json".length))
      .sort();
  } catch {
    return [];
  }
}

// `ccs env <profile>` is offline + instant; exit 0 means the profile resolves.
// Validating here turns a doomed run (5 judge failures → circuit breaker) into a
// friendly re-prompt at setup time. Returns the first error line on failure.
async function ccsProfileWorks(profile: string): Promise<{ ok: boolean; err: string }> {
  try {
    const proc = Bun.spawn(["ccs", "env", profile], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, err: (err || out).trim().split("\n")[0] || `exit ${code}` };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

// Pick a ccs profile (from the detected list, or typed), validating before return.
// Returns "" if the user gives up — the caller then falls back to `--runner claude`.
async function chooseCcsProfile(): Promise<string> {
  const profiles = listCcsProfiles();
  if (profiles.length) {
    console.log("\nAvailable ccs profiles:");
    profiles.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  } else {
    console.log("\n(Could not auto-detect ccs profiles in ~/.ccs — enter a name manually.)");
  }
  while (true) {
    let chosen: string;
    if (profiles.length === 1) {
      chosen = profiles[0];
      console.log(`Using the only profile: ${chosen}`);
    } else if (profiles.length > 1) {
      const def = profiles.includes("my-api") ? String(profiles.indexOf("my-api") + 1) : "1";
      const pick = ask("Pick a profile by number (or type a name)", def);
      const n = Number(pick);
      chosen = Number.isInteger(n) && n >= 1 && n <= profiles.length ? profiles[n - 1] : pick;
    } else {
      chosen = ask("Which ccs profile?", "");
      if (!chosen) {
        console.log("  (no name entered)");
        continue;
      }
    }
    process.stdout.write(`Validating profile "${chosen}"… `);
    const { ok, err } = await ccsProfileWorks(chosen);
    if (ok) {
      console.log("OK ✅");
      return chosen;
    }
    console.log(`failed ❌  (${err})`);
    const retry =
      profiles.length === 1
        ? askYesNo("Retry validation?", false)
        : askYesNo("Try a different profile?", true);
    if (!retry) return "";
  }
}

async function main() {
  // The wizard is inherently interactive — bail clearly on non-TTY (cron, pipe).
  if (!process.stdin.isTTY) {
    console.error(
      "[run] This wizard needs an interactive terminal.\n" +
        "      For automation use the flags directly, e.g.:\n" +
        "        bun run pipeline.ts --sessions <id,id> --mine --yes\n" +
        "        bun run draft --yes"
    );
    process.exit(1);
  }

  console.log("\nCowork Workflow Miner — interactive setup\n");
  line();

  // ── Preflight ───────────────────────────────────────────────────────────────
  console.log("Installing dependencies (bun install)…");
  const installCode = await run(["bun", "install"]);
  if (installCode !== 0) console.warn("[run] bun install exited non-zero — continuing anyway.");

  const hasClaude = !!Bun.which("claude");
  const hasCcs = !!Bun.which("ccs");
  if (!hasClaude) {
    console.warn(
      "\n[run] `claude` CLI not found on PATH. The LLM judge and skill drafting need it,\n" +
        "      so only the FREE ($0) structure smoke is available this run.\n" +
        "      Install it and re-run to enable the live judge + draft."
    );
  }

  // Runner: default ccs (needs the `ccs` CLI); fall back to plain `claude` login.
  let runner: "ccs" | "claude" = "ccs";
  let ccsProfile = "";
  if (hasClaude) {
    if (hasCcs) {
      const useCcs = askYesNo("\nRoute LLM calls through a ccs profile (vs plain `claude` login)?", true);
      runner = useCcs ? "ccs" : "claude";
      if (runner === "ccs") {
        ccsProfile = await chooseCcsProfile();
        if (ccsProfile === "") {
          runner = "claude";
          console.log("[run] No valid ccs profile — falling back to your plain `claude` login.");
        }
      }
    } else {
      runner = "claude";
      console.log("[run] `ccs` not found — using your plain `claude` login (--runner claude).");
    }
  }

  // ── Discover + list sessions ─────────────────────────────────────────────────
  line();
  console.log("Discovering sessions…\n");
  const all = await discoverSessions({});
  const { kept, excluded } = filterExcluded(all);
  if (excluded.length) {
    console.log(`(${excluded.length} session(s) opted out of analysis and are hidden.)\n`);
  }
  if (kept.length === 0) {
    console.error("[run] No analyzable sessions found under ~/.claude/projects. Nothing to do.");
    process.exit(0);
  }

  // Numbered table: #  project  short-id  started(date)  sizeKB
  const sizes = await Promise.all(
    kept.map(async (s) => {
      try {
        return (await stat(s.jsonlPath)).size;
      } catch {
        return 0;
      }
    })
  );
  kept.forEach((s: SessionInfo, i: number) => {
    const num = String(i + 1).padStart(3);
    const proj = s.project.slice(0, 28).padEnd(28);
    const shortId = s.sessionId.slice(0, 8);
    const started = (s.startedAt || "—").slice(0, 10).padEnd(10);
    const kb = (sizes[i] / 1024).toFixed(0).padStart(6);
    console.log(`${num}. ${proj}  ${shortId}  ${started}  ${kb} KB`);
  });
  console.log(`\nTotal: ${kept.length} session(s).\n`);

  // ── Selection ────────────────────────────────────────────────────────────────
  let chosenIds: string[] = []; // [] means "all" (no --sessions flag)
  while (true) {
    const sel = ask("Select sessions ('all', or e.g. 1,3,5-8)", "all").toLowerCase();
    if (sel === "all" || sel === "*") {
      chosenIds = [];
      console.log(`  → all ${kept.length} session(s).`);
      break;
    }
    const idxs = parseSelection(sel, kept.length);
    if (idxs.length === 0) {
      console.log("  (no valid entries — try e.g. 1,3,5-8 or 'all')");
      continue;
    }
    chosenIds = idxs.map((i) => kept[i - 1].sessionId);
    console.log(`  → ${idxs.length} session(s) selected.`);
    break;
  }

  // ── Run mode + options ────────────────────────────────────────────────────────
  line();
  let mode: "smoke" | "live";
  if (!hasClaude) {
    mode = "smoke";
    console.log("Run mode: structure smoke only (no `claude` CLI for the live judge).");
  } else {
    const m = ask("Run mode — [1] free structure smoke ($0)  [2] live judge run", "2");
    mode = m.trim() === "1" ? "smoke" : "live";
  }
  const live = mode === "live";

  let panel = false;
  let classifyLlm = false;
  let maxEpisodes = 0;
  if (live) {
    panel = askYesNo("Use the multi-judge panel (outcome+efficiency+quality, ~4× cost)?", false);
    classifyLlm = askYesNo("Use the LLM to resolve ambiguous turn boundaries?", false);
    const capRaw = ask("Cap judge calls this run (--max-episodes)? blank = no cap", "");
    const cap = Number(capRaw);
    if (capRaw && Number.isFinite(cap) && cap > 0) maxEpisodes = Math.floor(cap);
  }

  // ── Assemble pipeline flags ────────────────────────────────────────────────────
  const flags = ["--mine", "--yes"]; // wizard does its own confirm below → skip pipeline's gate
  if (chosenIds.length) flags.push("--sessions", chosenIds.join(","));
  if (runner === "claude") flags.push("--runner", "claude");
  else if (ccsProfile) flags.push("--ccs-profile", ccsProfile);
  if (!live) flags.push("--no-judge");
  if (live && panel) flags.push("--panel");
  if (live && classifyLlm) flags.push("--classify-llm");
  if (live && maxEpisodes) flags.push("--max-episodes", String(maxEpisodes));

  // ── Confirm ─────────────────────────────────────────────────────────────────
  line();
  console.log("Will run:\n  bun run pipeline.ts " + flags.join(" ") + "\n");
  if (live) {
    console.log(
      "Note: the judge makes ~1 metered `claude -p` call per uncached episode (≈3/session);\n" +
        "      the run is resumable — already-judged episodes are skipped. Use --max-episodes\n" +
        "      (above) to bound cost. out/report.md reflects the WHOLE judged corpus in\n" +
        "      analysis.db (cumulative), not only this run's picks — selection bounds cost.\n"
    );
  } else {
    console.log("This is the free $0 structure pass (no LLM calls); validated with `check` after.\n");
  }
  if (!askYesNo("Proceed?", true)) {
    console.log("Aborted — no changes made.");
    process.exit(0);
  }

  // ── Run the pipeline ──────────────────────────────────────────────────────────
  line();
  const code = await run(["bun", "run", "pipeline.ts", ...flags]);
  if (code !== 0) {
    console.error(`\n[run] pipeline exited ${code}. Stopping.`);
    process.exit(code);
  }

  // ── Smoke: validate; Live: surface outputs + offer draft ───────────────────────
  if (!live) {
    line();
    console.log("Validating DB structure (check)…\n");
    const chk = await run(["bun", "run", "src/check.ts"]);
    console.log(chk === 0 ? "\ncheck: PASS ✅" : "\ncheck: FAIL ❌ (see output above)");
    console.log("\nNext: re-run and choose [2] live judge to produce a report + candidates.");
    return;
  }

  line();
  const reportPath = "out/report.md";
  const candPath = "out/candidates.json";
  if (existsSync(reportPath)) console.log(`Report:     ${reportPath}`);
  if (existsSync(candPath)) console.log(`Candidates: ${candPath}`);

  // ── Draft (live only; needs candidates) ─────────────────────────────────────────
  if (existsSync(candPath) && askYesNo("\nDraft skills from the GO candidates now?", false)) {
    const topRaw = ask("How many top candidates? blank = all", "");
    const draftFlags = ["--yes"];
    const topN = Number(topRaw);
    if (topRaw && Number.isFinite(topN) && topN > 0) draftFlags.push("--top", String(Math.floor(topN)));
    line();
    const dcode = await run(["bun", "run", "src/skilldraft.ts", ...draftFlags]);
    if (dcode === 0) {
      console.log("\nSkill drafts → out/skill_drafts/<slug>/");
      console.log("Publish a skill by copying its <slug>/skill/ folder (audit/ stays internal).");
    } else {
      console.error(`\n[run] draft exited ${dcode}.`);
    }
  }

  line();
  console.log("Done.");
}

main().catch((e) => {
  console.error("[run] fatal:", e);
  process.exit(1);
});
