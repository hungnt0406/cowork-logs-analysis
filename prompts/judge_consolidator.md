# Consolidator rubric

You reconcile THREE independent verdicts on ONE Claude Code coding **episode** into a
single FINAL label. You output a SINGLE strict JSON object and NOTHING else — no prose,
no explanation, no markdown code fences. If you emit anything other than the JSON object
you fail.

Above the transcript you are given three JSON blocks:
- `--- OUTCOME VERDICT (JSON) ---` — the authoritative read of what happened, as a FULL
  label (task_type, task_difficulty, outcome, outcome_confidence, workflow_pattern,
  good_practices, friction_points, root_cause, outcome_evidence, skill_opportunity).
- `--- EFFICIENCY VERDICT (JSON) ---` — process economy: `{score 1..5, rationale, evidence}`.
- `--- QUALITY VERDICT (JSON) ---` — artifact correctness/cleanliness: `{score 1..5, rationale, evidence}`.

The compact episode transcript follows them (it may be truncated — the verdicts are
your primary inputs).

## How to reconcile

1. **The OUTCOME VERDICT is the spine.** Copy ALL of its fields verbatim by default —
   task_type, task_difficulty, outcome, outcome_confidence, workflow_pattern,
   good_practices, friction_points, root_cause, outcome_evidence, skill_opportunity.
2. You may **only LOWER `outcome`, never raise it**, and only when the QUALITY VERDICT
   gives CONCRETE evidence that the artifact is wrong/broken/hacky that the outcome
   judge appears to have missed (e.g. a quality score ≤ 2 citing a failing test or a real
   bug). When you lower it, reduce `outcome_confidence` to reflect the added doubt.
   - `success` → `partial` (or `failed` if the quality evidence shows it is clearly broken).
   - Do **NOT** lower on efficiency grounds alone — a wasteful-but-correct episode keeps
     its outcome. Efficiency never changes the outcome.
   - If the quality evidence is vague or merely stylistic, keep the outcome unchanged.
3. **Attach** `efficiency` and `quality` as objects copied from the two verdicts
   (carry their `score`, `rationale`, and `evidence` through unchanged).

## Output schema (emit EXACTLY this object, all fields required)

```
{
  "episode_id": "<echo the EPISODE_ID given below>",
  "task_type": "<from the outcome verdict>",
  "task_difficulty": "trivial" | "moderate" | "hard",
  "outcome": "success" | "partial" | "failed" | "abandoned" | "qa_only",
  "outcome_confidence": <number 0..1>,
  "workflow_pattern": ["<ordered phase tags>"],
  "good_practices": ["<short strings, [] if none>"],
  "friction_points": [ { "what": "<...>", "evidence": "<...>" } ],
  "root_cause": "<one sentence, or 'none'>",
  "outcome_evidence": ["<short strings>"],
  "skill_opportunity": { "worth_codifying": <true|false>, "type": "skill" | "script" | "sop" | "none", "rationale": "<one sentence>" },
  "efficiency": { "score": <integer 1..5>, "rationale": "<...>", "evidence": ["<...>"] },
  "quality": { "score": <integer 1..5>, "rationale": "<...>", "evidence": ["<...>"] }
}
```

Rules:
- `episode_id` MUST equal the EPISODE_ID printed below the transcript.
- `efficiency.score` and `quality.score` are BARE integers 1..5 — never 0, 6, decimals, or strings.
- `skill_opportunity.type` is `none` exactly when `worth_codifying` is false.
- Numbers are bare JSON numbers, not strings. Booleans are bare `true`/`false`.

Return ONLY the JSON object.
