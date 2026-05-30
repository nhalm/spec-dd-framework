# Deterministic Worklist & Loop — Design (v3)

> v3 incorporates three rounds of agent review. v1 (skill + `!`-injection + Stop hook) was
> dropped because that machinery doesn't fire in headless `claude -p`. v2 introduced the
> Node orchestrator but used an unsound "a commit exists = done" success gate. v3 fixes the
> success oracle, adds a failure state, resolves the approval/audit model, and folds in the
> verified Claude Code mechanics and codebase wiring. This is the current, implementable design.

## The problem we're fixing

Work items in `specd_work_list.md` are identified by free-text prose, and blockers reference
that prose. Four agents write the file (plan, audit, review-intake, humans), and the
implement agent must **fuzzy-match** "the item I just finished" against blocker strings from
a different session — sometimes naming a _category_ ("the auth system"), not a specific item.
Blockers don't clear, items strand, runs differ.

Three things are non-deterministic, all from **prose as identity**:

- **The worklist** — item identity and blocker references are prose.
- **The loop** — pick, clear-blockers, and "done" are LLM judgments signalled via stdout markers.
- **The review file** — review-intake _guesses_ whether a human decided.

## The principle

> Keep control flow and state deterministic. Reserve the LLM for the genuinely fuzzy parts:
> writing code, decomposing a spec, judging whether it finished an item, interpreting a human
> decision.

Backing (researched): Anthropic's "Building Effective Agents" (predefined code paths for
anything hardcodable); 12-Factor Agents Factor 8 ("Own your control flow"); the
`claude-task-master` precedent (deterministic `next` over a `dependencies` field); compounding
error (~0.9^10 ≈ 35% over ten LLM-driven steps). Shape: deterministic skeleton, LLM tactics.

## Architecture in one picture

```
                 ┌──────────────────────────────────────────────┐
                 │  Node orchestrator (loop.mjs)                 │  deterministic skeleton
                 │  owns the loop + all bookkeeping              │
                 └──────────────────────────────────────────────┘
   pick ── worklist.js next ─────────────┤ first item, empty blocked_by, attempts < K
                                         │
   implement ── spawn `claude -p` ───────┤ fresh context; item + instructions piped on STDIN
                  one item               │ agent ONLY: read spec, write code, commit, report
                                         │
   read result ── parse stream-json ─────┤ terminal {type:"result"}: subtype/is_error
                                         │ + agent's structured verdict {status, id}
                                         │
   classify ─────────────────────────────┤
     done|noop  → worklist.js done id     │ remove + clear blockers (idempotent)
     failed/err → attempts++ ; leave it   │ after K → surfaced for a human
                                         │
                                         └─▶ repeat until `next` empty; then audit/review
```

No skill, no `!`-injection, no Stop hook, no prose markers. The agent's only job is the one
fuzzy thing — implementing the single item it was handed and reporting the outcome.

## Success oracle (the part v2 got wrong)

v2 used "is*error false + a new commit = done." That's unsound: a legitimate no-op makes no
commit (→ false failure, retried forever), and a commit doesn't prove \_this* item was done
(partial work at max-turns, unrelated refactors, or an audit-phase commit all confound it).

v3: the agent **reports its own outcome**, the orchestrator transmits it deterministically:

1. The implement prompt instructs the agent to end with a structured verdict — the item id
   and `status` ∈ {`done`, `noop`, `failed`}. Read it from the result's `structured_output`
   if present, else parse the final JSON object from the result text.
2. The orchestrator classifies:

| Terminal result                          | Verdict             | Action                                                              |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `is_error: true` or `subtype != success` | (ignored)           | `attempts++`, leave item                                            |
| `is_error: false`                        | `done` or `noop`    | `worklist.js done <id>`                                             |
| `is_error: false`                        | `failed`/`blocked`  | `attempts++`, leave item                                            |
| `is_error: false`                        | missing/unparseable | `attempts++`, leave item (conservative — never remove on ambiguity) |

"Did I finish the item" is irreducibly the agent's judgment — the determinism is in reading a
**structured field from the terminal result** (not grepping prose from anywhere in stdout) and
in **bounding it**: an `attempts` cap means a missing or wrong verdict can neither strand an
item silently nor loop forever — after K attempts the item is surfaced to a human. That bound
is what makes trusting the agent's self-report safe.

## State files — structured JSON, script-owned

Both working files become JSON owned by a script, **gitignored** (transient working state).
`specd update` deletes the old markdown versions — clean cutover, no converter (a converter
would have to resolve prose blockers into ids, which is the original bug).

`specd_work_list.json`:

```json
{
  "items": [
    {
      "id": "auth-1",
      "spec": "auth",
      "attempts": 0,
      "text": "Create User model with email, password_hash, created_at + migration",
      "blocked_by": []
    },
    {
      "id": "auth-2",
      "spec": "auth",
      "attempts": 0,
      "text": "Add POST /auth/register that validates email and hashes password",
      "blocked_by": ["auth-1"]
    }
  ]
}
```

`specd_review.json`:

```json
{
  "findings": [
    {
      "id": "auth-r1",
      "spec": "auth",
      "status": "pending",
      "finding": "Login accepts expired tokens",
      "code": "auth/middleware.js:42 — no exp check",
      "spec_says": "Reject tokens past their exp claim",
      "options": ["A: fix code to check exp", "B: document current behavior"],
      "recommendation": "A",
      "decision": null
    }
  ]
}
```

JSON, not YAML/TOML: AGENTS.md mandates **zero runtime deps**; `JSON.parse` is built-in,
YAML/TOML need a library. Humans read via `list` and mutate via commands — they don't
hand-edit the raw file.

Ids fix the core bug: a blocker points at exactly one item; clearing it is exact removal from
a `blocked_by` array, never semantic matching. `add --blocked-by X` is rejected unless `X` is
a real id, so "blocked on a category" can't be written.

## No spec status flag — worklist membership is the source of truth

The Draft/Ready/Implemented flag was a manual gate that went stale (Ready specs lingering after
work finished). It's removed:

- **Approval = adding items to the worklist.** `plan` adds items only at the **end of an
  approved planning session** — not mid-draft. (This is a hard rewrite of plan.md's current
  "write items IMMEDIATELY as each section solidifies" instruction, which would otherwise put
  half-discussed items in front of the loop.) The loop only ever sees approved items.
- **A spec is "done" when its items drain to zero** — derived, not declared.
- **Audit scopes to the distinct specs present in the worklist.** A spec with items gets
  audited; a spec with none is either undrafted or drained — nothing to audit. No status to
  read, no Ready→Implemented transition to maintain. If audit finds problems, it adds items
  (which re-includes that spec in scope). This replaces all Ready/Implemented machinery in
  `audit.md`, `full-audit.md`, `implement.md`, `AGENTS.md`, and `specs/README.md`.

## The scripts

Real logic lives in `src/` as **pure, tested, linted functions** (matching AGENTS.md's
"pure functions for commands" convention); thin `.mjs` wrappers ship under
`templates/claude/scripts/` and just parse argv and call the exported functions. The wrappers
guard their `main()` (`if (import.meta.url === pathToFileURL(process.argv[1]).href`) so vitest
can import the functions without `process.exit` tearing down the test worker. `.mjs` pins the
module format regardless of the host repo's `package.json`.

**Writes are atomic** (temp file + `rename`) with a `.bak` of the last good file; a parse
failure exits with a clear "corrupt, restore from .bak" message. A **lockfile**
(`fs.open` with `wx`/`O_EXCL`, stale-timeout) wraps every read-modify-write so two loops — or
a human running `decide` mid-run — can't last-writer-wins each other.

`worklist.js`:

| Command                                       | Deterministic action                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `next`                                        | First item whose `blocked_by` is empty **and** `attempts < K`, in array order. Nothing if none.                                      |
| `done <id>`                                   | Remove the item; strip `<id>` from every other `blocked_by`. **Idempotent** — no-op + zero exit if id absent (safe on crash-replay). |
| `fail <id>`                                   | Increment `attempts`; the orchestrator calls this on a failed/errored turn.                                                          |
| `add --spec S --text "…" [--blocked-by a,b]`  | Assign id `S-N`; **verify each blocker id exists** (else fail); append `attempts:0`; print the id.                                   |
| `update <id> [--text "…"] [--blocked-by a,b]` | Replace fields, same blocker check.                                                                                                  |
| `remove <id>`                                 | Delete an item; **warn/refuse if others still reference it** (don't silently unblock dependents).                                    |
| `validate`                                    | Non-zero exit on: a `blocked_by` referencing a missing id, a cycle, or a `spec` not under `specs/`.                                  |
| `list [--spec S]`                             | Pretty-print items, ids, blockers, attempts; surfaces items at the `attempts` cap.                                                   |

`review.js`:

| Command                                                                           | Deterministic action                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `add --spec S --finding … --code … --spec-says … [--option …] --recommendation …` | Assign id; append `status:"pending"`. (audit)            |
| `pending`                                                                         | Print findings with `status == "pending"`. (loop gate)   |
| `list`                                                                            | Pretty-print all findings. (human reads)                 |
| `decide <id> "<text>"`                                                            | Record decision, set `status:"decided"`. (human)         |
| `undecide <id>`                                                                   | Back to `pending`.                                       |
| `resolve <id>`                                                                    | Remove a processed finding (idempotent). (review-intake) |

## The orchestrator (`specd loop`)

A subcommand in `src/cli.js` (not a shipped template) — tested and linted with the rest of
the CLI. Builtins only (`child_process`, `readline`, `fs`). Per implement turn:

1. `ITEM = worklist.js next` → `{id, spec, text}`; empty ⇒ implement phase done.
2. Build the prompt (instructions + the item + "end your turn with a final JSON line
   `{\"id\":\"<id>\",\"status\":\"done|noop|failed\"}`") and **spawn**
   `claude -p --model … --output-format=stream-json --verbose --dangerously-skip-permissions
--max-turns 25` (no `--resume` ⇒ fresh context). Hard requirements:
   - **Prompt on the child's STDIN**, not as a CLI arg (128 KB arg limit vs. 10 MB stdin cap;
     args-array spawn means zero shell-escaping).
   - **Spawn in a new process group** (`spawn(..., {detached: true})` + `setsid`) — issue
     #45717: a SIGTERM to the parent otherwise kills the orchestrator instead of the child.
   - **`-p` explicitly non-bare** (`--bare` is slated to become the `-p` default; bare mode
     disables OAuth and would force an API key, breaking subscription auth).
3. Stream stdout through `readline`; tee raw lines to a file and to `npx repomirror visualize`
   (best-effort, optional — `npx` failure must not abort the loop); `JSON.parse` each line.
   Mid-stream: collect `{type:"system", subtype:"api_retry", error}` events (categories:
   `rate_limit`, `billing_error`, `authentication_failed`, `oauth_org_not_allowed`,
   `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown`) for
   surfacing/backoff. Capture the terminal `{type:"result"}`. **On seeing the result event,
   immediately `kill('SIGKILL')` the child process group** — bug #25629 (open, not fixed)
   leaves `claude -p` hanging after emitting the result; don't await natural exit.
4. Per-turn **wall-clock backstop of 10 min** via setTimeout → SIGTERM → 30 s grace → SIGKILL
   (the kill is on the process group from step 2). AbortController is documented as unreliable
   (#2970); the kill is the actual stop.
5. Classify. **Read `subtype` before `result`** — error variants have no `result` field, they
   carry `errors: string[]`. Real subtypes: `success`, `error_max_turns`,
   `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`.
   On `subtype == "success"`, parse the last JSON object from `result.result` to get the
   verdict.
6. `done`/`noop` ⇒ `worklist.js done id`; otherwise `worklist.js fail id` (increments
   `attempts`). After **K = 2 attempts** the item is surfaced — `next` skips it and `list`
   highlights it.

Termination: `worklist.js next` empty (implement) and `review.js pending` empty (gate) — not
model markers. Exit codes from `claude -p` are **undocumented and unreliable** — branch on
`is_error`/`subtype`; treat exit code as a tiebreaker only.

Why we can't use `--json-schema` for the verdict: it requires `--output-format json`, which is
mutually exclusive with `stream-json`. We need `stream-json` for live `api_retry` events and
visualization — so the verdict comes from a final JSON line in `result.result`, bounded by
the `attempts` cap on parse failure. (This isn't a regression to fuzzy markers — it's one
structured field in one bounded location, with conservative failure handling.)

**Auth note:** `claude -p` uses subscription OAuth today (no `ANTHROPIC_API_KEY`), which is
why we spawn the CLI rather than use the Agent SDK (the SDK requires an API key and
disallows OAuth). Pin `-p` non-bare to keep this. From **2026-06-15**, `claude -p` on
subscriptions draws from a separate Agent-SDK credit pool; the loop is the heavy consumer.

## Writing: the producer side

The consumer being deterministic is half the job; a bad write breaks it. Writers go through
the scripts. Split: **fuzzy stays the LLM** (decompose a spec into items, decide dependencies,
write a finding, interpret a decision); **deterministic is the script** (assign ids, enforce
structure, reject blockers on non-existent items, check "decided").

### `specd:plan`

```
plan (LLM, interactive)
│ discuss scope; write/update the spec in specs/                   [MODEL]
│ DECOMPOSE into items + dependency order                          [MODEL]
└ ONLY once the human approves the session:
    worklist.js add --spec auth --text "Create User model …"  → auth-1            [CODE]
    worklist.js add --spec auth --text "Add /register …" --blocked-by auth-1      [CODE]
       (auth-1 missing → FAIL → add it first)
```

Items are added at the **end** of an approved session, not mid-draft. `add --blocked-by` only
accepts existing ids. Use `list --spec S` for existing ids; `update`/`remove` for stale items.

**Two honest limits** (structure can't fix reasoning):

- It kills dangling/category blockers, not bad _granularity_ — "implement the auth system" as
  one item is still writable. Granularity stays prompt-discipline + the human's plan-time
  review (now mandatory, since approval is the gate).
- Requiring blockers to reference existing ids means the LLM may just _omit_ a blocker; an
  unblocked item is always eligible, and `validate` can't detect a _missing_ dependency. We
  trade "category blockers" (silent strand) for "missing blockers" (runs too early). The
  realistic mitigation is human review at plan time — the suggested two-pass
  "add all, then `update --blocked-by`" is a workflow aid, **not** a guarantee; don't treat
  it as one.

### Review flow

```
audit (LLM): find a real mismatch [MODEL] → review.js add … → auth-r1 (pending) [CODE]
loop gate:   review.js pending → any? yes → stop: "decide these, re-run"         [CODE]
human:       review.js list (read) → review.js decide auth-r1 "A, …" (decided)   [CODE]
review-intake (LLM): review.js pending empty → for each decided finding:
               INTERPRET the decision [MODEL] → worklist.js add / edit spec → review.js resolve
```

The fuzziest thing today — guessing whether a human decided — becomes a `status` field check.
`undecide` covers a change of mind before intake runs. Interpreting the decision text stays
the LLM's job, then it calls `add` and `resolve`.

## Codebase changes (with the wiring the reviews surfaced)

### New files

- `src/worklist.js`, `src/review.js` — pure tested functions (the engine).
- `src/loop.js` — the orchestrator (spawn / readline / classify), invoked by `specd loop`.
- `templates/claude/scripts/worklist.js`, `review.js` — thin `.mjs` wrappers (argv → functions,
  guarded `main()` for vitest-safety).
- `templates/specd_work_list.json` (`{"items":[]}`) and `templates/specd_review.json`
  (`{"findings":[]}`) — **must exist**: `SCAFFOLD` copies a template file, it does not write
  inline content (`commands.js:213`); missing files crash init/update.
- `templates/claude/scripts/implement-prompt.md` — the implement instructions. **Moved out of
  `commands/`** (no longer a slash command — left there it would show as a broken
  `/specd:implement`). `specd loop` reads it from the target repo via `.claude/scripts/…`.
- No `loop.mjs` template, no `loop.sh`. Entry point is `specd loop` (with `--max-cycles`,
  `--full-audit`, `--skip-audit`, `--model-implement/audit/review`, `--attempts-cap`,
  `--max-turns`, `--turn-timeout` flags).

### `src/config.js`

- `FRAMEWORK_OWNED`: add the script wrappers and the implement prompt fragment; remove
  `loop.sh`; remove `implement.md` from `commands/`.
- `HEADER_UPDATABLE` → `[]` (remove `specd_work_list.md`); the header-split path can't run on
  JSON anyway.
- `SCAFFOLD`: add `specd_work_list.json`, `specd_review.json`.
- `REMOVED`: add `specd_work_list.md`, `specd_review.md`, `working_tracks.md`, `review.md`,
  and `loop.sh`.
- **Delete the `MIGRATIONS` entries** (`config.js:46-49`) — otherwise update renames
  `working_tracks.md → specd_work_list.md` then deletes it the same run.

### `src/cli.js`

- Add `specd loop` subcommand wiring (parses flags above; delegates to `src/loop.js`).

### `src/commands.js`

- Gitignore list (`commands.js:92`, currently the two `.md` names) → the two `.json` names +
  `*.json.bak`. **Factor the gitignore-ensuring block out of `init` and call it from `update`
  too** — today it runs only in init, so updating users would commit transient JSON state.
- **Loud cutover**: when REMOVED deletes a non-empty `specd_work_list.md`/`specd_review.md`,
  copy it to `*.md.bak` and print `DELETE … (migrated to JSON — old items not carried over;
re-run /specd:plan)`. The REMOVED loop needs a small file→note map.
- `doctor` (`commands.js:335`): drop the `loop.sh` executable check → check `loop.mjs` exists
  (it's run via `node`, not chmod-executable). ALL_FILES already covers presence.

### Prompts

- implement fragment: receives one item; implement exactly it; commit code only; **end with a
  structured verdict** (`{id, status}`); never touch the worklist.
- `plan.md`: call `worklist.js add/update/remove`; **kill "write items immediately"** — add at
  end of an approved session; drop Ready reminders; keep the Work Item Checkpoint.
- `audit.md` / `full-audit.md`: scope to specs present in the worklist; findings via
  `review.js add`, direct items via `worklist.js add`; remove Ready/Implemented transitions.
- `review-intake.md`: delete "detecting decisions"; use `review.js pending` → interpret →
  `worklist.js add` → `review.js resolve`.

### Tests (AGENTS.md requires coverage)

- New vitest suite importing `src/worklist.js`/`src/review.js`: `next` ordering + `attempts`
  cap, `done` clearing blockers + idempotency, `add` rejecting unknown blockers, `validate`
  (cycle / dangling / bad spec), atomic-write + corrupt-file + lockfile, review status
  transitions.
- Update `commands.test.js`: the ~10 assertions referencing `loop.sh` / `specd_work_list.md` /
  `ALL_FILES.length`, the conflict test, the now-dead HEADER_UPDATABLE preservation tests, the
  doctor loop.sh tests. Add init/update assertions for the new files.
- Extend `template-refs.test.js` to scan `loop.mjs` and the `.js` wrappers for path references
  (today it only walks `.md`), so the orchestrator's command-file reads are validated.

### Docs (all currently stale)

`README.md` (Work Tracking, Spec Lifecycle, File ownership, loop.sh usage, `(blocked:)`
examples), `AGENTS.md` (Ready, loop.sh, markdown worklist), `templates/specs/README.md`,
`specs/example-spec.md`, and `REVIEW_FINDINGS.md`.

## Decided

- External Node loop (`loop.mjs`), fresh `claude -p` per item, code between turns. (`/goal`,
  ralph-wiggum rejected — single-session accumulating context, no script seam. Agent SDK
  rejected — npm dep + API key breaks zero-dep and subscription auth.)
- Success = agent's structured verdict (done/noop/failed) read from the terminal result +
  `is_error`/`subtype`, bounded by an `attempts` cap. **Not** commit-existence.
- No skill, no `!`-injection, no Stop hook, no prose markers.
- Termination by `worklist.js next` / `review.js pending` empty.
- Prompt on stdin; kill child on result event; classify on subtype before reading result;
  rate limits via `api_retry` + result subtype; pin `-p` non-bare.
- Structured JSON state, script-owned, gitignored, atomic writes + `.bak` + lockfile;
  idempotent `done`/`resolve`.
- No spec status flag: worklist membership = approval; `plan` adds at session end; audit scopes
  to specs present in the worklist.
- Real logic in `src/` (tested/linted); thin `.mjs` wrappers shipped.
- Clean cutover, no converter; old `.md` deleted on update with a `.bak` + loud message.

## Resolved by research

- **Orchestrator entry:** `specd loop` subcommand (matches `claude-task-master` and `spec-kit`
  precedent; only `snarktank/ralph` ships a script and it's the outlier).
- **Defaults:** K = 2 attempts, N = 25 max-turns, 10 min per-turn wall-clock timeout. Spawn
  with a new process group (issue #45717). All overridable via flags.
- **Verdict mechanism:** final JSON line parsed from `result.result`. `--json-schema` exists
  on `claude -p` but requires `--output-format json`, mutually exclusive with `stream-json` —
  and we need `stream-json` for live `api_retry` events. The attempts cap bounds parse failures.
- **Payload shapes:** confirmed via docs. Mid-stream `api_retry` categories: `rate_limit`,
  `billing_error`, `authentication_failed`, `oauth_org_not_allowed`, `invalid_request`,
  `model_not_found`, `server_error`, `max_output_tokens`, `unknown`. Terminal error subtypes:
  `error_max_turns`, `error_during_execution`, `error_max_budget_usd`,
  `error_max_structured_output_retries` (error variants carry `errors[]`, no `result`).
  Token/context limits surface as `max_output_tokens` (mid-stream) or `invalid_request`
  ("Prompt is too long"); exhausted retries become `error_during_execution`. Exit codes are
  **undocumented and unreliable** — branch on `is_error`/`subtype`.
- **Known bugs to handle:** #25629 (claude -p hangs after the result event — kill on result;
  open, not fixed); #45717 (SIGTERM kills parent if not in new process group); #2970
  (AbortController unreliable — SIGKILL is the actual stop).
