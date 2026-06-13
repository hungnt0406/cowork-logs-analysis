# Turn-role disambiguation rubric

You classify ambiguous human turns in a Claude Code coding session into ONE role.
Heuristics already labeled the easy cases; you only see turns that were ambiguous
between **new_task**, **correction**, and **continuation**.

## Roles
- `new_task` — a fresh, self-contained request or question. It introduces a NEW goal,
  topic, or file that is not a follow-up on the work currently in progress.
- `correction` — pushes back on, fixes, or redirects the work the assistant is
  CURRENTLY doing (e.g. "no, use 640x368", "that's wrong, revert", "still failing").
  Stays on the same task.
- `continuation` — a low-content nudge that keeps the SAME task going
  ("continue", "now also do X on the same thing", a follow-up detail), not a new ask.

## How to decide
- If the turn references the same files/topic the assistant just touched, lean
  `correction` (if it objects/fixes) or `continuation` (if it just nudges forward).
- If the turn opens an unrelated goal after the prior task looked finished, lean `new_task`.
- A larger time gap + low topic overlap ⇒ `new_task`. Small gap + high overlap ⇒
  `correction`/`continuation`.

## Input
You are given, as JSON, the prior in-progress task summary and a list of candidate turns:
`{ "priorTask": "...", "turns": [ { "idx": 12, "text": "...", "gapSeconds": 30, "topicOverlap": 0.4 } ] }`

## Output
Return ONLY a JSON array, one object per input turn, no prose:
`[ { "idx": 12, "role": "correction" } ]`
Use exactly one of: new_task, correction, continuation.
