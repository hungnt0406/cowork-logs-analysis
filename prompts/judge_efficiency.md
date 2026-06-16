# Efficiency-judge rubric

You assess the **process economy** of ONE Claude Code coding **episode** (one task
attempt, including any rework). You output a SINGLE strict JSON object and NOTHING
else — no prose, no explanation, no markdown code fences. If you emit anything other
than the JSON object you fail.

The episode transcript is appended below the rubric. It is a compact view:
`USER:` lines are the human's turns, `ASSISTANT:` lines are the model's text,
`[tool:Name {input}]` lines are tool calls (outputs are elided). It ends with an
`--- EVIDENCE SIGNALS ---` block and, optionally, a `--- SUBAGENTS ---` block.

## What you are grading (read this carefully — it is the point)

**Efficiency = how economically the work was carried out, INDEPENDENT of whether the
final result was correct.** A separate judge grades the outcome; you do NOT. Grade only
the *path* the assistant took to get there. A correct answer reached via heavy thrash is
LOW efficiency; a wrong answer reached by a clean, direct path is still HIGH efficiency.

Lower the score for **wasted motion**:
- tool thrash — re-reading the same file repeatedly, redundant searches
- repeated failed edits, retry loops, flailing on the same spot
- long idle gaps, re-exploring context the assistant already had
- needless re-runs of tests/builds, backtracking, undo-redo churn

Raise the score for a **direct path**:
- reads only what's needed, edits, verifies, done
- minimal wasted tool calls; corrections (if any) converge quickly
- no obvious re-derivation of already-known facts

Judge efficiency **relative to intrinsic difficulty**: a hard task legitimately needs
many steps — do not penalize length that the task required, only motion that was wasted.

## Score (integer 1..5)
- `5` — near-optimal path; almost no wasted motion.
- `4` — efficient; minor detours.
- `3` — average; some redundant work but it kept progressing.
- `2` — notably wasteful: thrash, repeated retries, backtracking.
- `1` — severe churn; most of the effort was wasted motion.

## Output schema (emit EXACTLY this object, all fields required)

```
{
  "episode_id": "<echo the EPISODE_ID given below>",
  "score": <integer 1..5>,
  "rationale": "<one or two sentences grounding the score in the PROCESS, not the outcome>",
  "evidence": ["<short concrete signals, e.g. 'read config.ts 4×', 'edit reverted twice', '90s idle'>"]
}
```

Rules:
- `episode_id` MUST equal the EPISODE_ID printed below the transcript.
- `score` is a BARE integer 1..5 — never 0, never 6, never a decimal, never a string.
- `evidence` is an array of short strings (empty array if none).
- Numbers are bare JSON numbers, not strings.

Return ONLY the JSON object.
