Study AGENTS.md for guidelines.
Read specd_work_list.md in full — it contains all remaining work items.

Your task is to implement ONE work item from specd_work_list.md, then validate it works.

## Step 0: Check for work

After reading specd_work_list.md, check if there are any unblocked items (lines that do NOT contain the string `(blocked:`). If the file is empty or every item contains `(blocked:`, there is nothing to do — output `LOOP_COMPLETE: true` and stop.

## Step 1: Pick a work item

- Pick an unblocked item from specd_work_list.md — an item is unblocked if and only if its line does NOT contain the string `(blocked:`.

## Step 2: Read the relevant spec

- The section header above the work item tells you which spec it belongs to (e.g. `## auth` means read the auth spec)
- Read ONLY that spec — do not read other specs. The work item is a summary; the spec has the detail.
- Specs are the source of truth, not existing code
- Only implement work items for specs with status "Ready"

## Step 3: Implement

- **Implement ONLY the picked work item — nothing else.** The spec provides context, not a todo list. If the spec describes 5 endpoints but the work item says "Create User model", you create the model and stop. Other work items exist for the other pieces.
- If code contradicts the spec, fix the code first (see AGENTS.md)
- Do NOT use TodoWrite — just do the work

## Step 4: Validate

<!-- Customize: add your project's validation steps here -->
- Run the project's test suite to catch errors
- If there are linting or formatting errors fix them even if they aren't in a file you modified

## Step 5: Record

Update tracking files, then commit:

1. Remove the completed item from specd_work_list.md.
2. Check specd_work_list.md for items with `(blocked: ...)` annotations that reference the work you just completed. If the blocker is resolved, remove the `(blocked: ...)` annotation.
3. Commit code and test changes. Do not commit `specd_work_list.md` or `specd_review.md`.
   Output `TASK_COMPLETE: true` when done.

Before declaring LOOP_COMPLETE, re-read specd_work_list.md and list every remaining
item. For each item, check: does the line contain `(blocked:`? If ANY item does
NOT contain `(blocked:`, you are NOT done — pick one and implement it.

Output `LOOP_COMPLETE: true` only if every remaining item in specd_work_list.md
contains `(blocked:` on its line, or the file is empty.
