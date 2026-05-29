---
description: Process decided review findings into work items or spec updates; leave pending ones alone.
---

# Pending review findings

!`node .claude/scripts/review.js pending 2>&1`

# Full review state

!`node .claude/scripts/review.js list 2>&1`

# Instructions to the agent

You are running **review intake**. The human has decided on one or more findings. Your job is to interpret each decision into concrete action (a new work item, a spec update, or just dropping it) and resolve the finding.

## The rules

- **A finding is "decided" iff `review.js list` shows `Decision: <text>`.** That's the structured field. Don't guess from anywhere else.
- Pending findings (no Decision) → **leave alone**. Don't act on them.
- For each decided finding, interpret the decision text and act:
  - If the decision says **fix code** (e.g. "A", "fix it", "yes do the code change") → `worklist.js add` a concrete item, copying the human's specific guidance into the text. Then `review.js resolve <id>`.
  - If the decision says **update the spec** → edit `specs/<spec-name>.md` to reflect the change, AND add a follow-up work item if implementation is also needed. Then `review.js resolve <id>`.
  - If the decision says **both** (fix code AND update spec) → do both. Then resolve.
  - If the decision says **skip / not a real issue / drop it** → just `review.js resolve <id>`. No work item.
  - If the decision is **ambiguous** (you genuinely can't tell what they meant) → leave it (don't resolve), report it back to the user so they can clarify.

## Calling the scripts

For each decided finding (read the full record from `review.js list` to get spec, options, recommendation, decision):

```
node .claude/scripts/worklist.js add --spec <name> --text "<item, including human's guidance>"
node .claude/scripts/review.js resolve <finding-id>
```

If you edit a spec, commit it (`git add specs/<name>.md && git commit -m "spec: <change> (from <finding-id>)"`). Do not commit state files.

## What NOT to do

- Do not interpret a pending finding as decided. The status field is the gate.
- Do not generalize away the human's specific guidance ("only for tokens < 7d") — copy it verbatim into the work item text.
- Do not resolve a finding without first acting on it (or determining it's a skip).
- Do not edit `specd_review.json` directly. Always go through `review.js`.

## Output

Report:
- Findings processed (with their resolution: work item id / spec edit / skipped)
- Pending findings still waiting on the human
- "No decided findings — nothing to do" is a valid outcome
