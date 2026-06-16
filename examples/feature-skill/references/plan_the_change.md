# Plan the change

List the files to touch, the order to touch them in, where the new behavior plugs into existing flow, and the one test that will prove it works. Prefer the smallest reversible change. Timebox this: planning is a means, not the deliverable — sessions that stop at 'plan' are a recognized failure for this task type.

## How to do it

1. Write the ordered list of files/edits and where the new behavior attaches.
2. Decide the single functional test that proves the feature works.
3. Identify parallel sites that must change together for consistency.
4. Pick the smallest reversible slice and commit to starting it now.

## Examples

- **✅ Good:** Planned to add the new model to the color, display, and load maps in chronological order, consistently.
- **❌ Bad:** Produced a detailed plan and ended the session without any edit.
- _Note: The plan's value is realized only when the edit lands._

- **✅ Good:** For a multi-part ML pipeline change, noted the downstream consequences in the plan so they were explained upfront.
- **❌ Bad:** Left downstream effects implicit, forcing follow-up why-questions later.
- _Note: Surface ripple effects in the plan, not after._

## Edge cases

- Large multi-part requests that tempt over-planning
- Changes whose downstream effects need explaining before they're accepted

## Common mistakes

- Over-planning and never editing
- Treating the plan as completion
- Planning each site but missing one parallel structure

## Inputs needed

- the impact map from exploration
- acceptance criteria from scope

## Error handling

A plan with no execution is itself a failure mode. If the plan keeps growing, cut scope to the smallest shippable slice and start editing; refine as you go.

## Checklist

- [ ] Ordered edit list written
- [ ] Functional test chosen
- [ ] Scope cut to smallest shippable slice
