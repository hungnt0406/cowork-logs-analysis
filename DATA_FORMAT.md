# Transcript data format — VERIFIED against the real logs

This is the ground-truth contract for parsing the raw `.jsonl` transcripts. It was
derived empirically from the corpus. Trust it; do not re-derive.

## Where the logs live
- Sessions: `~/.claude/projects/<encodedProjectDir>/<sessionId>.jsonl`
  - `<encodedProjectDir>` is the cwd with `/` → `-`, e.g.
    `-Users-hungcucu-Documents-usth-tennis-tracking-system`. The human-readable
    project name = last `-`-separated segment(s) / last path segment of `cwd`.
- Subagent forks: `~/.claude/projects/<encodedProjectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
  with a sibling `agent-<agentId>.meta.json` = `{ "agentType": "...", "description": "..." }`.
- Real top-level sessions per project (excluding subagents):
  usth-tennis-tracking-system=74, VinAI-A20-App-143=27, auto-skills=7, plus singletons.
  (`-Users-hungcucu-Documents` and the `local-agent-mode-sessions` / observer buckets
  are NOT real coding sessions — discover.ts excludes them.)

## Event model — one JSON object per line
Top-level `type` values seen: `user`, `assistant`, `system`, `pr-link`, `last-prompt`,
`mode`, `permission-mode`, `attachment`, `file-history-snapshot`, `ai-title`,
`queue-operation`.

Common fields: `uuid`, `parentUuid` (threading), `timestamp` (ISO), `sessionId`, `cwd`,
`gitBranch`, `isSidechain` (true ⇒ subagent fork), `isMeta` (true ⇒ harness-injected).

### `type: "user"`
`message.content` is EITHER a string OR an array of parts `{type, ...}`:
- text part: `{type:"text", text:"..."}`
- image part: `{type:"image", source:{type:"base64",...}}`
- tool result: `{type:"tool_result", tool_use_id, content}` — this is NOT a human turn.

A user event is also a tool result (not a human turn) when it has a top-level
`toolUseResult` field. `isMeta:true` user events (skill preambles) are not human turns.

**Human-turn predicate** (already implemented in `src/util.ts` → `isHumanTurn`):
`type:"user"` AND not `isMeta` AND no top-level `toolUseResult` AND no `tool_result`
content part AND has a non-empty text part OR ≥1 image part AND (if text) not starting
with `<` (slash/harness envelope). Mixed text+image IS a human turn. Image-only (no text)
IS a human turn but must be `continuation`, never an episode boundary.

Use `extractUserText(message)` and `countImages(message)` from `src/util.ts`.

### `type: "assistant"`
`message.content` is an array of `{type:"text", text}` and `{type:"tool_use", id, name, input}`.
`message.usage` = `{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ...}`.
The `Agent` tool_use has `input: {description, subagent_type, prompt}` and a top-level
`id` (the agent call). 101 Agent calls exist across the corpus.

Tool names seen include: Read, Edit, Write, Bash, Glob, Grep, Agent, TodoWrite, etc.
For Read/Edit/Write the file path is in `input.file_path` (sometimes `input.path`).
Bash command is in `input.command`.

### Tool results
A following `type:"user"` event with `toolUseResult` (or a `tool_result` content part)
carries the tool output. `toolUseResult` may be a string or an object; for Bash it can
contain `stdout`/`stderr`/`interrupted`. Use it to detect test pass/fail and interruptions.

### `type: "system"` — free signal events (`subtype`)
- `turn_duration` → `durationMs` (ms of one assistant turn)
- `api_error` → transient infra error (177 across corpus; weight WEAK / direction 0)
- `compact_boundary` → context overflow / compaction happened (rare: 2)
- `away_summary`, `local_command`, `stop_hook_summary`, `informational` — other.

### `type: "pr-link"` — strong positive signal (only ~16 in corpus)
`{ type:"pr-link", sessionId, prNumber, prUrl, prRepository, timestamp }`.

### Interruption marker
A human turn containing the literal `[Request interrupted by user]` ⇒ role `interruption`.

## Subagent linking
An assistant `Agent` tool_use (with `id`) spawns a fork. The fork's events have
`isSidechain:true` and an `agentId`. The fork transcript is the
`subagents/agent-<agentId>.jsonl` file. Join the parent Agent call to the fork by
matching on agentId where derivable; otherwise fall back to ordering / the meta.json
`description`. v1 only needs a COMPACT summary (agentType, description, tool count,
outcome) attached to the parent episode — not the full nested transcript.

## Tooling notes
- Runtime: Bun 1.3.14. Use `bun:sqlite`, `Bun.file`, `Bun.spawn`.
- `claude` CLI 2.1.175. `claude -p --output-format json` → JSON whose `.result` field
  holds the model's text answer. (`-p` is headless/serial.)
- macOS has NO `timeout` command — implement timeouts in TS (AbortController / Bun.spawn).
