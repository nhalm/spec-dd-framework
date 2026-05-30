PROJECT.md

## Spec authority

**Specs are prescriptive, not descriptive.** The spec defines what code MUST do.

- **Spec is source of truth.** If code contradicts the spec, the code is wrong — refactor it.
- **Always read the full spec before implementing a work item.** Items are summaries; the spec has the detail.
- **Don't build on broken foundations.** If existing code uses the wrong model (e.g., wrong ID scheme, wrong data flow), fix it first.
- **No spec status flag.** Specs are "active" if items reference them in the worklist. Presence in the worklist = approval to implement.

## Strict spec format

Every spec under `specs/` must validate against the strict format below — `specs.js validate <name>` enforces it, and `worklist.js add` refuses items whose spec doesn't validate (when `SPECD_REQUIRE_SPEC_FILE=1`).

```
# <spec-name>

## Overview
<one paragraph — user, feature, why>

## Specification

### Behavior 1 — <short title>

**Description:** <one sentence; WHAT, not HOW; ≤ 280 chars>

**Test:**
- run: `<shell command>`
- stdin: <optional>
- stdout: `<exact>`               or stdout_contains: `<substring>`
- stderr: `<exact>`               or stderr_contains: `<substring>`
- exit: <integer>

**Example:** <optional>

### Behavior 2 — ...

## Constraints (optional)
- <how-level rules: language, libraries, patterns>
```

Each behavior's **Test** is a runnable shell contract. The audit phase executes them with `specs.js test <name>` and queues failures as work items. There is no separate "is the code right?" judgment — the test is the contract.

## Audit discipline

The audit phase is **mechanical first, judgment second**:

1. `specs.js test <spec>` runs every Behavior's Test. Failing behaviors → `worklist.js add` with the structured failure reason.
2. **Only then** consider non-mechanical findings. The bar is high: the code does something genuinely broken that the test doesn't catch, OR the spec and code disagree on something the test doesn't verify.

**Zero findings is a valid outcome.** Manufacturing findings to justify audit work is worse than reporting clean.

Before reporting a non-mechanical finding:
- **Read the actual code**, not just the spec. The code is the ground truth.
- **Check if it's actually reachable.** Trace the code path.
- **Check if the spec section is prescriptive.** Notes / Resolved-questions / Design-decisions sections are commentary, not requirements.
- **Don't flag missing safety nets when other safety nets exist.**

## Loop system

The autonomous loop is `specd loop` — a Node orchestrator that:

1. Picks one item from `specd_work_list.json` via deterministic code.
2. Dispatches a fresh `claude --bg` session with the item inlined.
3. Parses a nonce-verified verdict from the session's JSONL transcript.
4. Calls `worklist.js done`/`fail` based on the structured outcome.
5. After the queue drains, runs `specs.js test` on every spec in parallel; failing behaviors queue as fixes.
6. Exits only when the worklist is empty AND every spec's tests pass.

| Command | Purpose |
| --- | --- |
| `/specd:plan <name>` | Draft/update a spec, decompose into items, queue on approval |
| `/specd:audit [name]` | Run `specs.js test`; queue failures; surface ambiguous findings to review.js |
| `/specd:review-intake` | Process decided review findings into work items |
| `/specd:loop` | Launch the orchestrator from inside a Claude Code session (status/monitoring helpers) |
| `specd loop start` | Same orchestrator, launched from the terminal |

## State files (gitignored)

| File | What it holds |
| --- | --- |
| `specd_work_list.json` | Work items: `{id, spec, text, blocked_by, attempts, in_progress}` |
| `specd_review.json` | Findings awaiting human decision: `{id, spec, finding, decision, status}` |
| `.specd-approvals/<name>.json` | HMAC-signed approval markers — spec passed `specs.js review` |
| `.specd-loop.{pid,log,status.json}` | Orchestrator process state |
| `specd_loop_events.jsonl` | Per-item cost + token log (one line per dispatch) |

All of these are owned by the scripts under `.claude/scripts/`. **Do not edit them by hand.**

## Determinism principle

The control flow — what runs next, what cleared, what's "done", when to stop — is plain
Node code. The LLM does only the inherently fuzzy work: writing code, decomposing specs,
judging spec quality, interpreting a human's review decision.

This split keeps the bookkeeping reliable at scale. Reliability degrades multiplicatively
with the number of LLM-driven steps; pulling them out of the model is what lets the loop
process dozens of items unattended.
