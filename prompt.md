Study AGENTS.md for guidelines.
Study specs/README.md to find specs with status "Ready".
Study tracks.md - it has instructions and tracks what's Implemented vs Remaining.

Your task is to implement ONE item from a "Remaining" list, then validate it works.

IMPORTANT:

- Read AGENTS.md first — specs are the source of truth, not existing code
- Only implement specs with status "Ready"
- NEVER change spec status in specs/README.md or individual spec files
- Follow the instructions in tracks.md
- If code contradicts the spec, fix the code first (see AGENTS.md)
- Check the spec Changelog for recent changes that might affect existing code
- Commit your changes
- Do NOT use TodoWrite — just do the work
- Do NOT do multiple things — ONE thing per iteration

After selecting a spec to work on, check specs/bug-fix.md for items under that
spec's heading. Bug fix items count as Remaining work — fix one if you find an
unblocked item for your spec. Delete the item from bug-fix.md after fixing and
committing.

Output `TASK_COMPLETE: true` when done.
Output `LOOP_COMPLETE: true` only if ALL of these are true:

1. Every spec in README.md with status "Ready" has a tracks.md section where
   the header version matches the current spec version. If a section is missing
   or outdated, create or update it — read the spec changelog, compare to code,
   and populate Remaining items (do not create empty sections).
2. All "Remaining" lists across all tracks.md sections are empty or blocked
   (skip Deprecated specs).
3. specs/bug-fix.md has no unblocked items. If there are unblocked items for
   specs you have not yet worked on, pick one and fix it.
