# {PROJECT_NAME} Specifications

> {One-line project description}

## How specs work in this project

Specs are **steering documents** — they define WHAT to build and WHY, not HOW. They are
also **executable contracts**: each `### Behavior N` block contains a runnable test that
the audit phase actually executes against the code.

## Workflow

1. **Plan** (`/specd:plan <spec-name>` in a Claude session) — draft or update a spec, then
   approve a decomposition. Items only enter the worklist on explicit approval.
2. **Loop** (`specd loop start`) — the orchestrator drains the worklist one item at a time,
   each in a fresh `claude --bg` session.
3. **Audit** (automatic when the queue drains) — `specs.js test` runs every behavior's Test
   against the implementation; failing behaviors are queued back as fixes.
4. **Review intake** (`/specd:review-intake` if there are pending findings) — process your
   decisions into work items or spec edits.

The loop exits cleanly only when **the worklist is empty AND every spec's tests pass**.

## Strict spec format

Every spec file under `specs/` must conform to this format. `specs.js validate <name>`
rejects malformed specs; `worklist.js add` refuses to queue items for specs that don't
structurally validate (when `SPECD_REQUIRE_SPEC_FILE=1`).

```
# <spec-name>

## Overview
<one paragraph: user, feature, why>

## Specification

### Behavior 1 — <short title>

**Description:** <one sentence — WHAT, not HOW; ≤ 280 chars>

**Test:**
- run: `<shell command>`
- stdin: <optional>
- stdout: `<exact>`               or stdout_contains: `<substring>`
- stderr: `<exact>`               or stderr_contains: `<substring>`
- exit: <integer>

**Example:** <optional human-readable I/O>

### Behavior 2 — ...

## Constraints (optional)
- <how-level: language, libraries, patterns>
```

See [example-spec.md](example-spec.md) for a complete worked example.

## What changed in 0.2.0

- The Draft/Ready/Implemented status flag is **gone**. Items only exist in the worklist
  when you've approved them — presence IS the approval gate.
- Markdown worklist (`specd_work_list.md`) was replaced by **structured JSON owned by
  `worklist.js`** with stable ids, atomic writes, dependency validation, and an attempts
  cap on failed items.
- Implement is no longer a slash command — the **orchestrator** owns the loop.
- Audit is now mechanical: `specs.js test` runs the Test field from each behavior.

## Index

| Spec | Description |
|------|-------------|
| [example-spec](example-spec.md) | Annotated example (delete after drafting real specs) |

<!-- Add your specs here. specd does NOT require any particular categorization; group however helps you read them. -->
