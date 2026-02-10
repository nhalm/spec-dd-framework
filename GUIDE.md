# Spec-Driven Development: Getting Started

This skeleton implements a workflow where **humans write specs** and **AI agents implement them**. Specs define WHAT to build and WHY. Agents decide HOW.

## How It Works

```
You write specs ──→ Agent reads specs ──→ Agent writes code ──→ You review
      ↑                                                             │
      └─────────── adjust specs if needed ──────────────────────────┘
```

There are two modes of working:

1. **Planning mode** — You and an AI work together on specs (no code). Use `planning_prompt.md`.
2. **Loop mode** — An AI agent implements specs autonomously, one item at a time. Use `loop.sh`.

## Quick Start

### 1. Copy the skeleton

```bash
cp -r dd-workflow-spec/ /path/to/your-new-project/
cd /path/to/your-new-project/
```

### 2. Personalize the placeholders

Replace `{PROJECT_NAME}` in these files:
- `AGENTS.md` — header
- `specs/README.md` — header and description
- `tracks.md` — header

Replace `{One-line project description}` in `specs/README.md`.

### 3. Customize AGENTS.md

This file tells agents how to behave in your project. Edit it to match your stack:

- **Conventions section** — Add your naming conventions, project-specific patterns, crate/package prefixes.
- **Test Organization** — Adjust for your language and test framework. The default assumes Rust with separate test files.
- **Mocking and Traits** — Adjust for your language's abstraction patterns (interfaces, protocols, traits, etc.).

### 4. Delete the example spec

Remove `specs/example-spec.md` once you understand the format, or keep it as a reference. Either way, remove its row from `specs/README.md`.

### 5. Write your first real spec

Create a new file in `specs/` following the format in `example-spec.md`:

```
specs/your-feature.md
```

Start at **Draft** status — just the overview and empty specification section. Then work it up to **Ready** before letting agents implement it.

Add it to the phase table in `specs/README.md`.

### 6. Set up tracks.md

When a spec reaches "Ready", add a tracking section to `tracks.md`:

```markdown
## your-feature.md v0.2

**Status:** In Progress

**Implemented:**
- (nothing yet)

**Remaining:**
- First implementation item
- Second implementation item
- Third item (blocked: other-spec.md)
- Fourth item (future)
```

Break specs into small, focused items. Each item should be one iteration of work. If an item has "and" in it, it's probably too big — split it.

### 7. Run the loop

```bash
./loop.sh
```

This runs `prompt.md` through Claude Code repeatedly. Each iteration:
1. Agent reads specs and tracks.md
2. Picks ONE remaining item
3. Implements it
4. Commits the change
5. Loop continues until nothing is left

The loop stops automatically when all remaining items are blocked or future.

## File Reference

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Entry point for Claude Code — points to AGENTS.md |
| `AGENTS.md` | Agent guidelines: spec authority, conventions, test patterns |
| `specs/README.md` | Spec index with status legend and phase tables |
| `specs/*.md` | Individual spec files |
| `tracks.md` | Tracks Implemented vs Remaining for each spec |
| `prompt.md` | Agent prompt for the implementation loop |
| `planning_prompt.md` | Prompt for human+AI spec writing sessions |
| `loop.sh` | Shell script that runs the implementation loop |

## The Spec Lifecycle

```
Draft ──→ Ready ──→ Implemented
```

| Stage | What happens | Who |
|-------|-------------|-----|
| **Draft** | Being specified. Could be a bare placeholder or actively being filled in. Use `planning_prompt.md` to iterate with AI assist. | Human |
| **Ready** | Spec is complete. Detailed enough for an agent to implement without asking questions. | Human marks status |
| **Implemented** | Fully implemented. Code matches spec. | Human marks status after verifying |

**Key rule:** Only humans change spec status. Agents never touch it.

## Writing Good Specs

### What to include

- **Overview** — What and why in 1-2 sentences
- **Scope** — What it does AND what it explicitly doesn't do
- **Dependencies** — Other specs this depends on
- **Specification** — Behavior, contracts, interfaces. Detailed enough that an agent doesn't need to ask questions.
- **Changelog** — Version history so agents can catch up on changes

### What NOT to include

- Implementation details (file structure, function names, variable names)
- Code snippets as requirements (use them only as illustrative examples)
- Multiple ways to do something — pick one and specify it

### Spec size

A spec should cover one coherent component or feature. If you find yourself writing 2000+ lines, consider splitting into multiple specs with explicit dependencies.

## Tips

- **Start small.** Write 2-3 specs for your foundation (project structure, build system, testing). Get those to "Implemented" before writing more.
- **One item per loop iteration.** The prompt enforces this. Small items = reliable progress.
- **Blocked items are fine.** Mark them in tracks.md and the agent will skip them.
- **Future items are deferred.** Mark them and they won't be implemented until you're ready.
- **Review agent commits.** The loop generates commits. Review them like you would any PR.
- **Specs evolve.** Bump the version, add a changelog entry, and agents will adapt.
