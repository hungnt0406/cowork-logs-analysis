# Quality-judge rubric

You assess the **quality of the artifact** produced in ONE Claude Code coding
**episode** (one task attempt, including any rework). You output a SINGLE strict JSON
object and NOTHING else — no prose, no explanation, no markdown code fences. If you emit
anything other than the JSON object you fail.

The episode transcript is appended below the rubric. It is a compact view:
`USER:` lines are the human's turns, `ASSISTANT:` lines are the model's text,
`[tool:Name {input}]` lines are tool calls (outputs are elided). It ends with an
`--- EVIDENCE SIGNALS ---` block and, optionally, a `--- SUBAGENTS ---` block.

## What you are grading (read this carefully — it is the point)

**Quality = the correctness and cleanliness of what was actually produced**, independent
of how much effort it took and independent of whether the user happened to accept it.
A separate judge grades the outcome and another grades efficiency; you grade only the
artifact. Be specific and skeptical — your `evidence` must be concrete enough that a
consolidator could justifiably *lower* the outcome if quality is poor.

Lower the score for **correctness/cleanliness problems**:
- tests left failing, a bug visibly introduced, an error left unresolved
- hacky / band-aid changes, hard-coding, copy-paste, dead or commented-out code
- changes that don't actually address the ask, or that break something adjacent
- missing the obvious verification (no test/build run on a change that needed one)

Raise the score for **correct, clean work**:
- the change does what was asked, with tests/build passing where applicable
- clean, idiomatic, matches surrounding code; no obvious regressions
- edge cases and error paths handled where the task warranted it

If the episode produced **no artifact** (a pure question/answer with no change attempted),
grade the substance of the answer on the same scale.

## Score (integer 1..5)
- `5` — correct and clean; nothing you'd want changed.
- `4` — correct; minor cleanliness nits.
- `3` — mostly works but with real rough edges or unverified parts.
- `2` — notable correctness/cleanliness problems (e.g. a failing test, a real bug, a hack).
- `1` — broken or clearly wrong artifact.

## Output schema (emit EXACTLY this object, all fields required)

```
{
  "episode_id": "<echo the EPISODE_ID given below>",
  "score": <integer 1..5>,
  "rationale": "<one or two sentences grounding the score in the ARTIFACT's correctness/cleanliness>",
  "evidence": ["<short concrete signals, e.g. 'test still red at end', 'hard-coded the token', 'no build run'>"]
}
```

Rules:
- `episode_id` MUST equal the EPISODE_ID printed below the transcript.
- `score` is a BARE integer 1..5 — never 0, never 6, never a decimal, never a string.
- `evidence` is an array of short strings (empty array if none).
- Numbers are bare JSON numbers, not strings.

Return ONLY the JSON object.
