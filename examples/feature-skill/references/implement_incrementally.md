# Implement incrementally

Edit in small steps, keeping the code in a buildable state. Update all parallel maps/implementers together, keep imports correct, and put declarations (e.g. globals) before first use. Add the small guards real usage needs (drag-vs-click, persistence) and bake in deterministic defaults where reproducibility matters. If you delegate part of the build to a subagent, hand it the exact contract so it can't drift.

## How to do it

1. Edit the primary site, keeping the build green.
2. Apply the same change to every parallel site/implementer you mapped.
3. Fix imports and declaration order as you go (declare before use).
4. Add guards/persistence/defaults the real usage requires.
5. If delegating, give the subagent the exact contract and acceptance criteria.

## Examples

- **✅ Good:** Added an onClick guard to distinguish a drag from a click, plus localStorage persistence for the choice.
- **❌ Bad:** Used React.ReactNode without importing React; placed a `global ARMS` declaration after its first use, causing a silent failure.
- _Note: Small correctness details (imports, declaration order) cause most one-iteration fixes._

- **✅ Good:** Wired the new model into color, display, and load maps in the same chronological order.
- **❌ Bad:** Updated one map and routed Billing/Credits nav to the wrong destination.
- _Note: Consistency across sibling sites and correct routing targets matter._

## Edge cases

- Global/closure declarations that must precede first use
- Several parallel maps that must update together
- Routing/nav targets that look plausible but point at the wrong page

## Common mistakes

- Editing one site but not its siblings
- Introducing API/import misuse the type-checker would catch
- Letting a subagent improvise instead of giving it the contract

## Inputs needed

- the plan and impact map
- project conventions (style, file layout, lint rules)

## When to search the web

Search for the correct API only if you hit an unfamiliar or version-shifted library surface during the edit.

## Error handling

Typical bugs here are a missing import, a declaration ordered after first use, or a wrong routing/nav target. Typecheck after each meaningful edit and re-read your own diff before moving on.

## Checklist

- [ ] All mapped sites edited consistently
- [ ] Imports and declaration order correct
- [ ] Required guards/defaults added
