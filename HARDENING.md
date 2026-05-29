# specd-loop operational hardening

This is what the **code** doesn't and can't do for you. Read it before running the loop
unattended on anything you care about.

## TL;DR — must-do before production

1. **Run the loop under a dedicated OS user** with no access to your real
   `~/.aws/`, `~/.ssh/`, `~/.netrc`, Keychain, or git push credentials. This is
   the single biggest mitigation. Code-level hardening is defense in depth on top of this.
2. **Sandbox the worker** with `sandbox-exec` (macOS) or `bwrap`/`firejail` (Linux): deny
   network egress except to Anthropic + your git remote + your package registry; deny
   filesystem write outside the project tree.
3. **Rotate your Claude OAuth refresh token** (`claude logout && claude login`) if any
   previous worker has been allowed to run as the loop's owning user. The OAuth token sits
   in your macOS Keychain and is readable by any process running as the same user —
   _including a malicious worker_.
4. **Set budget caps**: `SPECD_DAILY_BUDGET_USD=<n>`, `SPECD_MONTHLY_BUDGET_USD=<n>`. Configure
   per-million-token prices for your models (`SPECD_PRICE_OPUS_IN=15` etc.) — without them
   the loop tracks tokens but can't dollarize.
5. **Re-enable worktree isolation** for any non-trivial repo:
   `.claude/settings.json: { "worktree": { "bgIsolation": "worktree" } }`. The prototype
   ships with `"none"` for velocity; production should not.

---

## Threat model

A work item is implemented by `claude --bg --dangerously-skip-permissions`, running with
the orchestrator owner's filesystem rights, network egress, git push credentials, and access
to anything in `$HOME`. The model is the only thing between an adversarial prompt and your
secrets. The model is _not_ a security boundary.

Sources of adversarial input that can reach the worker:

- A poisoned spec file (someone slipped a spec into the repo, or a PR you merged).
- A poisoned commit message, README, or dependency the worker reads while implementing.
- A poisoned `npm install` running in `postinstall` scripts.
- A prompt injection in any web page the worker `WebFetch`es.
- A work item text written by an automated upstream (e.g. you ran `/specd:audit` on code that
  was itself injected).

Treat the worker as **untrusted code that you choose to run**.

---

## Code-level mitigations already in this prototype

| Risk                                          | Mitigation in code                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt visible in `ps` (argv leak)            | Prompt passed to `claude --bg` via stdin                                                                                                                    |
| Worker mutates the worklist / review state    | `SPECD_IN_WORKER=1` in worker env; `worklist.js` / `review.js` refuse write verbs when set. **Defense-in-depth only** — see "What this doesn't stop" below. |
| Forged verdict from prompt text               | Per-dispatch nonce required in the verdict JSON; mismatches are rejected                                                                                    |
| Verdict regex picks up quoted/code-block JSON | Balanced-brace parser + last-line preference + nonce gate                                                                                                   |
| Cross-cwd session collision                   | Full UUID resolution (not 8-char prefix); JSONL lookup restricted to current cwd's encoded directory                                                        |
| Initial-idle false positive                   | Poll requires seeing `busy` before treating `idle` as terminal                                                                                              |
| Runaway session on timeout                    | Per-item wall-clock timeout calls `claude stop` on the in-flight session                                                                                    |
| Dispatch failure burns the queue              | Dispatch errors release the claim, back off (5s → 30s → 1m → 5m → 10m), halt after 5 consecutive failures                                                   |
| Corrupt worklist invisible at startup         | `worklist.js validate` is run before the first iteration; halt if it fails                                                                                  |
| Concurrent writes corrupt state               | Atomic temp-file + rename; `.bak` of last-good; lockfile with PID liveness check                                                                            |
| Two orchestrators pick the same item          | `worklist.js next` atomically claims under the lock; second `next` skips claimed items                                                                      |
| Crash leaves item claimed forever             | Stale claims (older than 1.5× per-item timeout) are reclaimable                                                                                             |
| Spec name escapes worklist                    | `--spec` rejects `/`, `..`, `.md` suffix, and invalid chars                                                                                                 |
| Lockfile DoS                                  | Stale lock is removed when the holder's PID is dead OR the file is older than `SPECD_LOCK_STALE_MS`                                                         |
| No observability                              | `.specd-loop.status.json` heartbeat, `.specd-loop.pid`, `specd_loop_events.jsonl` per-item cost log                                                         |
| Already-running orchestrator                  | PID file with liveness check prevents a second orchestrator starting in the same cwd                                                                        |
| Signal handling                               | `SIGTERM` / `SIGINT` release the current claim and stop the in-flight session before exit                                                                   |
| Log unbounded growth                          | `.specd-loop.log` rotates at 10 MB on startup, keeps last 1                                                                                                 |

The implement prompt itself contains hard-rule statements forbidding the worker from
editing `.claude/`, `~/.claude/`, anything outside cwd, pushing branches, committing
secrets, or spawning nested `claude --bg` calls. **These are advisory only** — the model
can be persuaded. They are not a substitute for OS-level sandboxing.

### What `SPECD_IN_WORKER` doesn't stop (honest)

The env-var guard in `worklist.js` blocks the worker from calling `worklist.js add` /
`done` / `fail` directly. Red-team showed it's defeated by **any of these**:

- `env -u SPECD_IN_WORKER node .claude/scripts/worklist.js …`
- `unset SPECD_IN_WORKER; node …`
- `node -e "spawn('node',[...],{ env: {} })"` — env-stripped subprocess
- Direct JSON edit: `node -e "JSON.parse(fs.readFileSync(...)).items.push(...)"`

A worker with filesystem write to the project tree (the default with
`--dangerously-skip-permissions`) can bypass it trivially. The guard is **kept as
defense-in-depth** (it catches accidental misuse and signals intent to the model), but it
is **not a security boundary**. The only real boundaries are:

- OS-level: separate user, sandbox-exec / bwrap, worktree isolation
- HMAC on approval markers (closes the planning-gate forgery vector — see below)
- The verdict nonce (closes the completion-forgery vector)

### Approval marker forgery, closed (HMAC)

`.specd-approvals/<spec>.json` markers are HMAC-signed using a per-machine key in
`~/.config/specd/approval-key` (chmod 600, in your home dir — outside the project tree
and outside whatever the worker can reach when properly sandboxed). The signature
covers `{spec, content_hash, verdict, issues, approved_at, reviewer_session}`.

`specs.js gate` (which `worklist.js add` calls under `SPECD_REQUIRE_APPROVAL=1`) verifies
the signature before accepting the marker. A worker that fabricates a marker without the
key gets rejected with `invalid signature`. Verified end-to-end in red-team — forged
markers (no sig, bogus sig) are rejected; only `specs.js review` (which has the key)
produces valid markers.

**Operational requirement:** `~/.config/specd/approval-key` must NOT be readable by the
worker. If you run the loop and the worker as the same user (the prototype default),
the worker can read it — defeating the HMAC. **Run as a dedicated user** to actually get
the protection. See "Run under a dedicated user" below.

### specs.js test sandboxing

`specs.js test` runs each `**Test:**` block via `/bin/sh -c <test.run>`. The test command
is shell from the spec author. We added two layers of in-process defense:

- **Env scrubbing.** Before spawning, the orchestrator drops env vars matching `*KEY*`,
  `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `ANTHROPIC_*`, `AWS_*`, `GH_*`, `GITHUB_*`,
  `OPENAI_*`, `HF_*`, `NPM_TOKEN`, `CARGO_REGISTRY*`. Tests cannot read these credentials
  from `process.env`.
- **SPECD_TEST_SANDBOX_CMD.** If set, every test runs as
  `<SPECD_TEST_SANDBOX_CMD> /bin/sh -c <run>`. Use this to wrap with `sandbox-exec`
  (macOS) or `bwrap` (Linux) and impose a network + filesystem profile.

```sh
# macOS — deny network + write-anywhere outside cwd:
cat > /tmp/specd-test.sb <<'EOF'
(version 1)
(deny default)
(allow process-fork)
(allow file-read*)
(allow file-write* (subpath (param "CWD")))
(allow file-write* (subpath "/tmp"))
EOF
export SPECD_TEST_SANDBOX_CMD="sandbox-exec -D CWD=$PWD -f /tmp/specd-test.sb"
```

Even with these layers, **a poisoned spec is still untrusted code**. Don't run
`specs.js test` on a spec from an unknown source without reviewing the `**Test:**` blocks
first.

### Symlink-resistant file writes

PID file, worklist `.tmp`/`.bak`, and review `.tmp`/`.bak` are all written via `openSync`
with `O_EXCL`/`wx`, so a planted symlink (e.g. `ln -sf ~/.ssh/authorized_keys
.specd-loop.pid`) gets EEXIST instead of being followed. The worklist `.tmp` filename has
a random 16-char suffix per write so an attacker can't pre-create / truncate to race the
rename.

### `specd-loop stop` identity check

Before sending SIGTERM, `specd-loop stop` confirms the live pid's command line contains
`specd-loop.mjs` or `bin/specd-loop` (via `ps -o command=`). A planted pid file pointing
at an unrelated process (sleep, sshd, whatever) is refused with a clear error.

---

## What code can't fix — you must do these out-of-band

### Run under a dedicated user

The single most effective hardening. On macOS:

```bash
sudo sysadminctl -addUser specd-bot -fullName "specd bot" -password -
sudo dseditgroup -o edit -a specd-bot -t user staff
```

Configure `specd-bot`'s shell, give them a clone of your repo (they need read access to
it), generate them a deploy key for git push (restricted to non-protected branches), set
up their own Keychain with their own `claude login` (or `ANTHROPIC_API_KEY`). They have no
access to your shell history, your AWS creds, your SSH keys, or your subscription tokens.
Switch users via `sudo -u specd-bot -i` before running the loop.

Linux equivalent: `useradd specd-bot && sudo -iu specd-bot`.

### Sandbox the worker

The worker runs as a child of `claude --bg`; it inherits the orchestrator's environment.
Configure a deny-by-default network and filesystem profile.

macOS (`sandbox-exec`):

```
(version 1)
(deny default)
(allow process-fork)
(allow file-read*)
(allow file-write* (subpath "/Users/specd-bot/work"))
(allow file-write* (subpath "/private/tmp"))
(allow network-outbound
  (remote ip "*.anthropic.com")
  (remote ip "*.claude.com")
  (remote ip "*.github.com")
  (remote ip "*.npmjs.org"))
```

Save as `~/specd.sb` and invoke: `sandbox-exec -f ~/specd.sb node .claude/scripts/specd-loop.mjs`.

Linux (`bwrap`):

```bash
bwrap --bind / / --tmpfs /tmp --ro-bind /home/specd-bot/.ssh /home/specd-bot/.ssh \
      --unshare-net --share-net \
      node .claude/scripts/specd-loop.mjs
```

These are _examples_ — adapt to your network requirements (Anthropic API, your git
remote, your package registry).

### Rotate the Claude OAuth refresh token

Anyone with the refresh token in `Claude Code-credentials` (macOS Keychain) can use your
subscription from another machine. After any worker run as your user, treat the token as
compromised:

```bash
claude logout
claude login
```

Better: run as `specd-bot` so this isn't your account's token in the first place.

### Use a deploy key for git push (don't ssh-agent forward)

The worker can `git push` to anywhere the SSH agent answers for. If you must push, use a
single-purpose deploy key in `~specd-bot/.ssh/` with a restricted `config` (single host,
single repo, no `IdentityFile` for anything else, no `ForwardAgent`).

### Enable worktree isolation

In `.claude/settings.json`:

```json
{ "worktree": { "bgIsolation": "worktree" } }
```

Each worker gets its own ephemeral worktree; even if a worker decides to delete files, the
mainline tree is untouched until the worker's worktree is merged back.

### Pre-commit secret scanning

Install a pre-commit hook running `gitleaks` or `trufflehog`. Hooks alone can be bypassed
with `--no-verify`, so back them with a server-side check on push (GitHub Actions / Gitea
hook / pre-receive on a self-hosted remote).

### Disk pressure

`specd-loop.mjs` rotates `.specd-loop.log` at 10 MB. It does _not_ prune the Claude session
transcripts in `~/.claude/projects/`, which accumulate ~10–50 KB per item indefinitely.
Add a periodic cleanup:

```bash
# crontab: prune transcripts > 30 days
0 3 * * * find ~/.claude/projects -name "*.jsonl" -mtime +30 -delete
```

---

## Operational env vars

| Var                          | Default                        | Purpose                                                                                                        |
| ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `SPECD_MAX_ITEMS`            | 50                             | Outer cap per orchestrator run                                                                                 |
| `SPECD_PER_ITEM_TIMEOUT_MS`  | 1800000 (30m)                  | Per-item wall-clock kill                                                                                       |
| `SPECD_ATTEMPTS_CAP`         | 2                              | Retries before SURFACING                                                                                       |
| `SPECD_POLL_MS`              | 5000                           | Status poll interval                                                                                           |
| `SPECD_POLL_WARMUP_MS`       | 1500                           | Wait after dispatch before polling                                                                             |
| `SPECD_DISPATCH_FAILURE_CAP` | 5                              | Halt after N consecutive dispatch failures                                                                     |
| `SPECD_MODEL`                | (claude default)               | Force a model for all workers                                                                                  |
| `SPECD_DAILY_BUDGET_USD`     | (off)                          | Halt at daily spend                                                                                            |
| `SPECD_MONTHLY_BUDGET_USD`   | (off)                          | Halt at monthly spend                                                                                          |
| `SPECD_PRICE_<MODEL>_IN/OUT` | (off)                          | Per-million-token rates for cost estimation. e.g. `SPECD_PRICE_OPUS_IN=15`                                     |
| `SPECD_CACHE_READ_MULT`      | 0.1                            | Cache-read price as multiplier of input price                                                                  |
| `SPECD_CACHE_CREATE_MULT`    | 1.25                           | Cache-create price as multiplier of input price                                                                |
| `SPECD_NOTIFY_CMD`           | (none)                         | Shell command invoked with `<kind> <message>` on SURFACED, budget exceeded, halt, crash                        |
| `SPECD_LOG_ROTATE_BYTES`     | 10485760 (10M)                 | Rotate `.specd-loop.log` at this size                                                                          |
| `SPECD_REQUIRE_SPEC_FILE`    | 0                              | If `1`, `worklist.js add` rejects spec names without a corresponding `specs/<name>.md`                         |
| `SPECD_REQUIRE_APPROVAL`     | 0                              | If `1`, `worklist.js add` requires an HMAC-signed `.specd-approvals/<name>.json` matching current spec content |
| `SPECD_HMAC_KEY_PATH`        | `~/.config/specd/approval-key` | Path to the per-machine HMAC key (auto-generated chmod 600 on first review)                                    |
| `SPECD_TEST_SANDBOX_CMD`     | (none)                         | Command prefix wrapping every `specs.js test` run (e.g. `sandbox-exec -f profile.sb`)                          |
| `SPECD_TEST_STREAM_CAP`      | 1048576 (1 MB)                 | Per-stream byte cap for test stdout/stderr; over-cap → SIGKILL process group                                   |
| `SPECD_DISPATCH_TIMEOUT_MS`  | 60000                          | Hard timeout on the dispatch `spawnSync("claude", "--bg", …)` call                                             |
| `SPECD_LOCK_TIMEOUT_MS`      | 10000                          | Wait for the worklist lock                                                                                     |
| `SPECD_LOCK_STALE_MS`        | 30000                          | Lockfile staleness threshold (when PID can't be checked)                                                       |
| `SPECD_CLAIM_STALE_MS`       | 2700000 (45m)                  | `in_progress` claim is reclaimable after this                                                                  |

### Example: macOS desktop notification on a SURFACED item

The orchestrator passes the notification kind and message via env vars
(`SPECD_NOTIFY_KIND`, `SPECD_NOTIFY_MESSAGE`) AND as positional argv. Use the env
vars — they're a safer source than `$1`/`$2` because they're not subject to
re-injection if a downstream shell interpolates them.

```sh
cat > ~/bin/specd-notify <<'EOF'
#!/bin/sh
# Pass strings through osascript's stdin to avoid AppleScript injection from
# notification text that could itself contain AppleScript metacharacters.
KIND=${SPECD_NOTIFY_KIND:-unknown}
MSG=${SPECD_NOTIFY_MESSAGE:-no message}
osascript <<APPLESCRIPT
on run argv
  display notification (item 2 of argv) with title ("specd: " & (item 1 of argv))
end run
APPLESCRIPT - "$KIND" "$MSG"
EOF
chmod +x ~/bin/specd-notify
export SPECD_NOTIFY_CMD=~/bin/specd-notify
```

The orchestrator spawns `SPECD_NOTIFY_CMD` _without_ a shell (no `shell: true`),
so positional args aren't subject to shell metacharacter expansion. But your
notify script itself runs in a shell; the example above passes the env-var
values through AppleScript's `argv` mechanism rather than via string
interpolation, which would re-introduce injection.

---

## What you give up by ignoring this doc

If you run the loop as yourself, with `bgIsolation: "none"`, no sandbox, and no budget caps:

- A single prompt injection in a spec, a README, or a dependency README can `rm -rf $HOME`,
  `git push --force` to any remote, exfiltrate your AWS keys, or steal your subscription
  OAuth token.
- An overnight run can rack up arbitrary API spend if you've configured an API key.
- A bug that gets the loop into a tight failure loop can burn through your subscription's
  Agent SDK credit pool in minutes.

The code in this prototype is hardened _given_ you have set up the operational mitigations
in this document. None of it removes the need for them.
