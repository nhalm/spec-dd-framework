## Instructions

- Study AGENTS.md for guidelines.
- Study specs/README.md to understand existing specs and their statuses. Check if a spec already covers what the user is asking for before creating a new one.
- We are going to work on modifying and creating new specs.
- We do **not** write code unless explicitly asked to do so. We only modify *.md files and specd_work_list.md.
- When doing research use "model: Sonnet" agents in parallel to get the information that you need.

## Workflow

1. **Discuss** — Ask clarifying questions about what the user wants. Understand scope, edge cases, and design decisions before writing anything.
2. **Write the spec** — Create or update the spec in `specs/`. Follow the format in `specs/example-spec.md`. Specs define WHAT and WHY, not HOW. New specs start with status Draft.
3. **Write work items as you go** — As each spec section solidifies, IMMEDIATELY write corresponding work items to `specd_work_list.md` under a `## spec-name` section header. Do not wait for the user to ask — this is not optional. The work list is the primary deliverable of planning. If you finish a planning session without writing work items, you have failed.
4. **Update specs/README.md** — Add or update the spec entry in the index table with the correct status.
5. **Remind the user** — The spec starts as Draft. When the user is satisfied, they change the status to Ready in both the spec file and specs/README.md. The loop only implements Ready specs.

When **updating** an existing spec, always review the work items in specd_work_list.md for that spec. Remove items that are no longer relevant, update items that changed, and add new items for new requirements.

The work items in specd_work_list.md are what the loop uses to know what to implement. If you don't write them, the loop has nothing to do.

## Work Item Quality

Work items are executed by an autonomous agent that picks ONE item per iteration. Every item must be a single, concrete task — not a category of work. The agent reads the item, reads the spec, implements, and moves on. If the item is vague, the agent will either do the wrong thing or do too little.

**What makes a good work item:**
- Targets a specific function, endpoint, file, or component
- Has a clear "done" state that can be validated by running tests or checking behavior
- Can be completed in a single agent iteration (read spec → write code → run tests → commit)

**What makes a bad work item:**
- "Implement the auth system" — too broad, covers many files and behaviors
- "Add error handling" — where? for what errors? what should happen?
- "Set up the database layer" — vague scope, no clear stopping point

**Examples of good decomposition:**

Instead of: `Implement user authentication`
Write:
- `Create User model with email, password_hash, created_at fields and migration`
- `Add POST /auth/register endpoint that validates email format, hashes password with bcrypt, and returns 201 with user ID` (blocked: Create User model...)
- `Add POST /auth/login endpoint that verifies credentials and returns a JWT with user ID claim` (blocked: Create User model...)
- `Add auth middleware that extracts JWT from Authorization header and sets req.user` (blocked: Add POST /auth/login...)
- `Protect GET /users/:id endpoint with auth middleware, return 401 if no valid token` (blocked: Add auth middleware...)

Instead of: `Add input validation`
Write:
- `Add zod schema for CreateProject request body: name (string, 1-100 chars, required), description (string, max 500 chars, optional)`
- `Return 400 with field-level error messages when CreateProject validation fails`

**Read the spec thoroughly before writing items.** Walk through every requirement in the specification section. Each behavioral requirement, each endpoint, each validation rule, each error case should map to one or more work items. If the spec says "return 404 when not found", that's a work item — don't assume the agent will figure it out from a vague umbrella item.

## Work Item Checkpoint

**This is mandatory.** After writing or modifying a spec section, STOP before writing work items and perform this checkpoint:

1. **List every distinct behavioral requirement** you just wrote in the spec. Go line by line. If a sentence says the system must do X, that's a requirement. If it says "convert A to B", that's a requirement. If it says "warn when C", that's a requirement.
2. **Check for implied dependencies.** Does a requirement assume something exists that might not (e.g., timezone info, a tool, a database column)? Each gap is a work item or a blocker annotation.
3. **Write one work item per requirement** — concrete, specific, with a clear done state.
4. **Review existing work items** for this spec. Remove items that are no longer relevant after the spec change, update items whose scope changed, and unblock items whose dependencies were resolved. Do not leave stale items in the list.

This checkpoint applies both when writing a new spec and when refining an existing one. Every spec edit should trigger a re-evaluation of the work list.

## Spec-vs-Code Analysis

When comparing specs against code, use the same Gather → Validate → Write workflow described in the `/specd:audit` command. Never write findings directly from agent research — always validate against actual code first.
