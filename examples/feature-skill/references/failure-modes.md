# Failure modes & handling — feature

## Failure modes and how to handle them

**Stalling before the edit.** The most common failure shape was an episode that explored (or explored→planned) and never produced an edit. Handle by timeboxing discovery, cutting scope to the smallest shippable slice, and committing to start editing.

**Premature 'complete'.** Declaring done before the new path ran (e.g. a grad-clip path never exercised) forced the user to ask for verification. Handle by always smoke-running the path you just wrote; make the run part of 'done'.

**Incomplete impact map.** A second service implementing the same protocol was patched only after mypy errored. Handle by grepping broadly across sibling services and tests and using the type-checker as a completeness check before claiming the change is wired.

**Delegation drift.** A subagent silently replaced the plan's court-center formula. Handle by diffing any delegated output against the plan's contract and re-verifying — never trust unread.

**Wrong targets and API misuse.** Wrong nav routing, a missing import, a declaration ordered after use, a removed library function under a new major version — all single-iteration fixes catchable with typecheck plus a diff re-read.

**Environment and scope drift.** Installing deps into the base env then the project env, or drifting into an unrelated GPU-capability problem after the feature was done. Handle by fixing the environment up front and explicitly separating unrelated issues from the feature change.

**No acceptance recorded.** An episode ended on a user interrupt during final validation with no sign-off. Handle by stating the verification status explicitly and asking for acceptance rather than assuming it.

## Errors & handling
### Session stops at exploration or planning without landing an implementation
Timebox discovery and planning; cut to the smallest shippable slice and produce a working, tested edit. The task isn't done until the new path runs.

### Declared complete before the new code path was exercised
Always smoke-run the path you just wrote before reporting done; bugs in environment, version, and output size only appear when it actually executes.

### Missed a second implementer or call site of the changed contract
Grep the whole repo including sibling services and tests, enumerate all implementers, and run the type-checker to confirm the call-site map is complete.

### Missing import or wrong library API/version (e.g. React.ReactNode without import; np.trapz removed in NumPy 2.x)
Typecheck after edits and run the path; when a major version shifts an API, confirm the current signature and adapt.

### Declaration ordering bug (global/closure declared after first use)
Declare before first use; rely on the type-checker/linter and re-read the diff to catch silent failures.

### Subagent silently deviated from the plan (changed a formula or target)
Diff delegated output against the plan's contract and acceptance criteria; correct to the plan and re-verify rather than trusting it.

### Wrong routing/navigation target
Check each route/nav destination against the spec; confirm with a quick run and fix on the user's correction.

### Environment churn or hardware mismatch (deps into base vs project env; GPU capability below toolchain)
Establish the correct environment up front; treat unrelated env/hardware failures as separate from the feature — note them and keep the feature change focused.

### Structural test instead of a functional one
Add a test that exercises the real behavior (e.g. a round-trip) rather than only asserting a component is referenced.
