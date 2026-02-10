# {PROJECT_NAME} Specifications

> {One-line project description}

## How Specs Work

Specs are **steering documents** — they define WHAT to build and WHY, not HOW to implement.

**Workflow:**
1. **Spec phase** — We work through a spec until it's right
2. **Loop phase** — `loop.sh` runs agents that implement the spec
3. **Tracks** — [tracks.md](../tracks.md) tracks Implemented vs Remaining for each spec

**Agents have autonomy** on implementation. The spec steers direction, the agent decides the code.

**Status is human-controlled.** Agents NEVER change spec status. Only humans move specs between states (Draft → Ready → Implemented).

**tracks.md:** Tracks what's Implemented vs Remaining for each spec. See instructions in that file.

**Future items:** Items marked with `(future)` are for reference only. Do not implement them — they belong to a later phase or another spec.

**Dependencies:** If a feature depends on another spec, check that spec's status. Only implement if the dependency is Ready or Implemented. Mark blocked features in Remaining with "(blocked: specname.md)".

## Status Legend

| Status | Meaning |
|--------|---------|
| Draft | Being specified — not ready for implementation |
| Ready | Spec complete, ready for implementation |
| Implemented | Fully implemented |

---

## Phase 0: Foundation

| Spec | Status | Description |
|------|--------|-------------|
| [example-spec](example-spec.md) | Draft | Example spec showing the format |

<!-- Add your foundation specs here -->

## Phase 1: Core

| Spec | Status | Description |
|------|--------|-------------|

<!-- Add your core feature specs here -->

## Phase 2: Future

| Spec | Status | Description |
|------|--------|-------------|

<!-- Add your future/planned specs here -->
