# {PROJECT_NAME} Specifications

> {One-line project description}

## How Specs Work

Specs are **steering documents** — they define WHAT to build and WHY, not HOW to implement.

**Workflow:**

1. **Spec phase** — We work through a spec until it's right
2. **Loop phase** — `loop.sh` runs agents that implement the spec

**Agents have autonomy** on implementation. The spec steers direction, the agent decides the code.

**Status transitions.** Humans move specs from Draft → Ready. The `/specd:audit` command manages Ready ↔ Implemented transitions — promoting clean specs to Implemented, demoting specs with new findings back to Ready.

**Future items:** Items marked with `(future)` are for reference only. Do not implement them — they belong to a later phase or another spec.

**Dependencies:** If a feature depends on another spec, check that spec's status. Only implement if the dependency is Ready or Implemented. Mark blocked features with "(blocked: specname)".

**Cross-references:** When referencing another spec in the body (Out of scope, Dependencies, inline text), use a real markdown link with the correct relative path.

**Work items** live in [specd_work_list.md](../specd_work_list.md). The `/specd:audit` command generates work items directly in specd_work_list.md based on gaps between specs and code. Humans and planning agents can also write directly to specd_work_list.md during spec phase.

## Status Legend

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| Draft       | Being specified — not ready for implementation         |
| Ready       | Spec complete, ready for implementation                |
| Implemented | Fully implemented                                      |
| Deprecated  | Superseded by another spec — kept for legacy reference |

---

## Foundation

| Spec | Status | Description |
|------|--------|-------------|
| [example-spec](example-spec.md) | Draft | Example spec showing the format |

<!-- Add your foundation specs here -->

## Core

| Spec | Status | Description |
|------|--------|-------------|

<!-- Add your core feature specs here -->

## Future

| Spec | Status | Description |
|------|--------|-------------|

<!-- Add your future/planned specs here -->
