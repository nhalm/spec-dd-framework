---
description: Run each spec's tests against code; queue failing behaviors as work items, ambiguous findings as review decisions.
argument-hint: [spec-name]
---

# Specs available

!`node .claude/scripts/specs.js list 2>&1`

# Currently active items

!`node .claude/scripts/worklist.js list 2>&1`

# Pending review findings

!`node .claude/scripts/review.js pending 2>&1 | head -20`

# Instructions to the agent

You are running the **audit** phase. With strict-format specs, most audit work is mechanical: `specs.js test` literally runs each Behavior's test against the code and tells you exactly which behaviors fail.

## Workflow

### Step 1 — run the deterministic tests

If a spec name was passed as `$1`, audit only it. Otherwise audit every spec in `specs/`.

For each spec:
```
node .claude/scripts/specs.js test <spec-name>
```

This emits a structured JSON result with `{ allPass, results: [{ behavior, title, pass, reason }] }`.

**For each failing behavior:** add a work item. The reason string already tells you exactly what's wrong (e.g. "stdout mismatch (got X, expected Y)" or "exit 0 ≠ expected 1"). Use it:
```
node .claude/scripts/worklist.js add --spec <spec> --text "Fix behavior <N> (<title>): <reason from test failure>"
```

Print each returned id back to the user.

### Step 2 — only THEN consider non-mechanical findings

After all behavioral tests are run, ask yourself: is there anything else that's functionally wrong that the tests don't catch?

The bar is HIGH. Most things you'd want to flag are either:
- **A test that doesn't exist yet for an existing behavior** → that's a spec edit (add a Behavior), not an audit finding. Propose it to the user.
- **Cosmetic / naming / pattern preference** → NOT a finding.
- **"The spec could be more detailed"** → NOT a finding. Specs say WHAT; lack of detail is the spec saying "any way that passes the test is fine."

Only flag a non-mechanical finding if:
- The code does something genuinely broken that the test doesn't catch (the test is wrong or incomplete).
- The spec and code disagree on something the test doesn't verify (data shape at an API boundary, side effect, etc.).

For ambiguous non-mechanical findings (the spec might be wrong, or it's a tradeoff the human should decide):
```
node .claude/scripts/review.js add \
  --spec <spec> \
  --finding "<one-line summary>" \
  --code "<file:line — what the code does>" \
  --spec-says "<what the spec says>" \
  --option "A: <option>" --option "B: <option>" \
  --recommendation "<your suggestion>"
```

## Hard rules

- Do NOT commit. Audit doesn't write code; it writes findings/items.
- Do NOT edit specs (the spec might be wrong is a review finding, not an audit edit).
- Do NOT flag what's already in the worklist (`list` is shown above; don't duplicate).
- Do NOT skip running `specs.js test`. The tests are the source of truth for "does the code match the spec."
- "No findings" is a valid and valuable outcome.

## Output

At the end, report:
- Specs audited (and their `specs.js test` pass/fail counts)
- Work items added (with ids)
- Review findings added (with ids)
- "No findings" if the audit was clean

## Why this is mechanical

The Test field on each Behavior in the strict spec format means audit doesn't need to interpret prose — it runs the test. A failing test is a finding. A passing test is "spec satisfied." This collapses most of audit from LLM judgment into deterministic shell exit codes.
