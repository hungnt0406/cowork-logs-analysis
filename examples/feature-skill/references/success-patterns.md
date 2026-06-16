# Success patterns — feature

## Recommended workflow
Start by pinning down what 'done' means: read the request, surface any ambiguity (a title that disagrees with the plan, an undefined term, an unclear target), and ask one or two targeted questions only when the answer changes what you build — otherwise state your assumption and proceed. Next, explore the codebase and map every site the change touches: grep for the symbol, route, or protocol across the whole repo including tests and sibling services, and let the type-checker enumerate implementers you might have missed. Then sketch a minimal, reversible plan — the files to touch, the order, where the new behavior plugs in, and the test you'll add — but do not stop at the plan; the most common failure for this task type is a session that explores or plans and never lands an edit. Implement incrementally, following existing conventions, updating all parallel sites consistently (every map, every implementer) and keeping imports and declaration order correct. Verify by actually running the new code path: typecheck, run or extend tests with a functional (not merely structural) assertion, and smoke-run end to end — never declare the work complete before the path you just wrote has executed. Self-review the diff against the acceptance criteria, and if any part was delegated to a subagent, diff its output against the plan rather than trusting it. Finally, summarize what changed and how it was verified and ask for sign-off; only when the user explicitly asks do you commit, push, open a PR, or deploy.

## What worked
Across the observed feature episodes (about 68% judged successful), the winning shape was explore→edit→test, frequently extended with fix→verify or fix→document. The episodes that stalled were the ones that stopped at exploration or planning without ever editing. Successful runs frequently asked a clarifying question before building when scope was ambiguous, mapped all call sites before editing, and caught real bugs during a smoke/verify pass rather than after handing off.

## What separated the smooth feature runs

**Clarify before building.** The strongest single lever was a targeted clarifying question up front — e.g. confirming *which* model to add, or flagging a title-vs-plan mismatch — instead of guessing the design. One question that changes the build is worth it; ten that don't are friction.

**Map all the sites first.** Features that touched a contract went wrong when only the first implementer was found. Grepping the protocol and letting the type-checker enumerate implementers (catching a second `generate_json` service) is what kept changes consistent. The same applies to parallel maps — color/display/load tables updated together, in the same order.

**Verify by running, not by asserting wiring.** The bugs that mattered surfaced during a real smoke run: a removed `np.trapz` under NumPy 2.x, an output-size mismatch (96x160 vs 90x160) fixed in both models, a mislabeled CSV column caught by querying the data directly. A structural test that only asserts a component is *referenced* gives false confidence; a functional round-trip test does not.

**Small correctness details dominate the fix iterations.** Missing a `React` import, ordering a `global` after first use, routing a nav item to the wrong page — each cost one fix cycle and each is catchable by typecheck + a careful diff re-read.

**Rationale.** Feature work fails at the seams: an unmapped call site, an unexercised path, a delegated edit that drifted. Front-loading scope and call-site mapping, and back-loading a real smoke run, closes those seams.
