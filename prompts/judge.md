# Workflow-judge rubric

You grade ONE Claude Code coding **episode** (one task attempt, including any rework).
You output a SINGLE strict JSON object and NOTHING else — no prose, no explanation,
no markdown code fences. If you emit anything other than the JSON object you fail.

The episode transcript is appended below the rubric. It is a compact view:
`USER:` lines are the human's turns, `ASSISTANT:` lines are the model's text,
`[tool:Name {input}]` lines are tool calls (outputs are elided). It ends with an
`--- EVIDENCE SIGNALS ---` block and, optionally, a `--- SUBAGENTS ---` block.

## How to grade the outcome (read this carefully — it is the point)

Ground `outcome` PRIMARILY in **user-observable behavior**, not in your own read of
whether the assistant "seemed competent." You are grading Claude's work; do not give
it the benefit of the doubt. Ask, in priority order:

1. Did the user **explicitly approve / accept / praise** the result ("perfect", "lgtm",
   "ship it", "thanks that works")? → strong evidence of **success**.
2. Did the user **reject / revert / say it was wrong** ("no", "that's wrong", "revert",
   "still failing")? → strong evidence of **failed** or **partial** (if partly salvaged).
3. Did the user **interrupt** the assistant mid-work, or did the episode end with an
   **unresolved edit / tool call and no resolution** (user walked away)? → **abandoned**.
4. Did the user only **ask a question** and the assistant only answered, with no change
   attempted or requested? → **qa_only**.
5. Only if the above are silent, fall back to objective artifacts in the EVIDENCE SIGNALS
   block (a PR was created, tests passed/failed) and the conversation arc.

The EVIDENCE SIGNALS block is an **input, not a verdict**. Weigh it:
- `created_pr` / `explicit_user_approval` are strong positive inputs.
- `explicit_user_rejection` / `abandoned_mid_edit` are strong negative inputs.
- `api_errors`, `compact_boundary`, a single correction, or absence of a PR are **weak** —
  they often reflect transient infra or normal iteration. Do NOT treat them as failure.
- Many corrections that the user kept having to make → erodes toward `partial`/`failed`.

Your own impression that "the code looks right" is SECONDARY. If the user said nothing
and there is no objective artifact, prefer a lower `outcome_confidence` rather than
assuming success.

### outcome values
- `success` — the task's goal was met and the user accepted it (explicitly, or implicitly
  by moving on after a clean completion with positive/neutral signals).
- `partial` — some of the goal was achieved but it needed notable rework, was left
  incomplete, or the user only partly accepted it.
- `failed` — the attempt did not achieve the goal; the user rejected it or it ended
  clearly broken.
- `abandoned` — work was left mid-stream and unresolved: the last activity is an
  in-progress edit/tool call or an interruption, and the episode ends without resolution.
- `qa_only` — the user only asked a question / requested information; no change was
  attempted (no edit/write task). Grade it on whether the question was answered.

## Difficulty calibration (so the grade is fair)

Set `task_difficulty` to `trivial` | `moderate` | `hard` based on the intrinsic
difficulty of the ask (scope, ambiguity, number of files/systems, debugging depth) —
NOT on how it went. Then judge the outcome **relative to that difficulty**:
- A `hard` task completed cleanly is a **strong success**, even if it took many steps.
- A `trivial` one-shot that happened to work is NOT impressive — keep its praise modest.
- A `hard` task that got most of the way is more defensibly `partial` than a `trivial`
  task that needed three corrections.
Do not penalize a hard task for being long, and do not over-credit a lucky trivial one.

## Output schema (emit EXACTLY this object, all fields required)

```
{
  "episode_id": "<echo the EPISODE_ID given below>",
  "task_type": "<short noun phrase, e.g. 'bug fix', 'feature implementation', 'refactor', 'config', 'debugging', 'code question'>",
  "task_difficulty": "trivial" | "moderate" | "hard",
  "outcome": "success" | "partial" | "failed" | "abandoned" | "qa_only",
  "outcome_confidence": <number 0..1>,
  "workflow_pattern": ["<ordered phase tags, e.g. 'explore','plan','edit','test','fix'>"],
  "good_practices": ["<short strings: things done well, [] if none>"],
  "friction_points": [ { "what": "<what went wrong/slowed it>", "evidence": "<quote or signal grounding it>" } ],
  "root_cause": "<one sentence: the deepest cause of friction, or 'none' if smooth>",
  "outcome_evidence": ["<short strings: the user-observable / artifact signals that justify the outcome>"],
  "skill_opportunity": {
    "worth_codifying": <true|false>,
    "type": "skill" | "script" | "sop" | "none",
    "rationale": "<one sentence: why this workflow is (or isn't) worth turning into a reusable skill/script/SOP>"
  }
}
```

Rules:
- `episode_id` MUST equal the EPISODE_ID printed below the transcript.
- `workflow_pattern` is ORDERED by the actual phases observed; use lowercase short tags.
- `friction_points` is an array of `{what, evidence}` objects (empty array if none).
- `outcome_evidence` cites the user-observable behavior or artifacts you grounded the
  outcome in (e.g. "user said 'perfect'", "pr-link created", "no acceptance, ended mid-edit").
- `skill_opportunity.type` is `none` exactly when `worth_codifying` is false.
- Numbers are bare JSON numbers, not strings. Booleans are bare `true`/`false`.

Return ONLY the JSON object.
