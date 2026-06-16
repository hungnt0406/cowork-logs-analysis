---
name: "feature"
description: "Use when implementing a new feature end to end — adding an endpoint, UI element, or capability — so it lands tested, conventional, and verified rather than half-explored."
license: "MIT"
metadata:
  version: "0.1.0"
  auto_generated: true
  domain: "software-engineering"
  role: "implementer"
  triggers:
    - "new feature"
    - "add endpoint"
    - "implement"
    - "build feature"
    - "add capability"
    - "wire up"
  privacy_rules_version: "1"
---

# feature

## When to use
Reach for this when the user asks you to build, add, or wire up new functionality: a new endpoint or route, a UI control, a model or config option, or a new capability in an existing service. It covers the full arc from clarifying scope through a verified, reviewed edit. Use it whenever the deliverable is working code rather than a one-line tweak or a pure investigation.

## Quick checklist
- [ ] Confirm scope and acceptance criteria before coding
- [ ] Grep the whole repo for every call site and implementer
- [ ] Keep a minimal plan, then actually land the edit
- [ ] Update all parallel sites and maps consistently
- [ ] Typecheck and run the tests
- [ ] Smoke-run the new code path before claiming done
- [ ] Self-review the diff (and any subagent output) against acceptance criteria
- [ ] Ask for sign-off; commit or PR only when the user requests it

## Workflow
| # | Step | What it does | Reference |
| --- | --- | --- | --- |
| 1 | Clarify scope & acceptance criteria | Pin down what 'done' means and resolve ambiguity before touching code. | `references/clarify_scope_acceptance_criteria.md` |
| 2 | Explore & map impact | Find every call site, implementer, and config the feature touches. | `references/explore_map_impact.md` |
| 3 | Plan the change | Sketch the minimal edit set and test plan — then move to implementation, don't stall. | `references/plan_the_change.md` |
| 4 | Implement incrementally | Make the edit following conventions; wire every parallel site consistently. | `references/implement_incrementally.md` |
| 5 | Test & verify (exercise the new path) | Typecheck, run/extend tests, and actually execute the new code path end to end. | `references/test_verify_exercise_the_new_path.md` |
| 6 | Self-review & integrate | Re-read the diff against acceptance criteria and reconcile any delegated work. | `references/self_review_integrate.md` |
| 7 | Confirm acceptance & hand off | Summarize what changed and how it was verified, then get sign-off before any outward action. | `references/confirm_acceptance_hand_off.md` |

_Each step has full how-to, inputs, and error handling in its `references/` file._

## Constraints

**MUST DO**
- Confirm scope and acceptance criteria before writing code
- Map every call site and implementer of the touched contract before editing
- Exercise the new code path with a real smoke test before claiming done
- Match existing conventions and keep the diff small and reviewable

**MUST NOT**
- Do not stop at exploration or planning — land a working, tested edit
- Do not declare the work complete before the new path has actually run
- Do not blindly trust a subagent's output — verify it against the plan
- Do not commit, push, open a PR, or deploy unless the user explicitly asks

## Safety
Only commit, push, open or merge PRs, deploy/publish, or rewrite git history when the user explicitly asks for it in the current conversation. Default to local, reversible edits and report what changed; never run these outward-facing actions as an automatic step.

## Errors & handling
- **Session stops at exploration or planning without landing an implementation** → Timebox discovery and planning; cut to the smallest shippable slice and produce a working, tested edit. The task isn't done until the new path runs.
- **Declared complete before the new code path was exercised** → Always smoke-run the path you just wrote before reporting done; bugs in environment, version, and output size only appear when it actually executes.
- **Missed a second implementer or call site of the changed contract** → Grep the whole repo including sibling services and tests, enumerate all implementers, and run the type-checker to confirm the call-site map is complete.
- _…6 more in `references/failure-modes.md`._

See `references/failure-modes.md` for the full list.

## Reference guide
| Reference | Read when |
| --- | --- |
| `references/clarify_scope_acceptance_criteria.md` | Clarify scope & acceptance criteria — Pin down what 'done' means and resolve ambiguity before touching code. |
| `references/explore_map_impact.md` | Explore & map impact — Find every call site, implementer, and config the feature touches. |
| `references/plan_the_change.md` | Plan the change — Sketch the minimal edit set and test plan — then move to implementation, don't stall. |
| `references/implement_incrementally.md` | Implement incrementally — Make the edit following conventions; wire every parallel site consistently. |
| `references/test_verify_exercise_the_new_path.md` | Test & verify (exercise the new path) — Typecheck, run/extend tests, and actually execute the new code path end to end. |
| `references/self_review_integrate.md` | Self-review & integrate — Re-read the diff against acceptance criteria and reconcile any delegated work. |
| `references/confirm_acceptance_hand_off.md` | Confirm acceptance & hand off — Summarize what changed and how it was verified, then get sign-off before any outward action. |
| `references/success-patterns.md` | Recommended workflow, examples, and rationale |
| `references/failure-modes.md` | Common failure modes and how to handle them |
