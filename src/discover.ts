// discover.ts — enumerate REAL top-level Claude Code coding sessions.
// Excludes nested subagent forks, the bare -Users-hungcucu-Documents bucket,
// and the local-agent-mode / observer buckets (not real coding sessions).
import { homedir } from "os";
import { join, basename } from "path";
import { readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import type { SessionInfo, RawEvent } from "./types.ts";
import { readEvents } from "./util.ts";

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

// Project-dir buckets that are NOT real coding sessions.
function isExcludedBucket(projectDir: string): boolean {
  // bare Documents bucket (no project segment)
  if (projectDir === "-Users-hungcucu-Documents") return true;
  // observer / local-agent-mode / agent-mode sessions
  const lower = projectDir.toLowerCase();
  if (lower.includes("local-agent-mode-sessions")) return true;
  if (lower.includes("agent-mode")) return true;
  if (lower.includes("observer")) return true;
  // the analyzer's own project — its sessions are meta-work (building this miner),
  // not coding workflows worth mining; excluding avoids self-referential noise.
  if (lower.includes("cowork-logs-analysis")) return true;
  return false;
}

// Decode an encoded project dir name into a best-effort cwd path.
// (Only used as a fallback; the real cwd comes from the first event.)
function decodeProjectDir(projectDir: string): string {
  // "-Users-hungcucu-Documents-usth-tennis-tracking-system" -> "/Users/..."
  return projectDir.replace(/-/g, "/");
}

// Human-readable project name = last path segment of the (decoded) cwd.
function projectNameFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const seg = basename(trimmed);
  return seg || trimmed || "unknown";
}

// Pull cwd + first/last timestamps from a session's events.
function sessionTimespan(events: RawEvent[]): {
  cwd: string;
  startedAt: string;
  completedAt: string;
} {
  let cwd = "";
  const tsList: string[] = [];
  for (const ev of events) {
    if (!cwd && typeof ev.cwd === "string" && ev.cwd) cwd = ev.cwd;
    if (typeof ev.timestamp === "string" && ev.timestamp) tsList.push(ev.timestamp);
  }
  return {
    cwd,
    startedAt: tsList.length ? tsList[0] : "",
    completedAt: tsList.length ? tsList[tsList.length - 1] : "",
  };
}

export async function discoverSessions(opts?: {
  project?: string;
  since?: string;
  limit?: number;
  sessions?: string[]; // allowlist: keep only sessions matching an entry by full id or prefix
}): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let projectDirs: string[] = [];
  try {
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    if (isExcludedBucket(projectDir)) continue;
    const dirPath = join(PROJECTS_ROOT, projectDir);

    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      // Only top-level <sessionId>.jsonl files; subagent forks live under
      // <sessionId>/subagents/ and are never directly enumerated here.
      if (!file.endsWith(".jsonl")) continue;
      const jsonlPath = join(dirPath, file);

      // Defensive: skip if this path is somehow nested under a subagents dir.
      if (jsonlPath.includes(`${"/subagents/"}`)) continue;

      let st;
      try {
        st = await stat(jsonlPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const sessionId = file.slice(0, -".jsonl".length);

      let events: RawEvent[];
      try {
        events = await readEvents(jsonlPath);
      } catch {
        continue;
      }
      if (events.length === 0) continue;

      const { cwd: cwdFromEvents, startedAt, completedAt } = sessionTimespan(events);
      const cwd = cwdFromEvents || decodeProjectDir(projectDir);
      const project = projectNameFromCwd(cwd);

      // sibling <sessionId>/subagents dir, if present
      const subDir = join(dirPath, sessionId, "subagents");
      const subagentsDir = existsSync(subDir) ? subDir : null;

      sessions.push({
        sessionId,
        project,
        projectDir,
        cwd,
        jsonlPath,
        subagentsDir,
        startedAt,
        completedAt,
      });
    }
  }

  // Filters
  let result = sessions;
  if (opts?.project) {
    const needle = opts.project.toLowerCase();
    result = result.filter((s) => s.project.toLowerCase().includes(needle));
  }
  if (opts?.since) {
    const since = opts.since;
    result = result.filter((s) => s.completedAt && s.completedAt >= since);
  }
  // Explicit session allowlist (e.g. from the interactive wizard's per-session picks).
  // Match by full sessionId OR prefix so short 8-char ids work too.
  if (opts?.sessions?.length) {
    const want = opts.sessions;
    result = result.filter((s) => want.some((id) => s.sessionId === id || s.sessionId.startsWith(id)));
  }

  // Sort by startedAt ascending (empty timestamps sort first/stable).
  result.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  if (opts?.limit !== undefined && opts.limit >= 0) {
    result = result.slice(0, opts.limit);
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: { project?: string; since?: string; limit?: number } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") opts.project = args[++i];
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--limit") opts.limit = Number(args[++i]);
  }

  const sessions = await discoverSessions(opts);
  for (const s of sessions) {
    let size = 0;
    try {
      size = (await stat(s.jsonlPath)).size;
    } catch {
      /* ignore */
    }
    const sizeKb = (size / 1024).toFixed(0).padStart(7);
    const shortId = s.sessionId.slice(0, 8);
    const proj = s.project.slice(0, 30).padEnd(30);
    const started = (s.startedAt || "—").slice(0, 19).padEnd(19);
    console.log(`${proj}  ${shortId}  ${started}  ${sizeKb} KB`);
  }
  console.log(`\nTotal: ${sessions.length} sessions`);
}
