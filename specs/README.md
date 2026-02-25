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

**tracks.md is loop-agent territory.** Only loop agents (running via `loop.sh`) read and write tracks.md. During the spec phase, we NEVER touch tracks.md — loop agents detect spec version bumps and add Remaining items themselves by comparing the spec changelog to the code.

**Future items:** Items marked with `(future)` are for reference only. Do not implement them — they belong to a later phase or another spec.

**Dependencies:** If a feature depends on another spec, check that spec's status. Only implement if the dependency is Ready or Implemented. Mark blocked features in Remaining with "(blocked: specname.md)".

**Versioning:** Specs use `v{major}.{minor}` versioning. Minor versions increment sequentially — v0.9 is followed by v0.10, not v1.0. Only increment the major version when explicitly instructed.

## Bug Fix Punch List

[`specs/bug-fix.md`](bug-fix.md) is a living punch list for cross-cutting code bugs and small fixes that don't warrant a spec version bump. Items are grouped by owning spec.

**Loop agents (implementation):** After selecting a spec to work on, check bug-fix.md for items under that spec's heading — they count as Remaining work. Fix one per iteration. Delete the item from the file after fixing and committing.

**Spec/planning agents (audit/review):** When auditing code or reviewing implementation, add newly discovered bugs to bug-fix.md under the appropriate spec heading. Use the same format as existing items. Items that can't be fixed yet should be marked `(blocked: reason)`.

Items use `(blocked: ...)` annotations — same convention as tracks.md. Skip blocked items; remove the annotation when the blocker resolves.

## Status Legend

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| Draft       | Being specified — not ready for implementation         |
| Ready       | Spec complete, ready for implementation                |
| Implemented | Fully implemented                                      |
| Deprecated  | Superseded by another spec — kept for legacy reference |

---

## Foundation

| Spec | Version | Status | Description |
|------|---------|--------|-------------|
| [example-spec](example-spec.md) | v0.1 | Draft | Example spec showing the format |

<!-- Add your foundation specs here -->

## Core

| Spec | Version | Status | Description |
|------|---------|--------|-------------|

<!-- Add your core feature specs here -->

## Future

| Spec | Version | Status | Description |
|------|---------|--------|-------------|

<!-- Add your future/planned specs here -->
