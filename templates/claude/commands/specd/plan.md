---
description: Draft or update a spec, decompose it into work items, and queue them only when the user approves.
argument-hint: [spec-name]
---

# Existing specs

!`node .claude/scripts/specs.js list 2>&1`

# Existing items for this spec (if any)

!`if [ -n "$1" ]; then node .claude/scripts/worklist.js list --spec "$1" 2>&1; else echo "(no spec name passed; we will discuss what to plan)"; fi`

# Instructions to the agent

You are running the **plan** phase of the spec-driven loop. The system has a strict spec format and deterministic validators that gate every step. Trust the validators; they are the spec for what "good" means.

## Spec format (strict — enforced by `specs.js validate`)

```
# <spec-name>

## Overview
<one paragraph: user, feature, why>

## Specification

### Behavior 1 — <short title>

**Description:** <one sentence — WHAT, not HOW; ≤ 280 chars>

**Test:**
- run: \`<shell command>\`
- stdin: <optional input>
- stdout: \`<exact match>\` OR stdout_contains: \`<substring>\`
- stderr: \`<exact>\` OR stderr_contains: \`<substring>\`
- exit: <integer>

**Example:** <optional human-readable I/O>

### Behavior 2 — ...
### Behavior 3 — ...

## Constraints (optional)
<language, libraries, patterns — HOW only>
```

## Workflow

1. **Understand.** Ask clarifying questions until the feature, user, and edge cases are clear. Do not write anything yet.

2. **Draft the spec.** Create or update `specs/<spec-name>.md` using the format above. Behaviors must be discrete and individually testable.

3. **Validate structurally:**
   `node .claude/scripts/specs.js validate <spec-name>`
   - If errors: fix them and run again. Do not proceed until validate exits 0.

4. **Validate content (LLM-as-judge):**
   `node .claude/scripts/specs.js review <spec-name>`
   - This dispatches a fresh reviewer agent with a fixed rubric. If verdict is `needs_revision`, show the issues to the user, fix, and re-run. Do not proceed until verdict is `pass`.

5. **Propose decomposition.** In your reply, list the work items you'd queue (text only, no script calls yet). Each item should target one behavior or a foundational step. Format: `[N] <text> (blocked-by: ...)`.

6. **Iterate with the user.** Adjust items, ordering, granularity.

7. **On explicit approval** — only then — call `worklist.js add` for each item, in dependency order:
   ```
   node .claude/scripts/worklist.js add --spec <spec-name> --text "<task>" [--blocked-by id,id]
   ```
   Print each returned id back to the user.

## Hard rules

- Do NOT call `worklist.js add` until the user explicitly approves the decomposition.
- Do NOT proceed past steps 3 or 4 with a failing validator/reviewer.
- Do NOT edit `specd_work_list.json` or `specd_review.json` directly.
- Do NOT bypass the validator by writing "TODO: add Test" in a behavior. Every behavior must have a runnable test, or it's not a behavior in this spec — it's an item for a later spec.

## Why this is strict

The Test field on each behavior makes audit deterministic: `specs.js test <name>` literally runs each Test and reports pass/fail per behavior. That replaces fuzzy "does the code match the spec" with executable contract enforcement. Skimping on Test fields hollows out the whole loop.
