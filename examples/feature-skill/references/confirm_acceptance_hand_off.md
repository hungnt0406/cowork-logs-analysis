# Confirm acceptance & hand off

Present a concise summary: what you built, which files changed, and the verification evidence (typecheck, tests, smoke run). Ask the user to confirm it meets the acceptance criteria. Treat commits, pushes, PRs, and deploys as gated — perform them only when the user explicitly asks in this conversation.

## How to do it

1. Summarize the change, files touched, and how it was verified.
2. Map the result back to each acceptance criterion.
3. Ask the user to confirm acceptance.
4. Only when the user asks, create the commit/branch/PR or deploy.
5. If interrupted, leave a clear note on what is verified and what remains.

## Examples

- **✅ Good:** After explore→edit→test passed, committed only once the user asked to commit.
- **❌ Bad:** The episode ended with the user interrupting during final output-video validation and no acceptance was ever recorded.
- _Note: Make acceptance explicit; don't assume an interrupt means approval._

- **✅ Good:** Investigated a claimed lingering commit trailer, found it was a dangling object and main was already clean, and reported that.
- **❌ Bad:** Asserted state about history without verifying it.
- _Note: Verify repo state before claiming anything about it._

## Edge cases

- User interrupts before sign-off
- Partial acceptance — some criteria met, others deferred

## Common mistakes

- Committing, pushing, or opening a PR without being asked
- Assuming silence equals acceptance
- Reporting completion without the verification evidence

## Inputs needed

- verification results
- the change summary / diff

## When to ask the user

Ask the user to confirm the feature meets the acceptance criteria, and ask before any outward-facing action (commit, push, PR, deploy).

## Error handling

If the session is interrupted before acceptance, make the verification state explicit and ask for sign-off rather than assuming the feature was accepted.

## Checklist

- [ ] Change + verification summarized
- [ ] Acceptance explicitly confirmed
- [ ] Outward actions only on explicit user request
