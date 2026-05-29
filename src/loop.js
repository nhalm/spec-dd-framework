// specd loop subcommand: start | stop | status | cost | logs | run-once
//
// Delegates the heavy lifting to the orchestrator template
// (.claude/scripts/specd-loop.mjs) installed in the target project. This module
// is the CLI wrapper: process management, status reading, log tailing, cost
// summarization.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000),
    m = Math.floor(s / 60),
    h = Math.floor(m / 60);
  if (h) return `${h}h${m % 60}m`;
  if (m) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function readEvents(eventsFile) {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, "utf-8"));
  } catch (e) {
    return { __corrupt: true, error: e.message };
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Identity check: confirm the live pid actually belongs to the orchestrator before signaling.
// Defeats the "specd-loop stop becomes SIGTERM-arbitrary-pid primitive" attack.
function pidLooksLikeOrchestrator(pid) {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" });
  if (r.status !== 0) return false;
  const cmd = (r.stdout || "").trim();
  return cmd.includes("specd-loop.mjs") || cmd.includes("specd loop");
}

function paths(targetDir) {
  return {
    script: join(targetDir, ".claude", "scripts", "specd-loop.mjs"),
    pid: join(targetDir, ".specd-loop.pid"),
    status: join(targetDir, ".specd-loop.status.json"),
    log: join(targetDir, ".specd-loop.log"),
    events: join(targetDir, "specd_loop_events.jsonl"),
  };
}

const LOG_ROTATE_BYTES = parseInt(
  process.env.SPECD_LOG_ROTATE_BYTES || (10 * 1024 * 1024).toString(),
  10,
);

function rotateLogIfNeeded(logPath) {
  try {
    if (!existsSync(logPath)) return;
    if (statSync(logPath).size < LOG_ROTATE_BYTES) return;
    if (existsSync(logPath + ".1")) unlinkSync(logPath + ".1");
    renameSync(logPath, logPath + ".1");
  } catch (e) {
    process.stderr.write(`log rotate failed: ${e.message}\n`);
  }
}

export function start(targetDir, args = {}) {
  const p = paths(targetDir);
  if (!existsSync(p.script)) {
    process.stderr.write(
      `orchestrator script not found at ${p.script}\nRun 'specd init' or 'specd update' first.\n`,
    );
    process.exit(1);
  }
  const existing = readPid(p.pid);
  if (existing && !existing.__corrupt && existing.pid && pidAlive(existing.pid)) {
    process.stderr.write(
      `already running: pid ${existing.pid} (since ${existing.startedAt}). Use 'specd loop stop' first.\n`,
    );
    process.exit(1);
  }
  if (existing && existing.__corrupt) {
    process.stderr.write(`(pid file corrupt: ${existing.error} — removing and starting)\n`);
    try {
      unlinkSync(p.pid);
    } catch {
      /* best effort */
    }
  }
  // Rotate the log BEFORE the wrapper opens the fd (otherwise the orchestrator's own
  // rotate-on-startup follows the inode into .log.1 and the wrapper's fd silently appends there).
  rotateLogIfNeeded(p.log);

  const scriptArgs = [];
  // (foreground/background is handled below; nothing to push for it here)
  if (args.once) scriptArgs.push("--once");
  if (args.dryRun) scriptArgs.push("--dry-run");
  if (args.skipAudit) scriptArgs.push("--skip-audit");

  if (args.foreground) {
    const r = spawnSync("node", [p.script, ...scriptArgs], { stdio: "inherit", cwd: targetDir });
    process.exit(r.status ?? 0);
  }

  const out = openSync(p.log, "a");
  const child = spawn("node", [p.script, ...scriptArgs], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: targetDir,
  });
  child.unref();
  process.stdout.write(`started pid ${child.pid} (logs: ${p.log})\n`);
}

export function status(targetDir) {
  const p = paths(targetDir);
  const pid = readPid(p.pid);
  if (!pid) {
    process.stdout.write(`(not running — no pid file)\n`);
    return;
  }
  if (pid.__corrupt) {
    process.stdout.write(`(pid file corrupt: ${pid.error})\n`);
    return;
  }
  if (!pid.pid) {
    process.stdout.write(`(pid file present but missing pid field)\n`);
    return;
  }
  const alive = pidAlive(pid.pid);
  process.stdout.write(`pid ${pid.pid}${alive ? "" : " (NOT ALIVE — stale pid file)"}\n`);
  process.stdout.write(`started: ${pid.startedAt}\n`);
  process.stdout.write(`cwd:     ${pid.cwd}\n`);
  process.stdout.write(`host:    ${pid.hostname}\n`);
  if (existsSync(p.status)) {
    try {
      const s = JSON.parse(readFileSync(p.status, "utf-8"));
      process.stdout.write(`\nstatus:  ${s.state || "?"}\n`);
      if (s.cycle) process.stdout.write(`cycle:   ${s.cycle}\n`);
      if (s.lastHeartbeat) {
        const age = Date.now() - new Date(s.lastHeartbeat).getTime();
        process.stdout.write(`heartbeat: ${s.lastHeartbeat} (${fmtDuration(age)} ago)\n`);
      }
      if (s.currentItem) {
        process.stdout.write(
          `\ncurrent item:\n  ${s.currentItem.id} [${s.currentItem.spec}] ${s.currentItem.text?.slice(0, 80) || ""}\n`,
        );
      }
      if (s.currentSession) {
        process.stdout.write(
          `\nactive session: ${s.currentSession.id?.slice(0, 8)} (dispatched ${s.currentSession.dispatchedAt})\n`,
        );
      }
      if (s.lastError) process.stdout.write(`\nlast error: ${s.lastError}\n`);
    } catch (e) {
      process.stdout.write(`(status file unreadable: ${e.message})\n`);
    }
  }
}

export function stop(targetDir) {
  const p = paths(targetDir);
  const pid = readPid(p.pid);
  if (!pid) {
    process.stderr.write(`not running (no pid file)\n`);
    process.exit(1);
  }
  if (pid.__corrupt) {
    process.stderr.write(
      `pid file corrupt (${pid.error}); remove manually if you know what you're doing\n`,
    );
    process.exit(1);
  }
  if (!pid.pid) {
    process.stderr.write(`pid file present but missing pid field\n`);
    process.exit(1);
  }
  if (!pidAlive(pid.pid)) {
    process.stderr.write(`stale pid file: pid ${pid.pid} is not alive — cleaning up.\n`);
    try {
      unlinkSync(p.pid);
    } catch {
      /* best effort */
    }
    return;
  }
  if (!pidLooksLikeOrchestrator(pid.pid)) {
    process.stderr.write(
      `pid ${pid.pid} is alive but does not look like a specd-loop orchestrator (command line check failed). ` +
        `Refusing to signal. If you're sure, kill ${pid.pid} manually.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`sending SIGTERM to ${pid.pid}…\n`);
  try {
    process.kill(pid.pid, "SIGTERM");
  } catch (e) {
    process.stderr.write(`could not signal: ${e.message}\n`);
    process.exit(1);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid.pid)) {
      process.stdout.write(`stopped\n`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  process.stdout.write(`still alive after 10s — use 'kill -9 ${pid.pid}' if needed.\n`);
  return;
}

export function cost(targetDir, { today = false } = {}) {
  const p = paths(targetDir);
  const events = readEvents(p.events);
  if (!events.length) {
    process.stdout.write(`(no events yet — ${p.events} is empty or missing)\n`);
    return;
  }
  const now = new Date();
  const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const filtered = today ? events.filter((e) => e.finishedAt >= todayIso) : events;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sum = (k) => filtered.reduce((a, e) => a + num(e[k]), 0);

  const byModel = {},
    byVerdict = {};
  let totalCost = 0,
    totalCostMonth = 0;
  for (const e of filtered) {
    const m = e.model || "unknown";
    byModel[m] = (byModel[m] || 0) + 1;
    const v = e.verdictStatus || "unknown";
    byVerdict[v] = (byVerdict[v] || 0) + 1;
    totalCost += num(e.costUsd);
  }
  for (const e of events) {
    if (e.finishedAt >= monthIso) totalCostMonth += num(e.costUsd);
  }

  process.stdout.write(`items:           ${filtered.length}${today ? " (today)" : ""}\n`);
  process.stdout.write(
    `tokens in/out:   ${sum("inputTokens").toLocaleString()} / ${sum("outputTokens").toLocaleString()}\n`,
  );
  process.stdout.write(`cache read:      ${sum("cacheReadTokens").toLocaleString()}\n`);
  process.stdout.write(`cache create:    ${sum("cacheCreationTokens").toLocaleString()}\n`);
  process.stdout.write(`assistant msgs:  ${sum("numAssistantMessages").toLocaleString()}\n`);
  process.stdout.write(`total duration:  ${fmtDuration(sum("durationMs"))}\n`);
  process.stdout.write(`\ncost${today ? " today" : " (all logged)"}:  $${totalCost.toFixed(4)}\n`);
  if (!today) process.stdout.write(`cost this month: $${totalCostMonth.toFixed(4)}\n`);
  if (!totalCost) {
    process.stdout.write(
      `\n(cost is null — set SPECD_PRICE_<MODEL>_IN/OUT env vars to enable cost estimation)\n`,
    );
  }
  process.stdout.write(`\nby model:\n`);
  for (const [m, c] of Object.entries(byModel)) process.stdout.write(`  ${m}: ${c}\n`);
  process.stdout.write(`\nby verdict:\n`);
  for (const [v, c] of Object.entries(byVerdict)) process.stdout.write(`  ${v}: ${c}\n`);
}

export function logs(targetDir, { tail = 30, follow = false } = {}) {
  const p = paths(targetDir);
  if (!existsSync(p.log)) {
    process.stdout.write(`(no log at ${p.log})\n`);
    return;
  }
  let n = parseInt(tail, 10);
  if (!Number.isFinite(n) || n < 0) n = 30;
  if (n > 100_000) n = 100_000;
  const args = follow ? ["-n", String(n), "-f", p.log] : ["-n", String(n), p.log];
  if (follow) {
    const r = spawnSync("tail", args, { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  const r = spawnSync("tail", args, { encoding: "utf-8" });
  process.stdout.write(r.stdout);
}
