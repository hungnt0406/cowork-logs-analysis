# Self-review & integrate

Read your full diff as if reviewing someone else's PR: does each acceptance criterion hold, are all sibling sites consistent, did anything drift out of scope? If a subagent produced part of the change, diff its output against the plan — subagents can silently deviate from an agreed formula or target. Tidy up environment churn and stray edits before handing off.

## How to do it

1. Read the diff end to end against each acceptance criterion.
2. Diff any subagent-produced code against the plan's contract.
3. Confirm parallel sites are all consistent.
4. Remove scope drift and environment cruft introduced during the work.
5. Re-run verify.sh if you changed anything.

## Examples

- **✅ Good:** Caught and corrected mislabeled visibility picks by querying the CSV directly to confirm ground truth.
- **❌ Bad:** A subagent silently replaced the plan's court-center formula with a different derivation that went unnoticed until review.
- _Note: Verify delegated work against the plan; don't assume it followed instructions._

- **✅ Good:** Kept the feature edit focused and split off an unrelated GPU/environment problem.
- **❌ Bad:** Let the episode drift into an unrelated GPU issue after the feature was done.
- _Note: Guard scope at review time._

## Edge cases

- Subagent output that looks plausible but diverges from the plan
- Unrelated issues surfacing mid-task that tempt scope creep

## Common mistakes

- Trusting subagent output unread
- Letting unrelated problems expand the change
- Skipping a re-verify after review fixes

## Inputs needed

- the working diff
- acceptance criteria
- the plan (to compare subagent output against)

## Error handling

If a subagent deviated (changed a formula, picked the wrong target), correct it to the plan and re-verify. If you discover the implementation drifted into an unrelated issue, split it out rather than smuggling it into this feature.

## Checklist

- [ ] Diff reviewed against every acceptance criterion
- [ ] Subagent output reconciled to the plan
- [ ] Scope kept tight; re-verified after fixes
