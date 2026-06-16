# Test & verify (exercise the new path)

Run the type-checker and the test suite, add a functional test that exercises the real behavior (not just a structural assertion that a component is referenced), and smoke-run the feature end to end. Many real bugs — environment/version drift, output-size mismatches — only appear when the path actually runs. Use the correct project environment from the start.

## How to do it

1. Run the type-checker; fix what it flags.
2. Run the existing test suite to catch regressions.
3. Add a functional test that drives the new behavior, not just a reference check.
4. Smoke-run the feature end to end in the correct environment.
5. Confirm outputs match the acceptance criteria (sizes, values, side effects).

## Examples

- **✅ Good:** During smoke verification caught np.trapz removed in NumPy 2.x and fixed it; caught an output-size bug (96x160 vs 90x160) and corrected both models.
- **❌ Bad:** Declared a grad-clip change complete before the new code path had ever run, so the user had to prompt for a smoke test.
- _Note: Running the path is what surfaces version and output bugs._

- **✅ Good:** Caught and corrected its own incorrect test invocation rather than reporting a false failure.
- **❌ Bad:** Covered core round-trip logic only with a structural test asserting the component is referenced.
- _Note: Prefer a functional round-trip test over a structural reference check._

## Edge cases

- Structural test that asserts wiring but not behavior
- Environment churn — deps installed into base vs the project env
- Hardware/runtime mismatch (e.g. GPU capability below the toolchain minimum) unrelated to the feature

## Common mistakes

- Claiming done before the new path runs
- Structural-only tests masquerading as coverage
- Installing dependencies into the wrong environment

## Inputs needed

- test command and typecheck command
- a way to run the new path (CLI, route, UI action)

## When to ask the user

If you genuinely can't run the new path locally, ask the user to confirm the environment or run the smoke check, rather than declaring done.

## When to search the web

Search when a test failure points to a library behavior change (e.g. a removed function in a new major version) you need to confirm.

## Error handling

The observed trap is declaring the change complete before the new path has been exercised, forcing the user to ask for verification. Always run it. Treat unrelated environment failures (GPU capability, wrong conda env) as separate from the feature — note them, don't let them derail acceptance.

## Script

`scripts/verify.sh` — Gate completion on typecheck + tests + an explicit smoke-run of the new path.

## Checklist

- [ ] Typecheck clean
- [ ] Tests pass, including a new functional test
- [ ] New path smoke-run and outputs verified
