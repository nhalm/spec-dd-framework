Study AGENTS.md for guidelines.
Study specs/README.md to find all specs and their statuses.

Your task is to audit ALL specs (Ready and Implemented) against code, then write findings to the appropriate files.

## Scope

Audit every spec with status **Ready** or **Implemented**. Skip Draft and Deprecated specs.

## What counts as a finding

Only flag things that are **functionally wrong** — broken behavior, missing features, incorrect data, wrong types at system boundaries. The bar is high:

- Code produces wrong results or crashes → finding
- A spec-required feature is missing entirely → finding
- Types are wrong at API boundaries causing runtime errors → finding
- Code works correctly but uses a different pattern than the spec suggests → NOT a finding
- Spec wording doesn't perfectly match implementation details → NOT a finding
- Cosmetic differences (naming, formatting, ordering) → NOT a finding
- Documentation gaps in the spec → NOT a finding

## Process

Work through each spec sequentially. For each spec:

### Step 1: Gather

Launch a research agent (model: Sonnet) to audit the spec against code. The agent:

1. Reads the spec body (Overview, Specification sections)
2. Reads the code that implements it
3. Reports findings: broken behavior, missing features, incorrect data handling. **Zero findings is a valid outcome.**

The agent applies the "what counts as a finding" bar above and the Audit Discipline guidelines in AGENTS.md. It does NOT write or modify any files.

### Step 2: Validate

When the agent returns findings, **you validate each one yourself**:

1. Read the actual code for each finding — confirm or reject the claim against the source
2. Cross-check against specd_work_list.md to avoid duplicates
3. For each finding, answer: "Is the code actually broken or producing wrong results?" If no, reject the finding.
4. Categorize each confirmed finding:
   - **Code is broken / produces wrong results** → specd_work_list.md item
   - **Spec needs to prescribe new behavior** → spec update candidate
   - **Ambiguous, needs human** → specd_review.md item
   - **Already known / in progress / duplicate** → skip
   - **Code works fine, just different from spec wording** → skip (do NOT flag)

Validation is critical. Agent research is frequently wrong about exact field names, line numbers, parameter types, and other details. Verify every finding against actual code before writing.

### Step 3: Write

Write confirmed findings for this spec before moving to the next one.

## Writing findings

### specd_work_list.md

Add concrete, actionable work items under `## spec-name` section headers. Each item must be a small, single unit of work. Add `(blocked: ...)` for items with dependencies.

### Spec updates

When the spec needs to prescribe genuinely new or changed behavior (NOT documentation fixes):

1. Update the spec body with the corrected content
2. Add corresponding work items to specd_work_list.md under the `## spec-name` section

### specd_review.md

For ambiguous findings where it's unclear whether code or spec is wrong:

```markdown
## spec-name

**Finding:** Description of the mismatch
**Code:** What the code does (file path, line)
**Spec:** What the spec says
**Options:**
- A: First option
- B: Second option
**Recommendation:** What you think should happen
**Decision:**
```

Letter the options so the human can respond with just a letter, a letter plus clarification, or freeform text. Always leave `**Decision:**` blank — the human fills it in.

### Spec status transitions

After processing each spec:

- **Ready spec with NO findings** → Update status to "Implemented" in both the spec file and specs/README.md
- **Implemented spec with findings** → Update status to "Ready" in both the spec file and specs/README.md, add work items to specd_work_list.md
- **Ready spec with findings** → Status stays Ready (findings are in specd_work_list.md)

## Committing

After writing findings for each spec, commit all changed spec files and `specs/README.md` together in a single commit.

**Do NOT commit `specd_work_list.md` or `specd_review.md`.** These are uncommitted working files — they must never be staged or included in any commit.

## Output

After completing all specs, report a summary:

- Number of findings per spec
- Items added to specd_work_list.md
- Items added to specd_review.md
- Status transitions made

Output `AUDIT_COMPLETE: true` when done.
Output `AUDIT_CLEAN: true` if no new items were added to specd_work_list.md (audit found nothing or only specd_review.md items).
