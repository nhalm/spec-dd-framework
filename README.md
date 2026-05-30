# specd

[![CI](https://github.com/nhalm/specd/actions/workflows/test.yml/badge.svg)](https://github.com/nhalm/specd/actions/workflows/test.yml)
[![GitHub Release](https://img.shields.io/github/v/release/nhalm/specd)](https://github.com/nhalm/specd/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An autonomous spec-driven coding loop for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). You write specs with executable tests, the loop drains them through fresh `claude --bg` sessions one work item at a time, and audits its own work by running each spec's tests against the code. The loop exits cleanly only when the worklist is empty AND every spec's tests pass.

The system invariant: **deterministic control flow, fuzzy work**. Picking, clearing, validating, deciding "done" — all plain Node code. Writing code, decomposing specs, judging spec quality — the LLM.

## What this is

Most AI coding workflows are conversational — you prompt, the agent codes, you course-correct in real time. That works for small tasks but breaks down on larger projects where requirements are complex and context gets lost between sessions.

specd replaces that with a document-driven, deterministic loop:

1. **You describe what to build** — in a planning session with Claude, which writes the spec (with runnable test contracts for each behavior).
2. **The orchestrator drains the worklist** — one fresh `claude --bg` session per work item. Items can't enter the worklist without your explicit approval at the end of a planning session.
3. **The audit phase runs your specs' tests** — failing behaviors auto-queue as work items. There's no fuzzy "does the code match the spec" judgment — `specs.js test` literally runs the test commands the spec declares.
4. **You make the judgment calls** — ambiguous findings land in `specd_review.json` for your decision before becoming work items.

Specs are the source of truth and they ARE executable contracts. Each `### Behavior N` block carries a runnable test (`run:` shell command, `stdout`/`exit` expectations); the audit phase runs them.

## Why this design

AI agents are good at writing code but bad at deciding what to write. Without a clear target, they drift. The longer they run autonomously, the worse this gets — and any LLM step has ~10% small judgment errors that compound multiplicatively across long chains.

**Specs solve the direction problem.** Each behavior is one sentence + one runnable test. The agent can't drift because the spec is mechanically checkable — `specs.js test` doesn't ask the model whether the code matches, it runs the contract.

**The loop solves the continuity problem.** Each work item is implemented in a fresh `claude --bg` session — full context every time, no accumulation, no drift across iterations. The orchestrator drives picking, blocker-clearing, and verdict parsing in deterministic code.

**The review file solves the judgment problem.** Not everything is black and white. When the audit finds a mismatch the tests don't catch, it writes a finding to `specd_review.json` and moves on. You answer it with `node .claude/scripts/review.js decide <id> "..."`. The next loop pass turns your decision into a work item.

Together: specs steer, the orchestrator implements, executable tests verify, ambiguous findings route to you. Each cycle either makes progress or surfaces a decision.

## Prerequisites

- [Node.js](https://nodejs.org/) (v24+, see `.nvmrc`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated. The loop uses `claude --bg` so it stays on subscription billing (Pro/Team/Max).

## Quickstart

```bash
cd your-project
npx specd init
```

This prompts for your project name and description, then creates:

- `AGENTS.md` — Framework instructions for agents (spec authority, audit discipline, loop system).
- `PROJECT.md` — Your project-specific guidelines (build commands, conventions).
- `specs/` — Spec directory with a worked example (`example-spec.md`).
- `.claude/commands/specd/` — Slash commands: `plan`, `audit`, `review-intake`, `loop`.
- `.claude/scripts/` — The deterministic engine: `worklist.js`, `review.js`, `specs.js`, `specd-loop.mjs`.
- `.claude/settings.json` — Worktree isolation config.
- `specd_work_list.json`, `specd_review.json` — State files (gitignored).
- `.gitignore` updates for all the local state files.

Then plan your first feature inside Claude Code:

```
claude
> /specd:plan auth
```

Discuss the feature, iterate on the spec, and approve the decomposition at the end. Items land in `specd_work_list.json`.

Then drain them:

```bash
specd loop start
```

The loop runs in the background. Monitor with `specd loop status` and `specd loop logs --follow`.

## CLI reference

```
specd <command> [options]

Commands:
  init   [dir]            Initialize a project with the specd framework
  update [dir]            Update framework-owned files to the latest version
  doctor [dir]            Check that all expected files are in place
  loop <verb> [options]   Drive the autonomous coding loop

Loop verbs:
  specd loop start                   Start the orchestrator (background by default; --foreground for inline)
  specd loop run-once                Foreground + single iteration
  specd loop status                  Show heartbeat, current item, cycle
  specd loop stop                    Send SIGTERM (clean shutdown)
  specd loop cost [--today]          Token + estimated dollar cost from events.jsonl
  specd loop logs [--tail N] [--follow]

Common options:
  --dry-run, --overwrite, --foreground, --once, --skip-audit
  --help, -h, --version, -v
```

## How the loop works

```
                  ┌───────────────────────────────────────┐
                  │  Node orchestrator (specd loop)        │ all deterministic
                  │  owns the loop + all bookkeeping       │
                  └───────────────────────────────────────┘
   pick   ── node .claude/scripts/worklist.js next       (deterministic claim)
                  │
   implement ── claude --bg <prompt with item>           (fresh context; nonce-required verdict)
                  │
   read result ── parse session JSONL transcript         (no markers grepped — structured field)
                  │
   classify ── verdict + git HEAD cross-check
                  │
       done|noop → worklist.js done <id>
       failed    → worklist.js fail <id>  (attempts++; SURFACED at cap)
                  │
                  └─▶ next iteration, or after queue drains:
                       audit ── specs.js test in parallel across all specs
                                 failing behaviors → worklist.js add
                                 if any added → next cycle; else exit
```

Three deliberate human gates:

1. **Plan approval** — items only enter the worklist when you approve `/specd:plan`.
2. **Loop start** — `specd loop start` is your call.
3. **Review decisions** — pending findings in `specd_review.json` block the loop until you answer.

Everything else is code.

## Lifecycle in practice

### 1. Plan with Claude

`/specd:plan <spec-name>` (in a Claude Code session). Discuss, iterate, the agent drafts `specs/<name>.md`, you approve the decomposition. The agent calls `worklist.js add` only at session end, only on explicit approval.

### 2. Run the loop

```bash
specd loop start
```

The orchestrator drains items one at a time. Each item gets a fresh `claude --bg` session (subscription-billed). Status: `specd loop status`. Cost: `specd loop cost`.

### 3. Audit (automatic at queue drain)

`specs.js test` runs every Behavior's Test against the code in parallel across all specs. Failing behaviors become work items with the exact failure reason. The loop runs the next cycle automatically. Exit when worklist is empty AND all tests pass.

### 4. Review

If the audit found an ambiguous finding (`specs.js test` passes but something is still off), it writes to `specd_review.json`. The loop stops and waits. You answer with:

```bash
node .claude/scripts/review.js list
node .claude/scripts/review.js decide auth-r1 "A, but only for tokens <7d old"
```

Then re-run `specd loop start`. The `/specd:review-intake` phase turns your decision into work items.

## Strict spec format

Specs in `specs/<name>.md` must conform to this format — `specs.js validate` enforces it:

```markdown
# auth

## Overview

One paragraph: user, feature, why.

## Specification

### Behavior 1 — login endpoint

**Description:** POST /login with email + password returns a JWT on success and 401 on failure.

**Test:**

- run: `curl -s -X POST localhost:3000/login -d '{"email":"a@b","password":"pw"}'`
- stdout_contains: `"token"`
- exit: 0

**Example:** valid creds → `{"token":"eyJ..."}`

### Behavior 2 — ...

## Constraints (optional)

- JWT signed with HS256; 1h expiry.
```

See `templates/specs/example-spec.md` for a full worked example.

## File ownership

| File / directory              | Owner   | Update behavior                            |
| ----------------------------- | ------- | ------------------------------------------ |
| `AGENTS.md`                   | specd   | Overwritten on `specd update`              |
| `.claude/commands/specd/*.md` | specd   | Overwritten on `specd update`              |
| `.claude/scripts/*.{js,mjs}`  | specd   | Overwritten on `specd update`              |
| `.claude/settings.json`       | specd   | Overwritten on `specd update`              |
| `PROJECT.md`                  | You     | Never overwritten                          |
| `specs/*.md`                  | You     | Never overwritten                          |
| `specs/README.md`             | You     | Created once (template), then yours        |
| `specd_work_list.json`        | scripts | Created empty, never overwritten on update |
| `specd_review.json`           | scripts | Created empty, never overwritten on update |
| `.specd-approvals/*.json`     | scripts | HMAC-signed; do not edit by hand           |
| `.specd-loop.*`               | scripts | Orchestrator state                         |
| `specd_loop_events.jsonl`     | scripts | Per-item cost log (append-only)            |

## Determinism story

| Operation                                | Mechanism                                                          | LLM?                                   |
| ---------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Pick next work item                      | `worklist.js next`                                                 | No                                     |
| Atomic claim (multi-orchestrator safety) | lockfile + `in_progress` PID liveness                              | No                                     |
| Mark done / clear blockers               | `worklist.js done` (idempotent)                                    | No                                     |
| Spec structure                           | `specs.js validate`                                                | No                                     |
| Spec behavior conformance                | `specs.js test` — actually runs the Test                           | No                                     |
| Spec content quality                     | `specs.js review` — separate LLM, fixed rubric, structured verdict | LLM, bounded                           |
| Implement the work item                  | `claude --bg` worker                                               | **Yes — the legitimate creative work** |
| Verdict transmission                     | nonce + balanced-brace parser + attempts cap                       | Bounded                                |
| Git verdict cross-check (noop ↔ commit)  | git HEAD before/after                                              | No                                     |
| Termination                              | queue empty + audit clean                                          | No                                     |

## Hardening

Code-level defenses (HMAC-signed approval markers, env scrubbing, symlink-resistant writes, verdict nonce, identity check on stop, …) are documented in [HARDENING.md](HARDENING.md). The model is NOT a security boundary — for unattended production use, the same doc walks through the OS-level mitigations (dedicated user, sandbox-exec / bwrap, worktree isolation re-enabled).

## Updating

```bash
specd update
```

Overwrites framework-owned files without touching your spec files, your `PROJECT.md`, or your state. If you've modified any framework file locally, the update fails until you re-run with `--overwrite`.

## Testing

```bash
make test    # vitest — 107 unit + integration tests
make check   # lint + format
make fix     # auto-fix lint and formatting
```

## Cost expectations

At Sonnet rates with typical decomposition, expect roughly $0.30–$0.70 per implement turn, $3–$15 per loop run (15–20 items). Configure `SPECD_PRICE_<MODEL>_IN/OUT` env vars to enable cost estimation; `specd loop cost` summarizes spend by day, month, model, and verdict.

## Status

This is version `0.2.0`, the deterministic-loop rewrite. Earlier versions used a bash `loop.sh` + markdown worklist; that design is fully retired (see `DETERMINISTIC_WORKLIST_DESIGN.md` for the architecture history and three rounds of red-team findings).

What's confirmed working:

- ✅ Subscription-billed via `claude --bg` (no API key required)
- ✅ Fresh context per item
- ✅ Deterministic pick / done / blocker clear
- ✅ Closed audit-on-drain loop (regression → caught → queued → fixed → confirmed)
- ✅ HMAC-signed plan-approval gate
- ✅ Verdict nonce + prompt-injection defenses
- ✅ Cost tracking + budget gating
- ✅ Crash + restart recovery
- ✅ 107 unit tests pass

## License

MIT
