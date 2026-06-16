# Explore & map impact

Grep for the symbol, route, protocol, or config key across the whole repo — including tests and sibling services — before editing anything. When you change a contract or interface, enumerate every implementer; don't assume the first one is the only one. Note the surrounding conventions (naming, file layout, how similar features are wired) so your edit fits in.

## How to do it

1. Grep broadly for the symbol/route/protocol across all languages and tests.
2. List every implementer of the interface you're changing, not just the obvious one.
3. Locate the parallel structures (color/display/load maps, route tables) that must stay in sync.
4. Read one nearby similar feature to absorb conventions.
5. Run the type-checker to surface call sites your grep missed.

## Examples

- **✅ Good:** Grepped the protocol and found a second service (llm_xiaomi.py) implementing generate_json, then updated both.
- **❌ Bad:** Mapped only the first implementer; the second surfaced reactively when mypy errored.
- _Note: Let the type-checker confirm your call-site map is complete._

- **✅ Good:** Found all three maps (color, display, load) that index models and noted them before editing.
- **❌ Bad:** Edited one map and left the siblings stale.
- _Note: Parallel maps drift silently — enumerate them up front._

## Edge cases

- Multiple services implementing the same protocol
- Generated or vendored code that also references the symbol
- Dynamic dispatch / string-keyed lookups that hide call sites from grep

## Common mistakes

- Exploring and then stopping without ever editing (the top failure mode)
- Trusting the first search hit as the only site
- Skipping the type-checker as a completeness check

## Inputs needed

- the contract/interface/route/symbol being changed
- repo layout and where similar features live

## Error handling

Incomplete mapping shows up as a second implementer patched reactively after the type-checker flags it. Re-grep more broadly, search sibling services explicitly, and run the type-checker early to enumerate what you missed.

## Script

`scripts/find-callsites.sh` — Enumerate definitions, implementers, and references of a symbol before editing it.

## Checklist

- [ ] All call sites and implementers listed
- [ ] Parallel maps/tables identified
- [ ] Conventions of a similar feature noted
