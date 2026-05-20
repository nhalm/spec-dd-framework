PROJECT.md

## Spec Authority

**Specs are prescriptive, not descriptive.** The spec defines what code MUST do.

- **Spec is source of truth.** If code contradicts the spec, the code is wrong — refactor it.
- **Always read the full spec before implementing a work item.** The spec is the source of truth; don't rely on memory of a previous read.
- **Don't build on broken foundations.** If existing code uses the wrong model (e.g., wrong ID scheme, wrong data flow), fix it first. Don't add new features on top of incorrect code.
- **Spec index:** `specs/README.md` lists all specifications organized by phase. Only specs with status "Ready" should be implemented.

## Audit Discipline

**Zero findings is a valid outcome.** An audit that confirms correctness is successful — do not manufacture findings to justify the work.

**The bar for a finding is: will this cause a bug in production?** Not "could this theoretically be a problem under unlikely conditions" — will it actually break?

Before reporting a finding:
- **Read the actual code, not just the spec.** Findings based on spec text alone are unreliable. The code is the ground truth — if the code is correct, there is no finding.
- **Check if it's actually reachable.** Trace the code path. If it requires multiple unlikely conditions to trigger, and existing safety nets (timeouts, cost ceilings, human abort) bound the impact, it's not a finding.
- **Check if the spec section is prescriptive.** "Notes", "Resolved questions", and "Design decisions" sections are commentary, not requirements. Don't flag unimplemented commentary.
- **Check if behavior is handled by LLM choice.** If the spec describes behavior that the LLM naturally produces via its tool set and prompt (e.g., choosing not to orchestrate for simple tasks), the absence of a dedicated code path is not a gap.
- **Don't flag missing safety nets when other safety nets exist.** A missing timeout is low-priority when cost ceilings and human abort are available.

## Loop System

The autonomous loop is defined in `loop.sh`. Commands live in `.claude/commands/`:

| Command          | Purpose                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `/specd:implement`     | Pick one unblocked work item, implement it, validate, record completion        |
| `/specd:audit`         | 3-phase spec-vs-code audit. Writes findings to specd_work_list.md and specd_review.md |
| `/specd:review-intake` | Process specd_review.md items into specd_work_list.md                                 |
| `/specd:full-audit`    | Like audit but covers Ready AND Implemented specs — demotes Implemented specs with findings |

## specd_work_list.md (Remaining Work)

The single execution queue for all work — spec implementations, audit findings, and promoted review items. **Read it in full** at the start of each iteration — it is kept small. Pick an unblocked item, implement it, then remove it from the list.

## specd_review.md (Human Decisions)

Ambiguous findings from audits that need human judgment. Items sit here until the human reviews them. On next loop start, `/specd:review-intake` promotes remaining items to specd_work_list.md (human deletes items they disagree with before restarting).
