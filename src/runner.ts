// LLM runner selection — how the headless `claude -p` calls are routed.
//
// Two runners. BOTH spawn the SAME real `claude` binary, so stdout stays a clean
// JSON envelope. (`ccs <profile> -p …` is NOT a drop-in for `claude` — it wraps the
// CLI in a delegation UI that prints a box to stdout and rejects `--output-format
// json`, which would break JSON.parse. So we route via the profile's env instead.)
//
//   "ccs"    → inject the profile's env into the claude subprocess. We read
//              `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from `ccs env <profile>`
//              and merge them over process.env. Default profile: "my-api".
//   "claude" → plain claude with the ambient environment (the original behavior).
//
// configureRunner() is called once at pipeline startup; every Bun.spawn site
// (judge/classify/mine) merges runnerEnv() into its subprocess env. The default is
// "ccs" + "my-api" so an unconfigured caller still routes through the my-api profile.

export type RunnerName = "ccs" | "claude";

let _runner: RunnerName = "ccs";
let _ccsProfile = "my-api";

export function configureRunner(opts: { runner?: RunnerName; ccsProfile?: string }): void {
  if (opts.runner) _runner = opts.runner;
  if (opts.ccsProfile) _ccsProfile = opts.ccsProfile;
}

export function getRunnerName(): RunnerName {
  return _runner;
}

// Short label for logs / error messages (e.g. "ccs:my-api" or "claude").
export function describeRunner(): string {
  return _runner === "ccs" ? `ccs:${_ccsProfile}` : "claude";
}

// Parse the env-assignment lines emitted by `ccs env <profile>`, across shells —
// `ccs` formats its output for the host shell, so on Windows it is NOT bash syntax:
//   bash:        export KEY=VALUE   |  export KEY='VALUE'
//   PowerShell:  $env:KEY = 'VALUE' |  $env:KEY="VALUE"   (note spaces around `=`)
//   cmd:         set KEY=VALUE      |  set "KEY=VALUE"
//   plain:       KEY=VALUE
// Exported so the setup wizard (run.ts) can validate with the same logic the
// pipeline actually uses, instead of merely checking the exit code.
export function parseExports(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of out.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Strip the shell-specific assignment prefix, if any.
    line = line.replace(/^export\s+/, "").replace(/^set\s+/, "").replace(/^\$env:/, "");
    // cmd quotes the whole assignment: `set "KEY=VALUE"` -> `"KEY=VALUE"`.
    if (line.length >= 2 && line[0] === '"' && line.endsWith('"') && line.includes("=")) {
      line = line.slice(1, -1);
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let v = line.slice(eq + 1).trim();
    if (
      v.length >= 2 &&
      ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))
    ) {
      v = v.slice(1, -1);
    }
    env[key] = v;
  }
  return env;
}

// Shared headless `claude -p` call. The single place the non-judge call sites
// (classify / mine / sidecar) spawn the CLI, so runner env, timeout, and the JSON
// envelope unwrap live here rather than being copy-pasted. Returns the inner
// `.result` string (or raw stdout if no envelope); callers extract their own JSON
// array/object from it. Returns null on timeout / spawn / parse failure so every
// caller can fall back gracefully. NEVER throws.
// (The judge keeps its own spawn — it layers retry logic on top and is the cached
// critical path; consolidating it is a safe follow-up, not done here.)
export async function runClaudeText(
  prompt: string,
  opts?: { model?: string; timeoutMs?: number }
): Promise<string | null> {
  // Generous 600s (10 min) fallback ceiling so a real LLM call never trips it during an
  // e2e run (slow ccs-proxy calls land in ~130–200s); only a hung CLI hits it. Callers
  // that want a tighter bound pass timeoutMs explicitly.
  const timeoutMs = opts?.timeoutMs ?? 600000;
  const argv = ["claude", "-p", "--output-format", "json"];
  if (opts?.model) argv.splice(2, 0, "--model", opts.model);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const proc = Bun.spawn(argv, {
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
    return typeof envelope?.result === "string" ? envelope.result : out;
  } catch {
    clearTimeout(timer);
    return null; // never throw — caller falls back
  }
}

// Memoized: env overrides to merge into a `claude` spawn. {} for the plain runner.
// Resolved at most once per process (a Promise so concurrent callers share it).
let _envPromise: Promise<Record<string, string>> | null = null;
export function runnerEnv(): Promise<Record<string, string>> {
  if (_runner !== "ccs") return Promise.resolve({});
  if (_envPromise) return _envPromise;
  _envPromise = (async () => {
    const proc = Bun.spawn(["ccs", "env", _ccsProfile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `ccs env ${_ccsProfile} failed (exit ${code}): ${(err || out).slice(0, 200)}`
      );
    }
    const env = parseExports(out);
    if (!env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
      throw new Error(
        `ccs env ${_ccsProfile} returned no ANTHROPIC_* vars — is "${_ccsProfile}" a valid profile?`
      );
    }
    return env;
  })();
  return _envPromise;
}
