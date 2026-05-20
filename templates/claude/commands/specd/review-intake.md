Study AGENTS.md for guidelines.

Your task is to process specd_review.md — convert decided items into work items or spec updates, then clear them from specd_review.md.

## Process

1. Read specd_review.md. If the file is empty or doesn't exist, output `REVIEW_INTAKE_COMPLETE: true` and stop.
2. For each finding in specd_review.md, determine if the human has made a decision:
   - **No decision** → skip, leave it in specd_review.md for the human to review
   - **Has a decision** → process it (see below)

## Detecting decisions

The human may write their decision in many ways. Be forgiving about formatting:

- Inline after `**Decision:**` (e.g., `**Decision:** A`)
- On the next line below `**Decision:**`
- With extra blank lines between the label and the answer
- Without the `**Decision:**` label at all — just text added below the last field
- With typos in the label (`**Desision:**`, `Decision:` without bold, `**decision:**` lowercase)
- As a bullet point, blockquote, or plain text

A finding is **undecided** only if there is genuinely no human-written text after the recommendation/options section. If there's any text that looks like an answer — even informally placed — treat it as a decision.
3. After processing all decided items, remove them from specd_review.md. Leave undecided items in place.
4. Output `REVIEW_INTAKE_COMPLETE: true` when done.

## Processing a decision

Read the full finding (Finding, Code, Spec, Options, Recommendation) and the Decision together. The decision may be:

- **A letter referencing an option** (e.g., `A`) → read the matching lettered option and act on it
- **A letter with clarification** (e.g., `A, but only for tokens less than 7 days old`) → use the option as a base, incorporate the clarification
- **Freeform text** (e.g., `skip`, `not a real issue`, `fix the code but use 403 instead`) → interpret the intent directly

Based on the decision:

- If the decision says to **fix code** → create a work item in specd_work_list.md. Include the human's specific guidance in the work item description.
- If the decision says to **update the spec** → update the spec, then add a work item to specd_work_list.md under the `## spec-name` section.
- If the decision says to **skip or ignore** → drop the finding, no work item needed.
- If the decision says to **do both** (fix code AND update spec) → do both.

## Committing

After processing all findings, commit all changed spec files and `specs/README.md` together in a single commit. Do not commit `specd_work_list.md` or `specd_review.md`.

## Rules

- Each work item must be a small, single unit of work — one agent can complete it in one iteration
- If a work item depends on another, add `(blocked: dependency description)` at the end
- Use the exact specd_work_list.md format: section headers are `## spec-name`, items are `- description`
- Preserve the human's specific guidance from the Decision field in the work item — don't generalize it away
- Do NOT implement anything — only populate specd_work_list.md and update specs
