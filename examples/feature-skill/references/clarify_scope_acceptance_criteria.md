# Clarify scope & acceptance criteria

Read the request closely and name the acceptance criteria you'll verify against. Look for contradictions — a title that disagrees with the plan, an undefined term, an unclear target. Ask one or two targeted questions only when the answer changes what you build; otherwise state your assumption explicitly and proceed. Decide the test strategy now so 'done' is testable, not vibes.

## How to do it

1. Restate the request in one sentence and list explicit acceptance criteria.
2. Scan for contradictions between title, description, and any linked plan.
3. Identify the 1-2 decisions that actually change the implementation.
4. Ask those questions, or record assumptions if no answer is available.
5. Note how each acceptance criterion will be verified (test or smoke check).

## Examples

- **✅ Good:** Asked 'which model should this support?' before building, then wired exactly that one.
- **❌ Bad:** Assumed 'render this table in visual mode' meant format a table in the reply, when it referred to an editor feature.
- _Note: Clarify only the decision-changing ambiguity; don't interrogate the user over trivia._

- **✅ Good:** Flagged a title (ball-only) vs plan (4-component system) mismatch and proceeded on the stated plan while calling it out.
- **❌ Bad:** Silently picked one interpretation and built it.
- _Note: When you can't resolve it, surface it instead of guessing._

## Edge cases

- Title/description disagrees with an attached plan
- Multi-part requests where downstream consequences need explaining upfront
- Requests that quietly imply scope beyond the headline

## Common mistakes

- Guessing the design instead of asking the one question that matters
- Over-clarifying trivial details and stalling
- Leaving 'done' undefined so completion is unverifiable

## Inputs needed

- the feature request or ticket
- related existing code or docs
- any stated design constraints or acceptance criteria

## When to ask the user

Ask a targeted question when the request is genuinely ambiguous (which variant/model, where the control lives, what counts as done) and the answer changes the build. For trivia, state your assumption and move on.

## When to search the web

Search when the feature leans on an external API, library capability, or spec you're unsure of — confirm the contract before designing around it.

## Error handling

Unresolved ambiguity leads to building the wrong thing. If you can't get an answer, write down the assumption you're proceeding on and flag the unresolved point in your summary rather than guessing silently.

## Checklist

- [ ] Acceptance criteria written down
- [ ] Ambiguities resolved or assumptions recorded
- [ ] Test/verification strategy chosen
