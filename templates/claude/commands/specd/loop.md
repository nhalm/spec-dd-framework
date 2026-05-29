---
description: Start the specd autonomous loop in the background and monitor it from this session.
---

# Start the loop

!`if [ -f .specd-loop.pid ] && kill -0 $(node -e "console.log(JSON.parse(require('fs').readFileSync('.specd-loop.pid')).pid)") 2>/dev/null; then echo "ALREADY RUNNING"; cat .specd-loop.pid; else nohup node .claude/scripts/specd-loop.mjs > .specd-loop.log 2>&1 & echo "started pid $!"; fi`

# Initial queue state

!`node .claude/scripts/worklist.js list 2>&1`

# Instructions to the agent

The specd loop is now running detached. It iterates work items from `specd_work_list.json` until the queue is empty, dispatching one fresh `claude --bg` worker per item, validating verdicts against a per-dispatch nonce, capturing per-item token usage to `specd_loop_events.jsonl`, and writing a heartbeat to `.specd-loop.status.json`.

**The user can ask you to:**

- *"how's the loop going"* / *"check status"* — run these in order, then summarize:
  - `cat .specd-loop.status.json` for the live state (current item, heartbeat, last error).
  - `tail -n 30 .specd-loop.log` for recent activity.
  - `node .claude/scripts/worklist.js list` for remaining items (call out `⚠SURFACED` items).
  - `claude agents --json | python3 -c "import json,sys; data=json.load(sys.stdin); [print(s['sessionId'][:8], s['status']) for s in data if s.get('kind')=='background' and s.get('cwd')=='$PWD']"` for active workers in this repo.

- *"what did we spend"* / *"what's it cost"* — `tail -n 50 specd_loop_events.jsonl | python3 -c "import json,sys; evs=[json.loads(l) for l in sys.stdin if l.strip()]; print(f'items: {len(evs)}'); print(f'tokens (in/out): {sum(e[\"inputTokens\"] or 0 for e in evs):,} / {sum(e[\"outputTokens\"] or 0 for e in evs):,}'); costs=[e['costUsd'] for e in evs if e.get('costUsd')]; print(f'estimated cost: \${sum(costs):.2f}' if costs else 'cost: (not configured — set SPECD_PRICE_*_IN/OUT env vars)')"`

- *"stop the loop"* — `kill $(node -e "console.log(JSON.parse(require('fs').readFileSync('.specd-loop.pid')).pid)" 2>/dev/null)`. The orchestrator handles SIGTERM cleanly: it releases its claim on the current item and stops the in-flight `claude --bg` session. Workers that have already committed code will land normally; the released item is picked up by the next run.

- *"show surfaced items"* — `node .claude/scripts/worklist.js list` and highlight any `⚠SURFACED`.

- *"any review findings?"* — `node .claude/scripts/review.js pending`. Empty = none.

**Do not edit `specd_work_list.json` or `specd_review.json` by hand.** Always go through the scripts. Tell the user if they ask.

**Env vars worth knowing about:**
- `SPECD_DAILY_BUDGET_USD` / `SPECD_MONTHLY_BUDGET_USD` — halt cleanly when exceeded.
- `SPECD_PRICE_OPUS_IN=15 SPECD_PRICE_OPUS_OUT=75` (etc.) — per-million-token rates per model substring; cost = null without these.
- `SPECD_NOTIFY_CMD` — shell command invoked with `<kind> <message>` on SURFACED, budget exceeded, crash.
- `SPECD_MAX_ITEMS` — outer cap (default 50).
- `SPECD_PER_ITEM_TIMEOUT_MS` — per-item wall-clock kill (default 1800000 = 30min).
