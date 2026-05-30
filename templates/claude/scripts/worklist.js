#!/usr/bin/env node
// worklist.js — deterministic bookkeeping for specd_work_list.json
// Verbs: next | done <id> | fail <id> | release <id> | add | update <id> | remove <id> | validate | list
// All reads/writes go through here. JSON file is the source of truth. No prose.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, lstatSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Validate parsed env ints — silently letting NaN through (parseInt("abc")) caused
// SPECD_ATTEMPTS_CAP=abc to make `attempts >= NaN` always false → items never SURFACE.
function safeInt(str, fallback) {
  const n = parseInt(str, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const WORKLIST = process.env.SPECD_WORKLIST_PATH || resolve(process.cwd(), "specd_work_list.json");
const LOCKFILE = WORKLIST + ".lock";
const SPECS_DIR = process.env.SPECD_SPECS_DIR || resolve(dirname(WORKLIST), "specs");
const REQUIRE_SPEC_FILE = process.env.SPECD_REQUIRE_SPEC_FILE === "1";
const REQUIRE_APPROVAL = process.env.SPECD_REQUIRE_APPROVAL === "1";
const ATTEMPTS_CAP = safeInt(process.env.SPECD_ATTEMPTS_CAP, 2);
const LOCK_TIMEOUT_MS = safeInt(process.env.SPECD_LOCK_TIMEOUT_MS, 10_000);
const LOCK_STALE_MS = safeInt(process.env.SPECD_LOCK_STALE_MS, 30_000);
const CLAIM_STALE_MS = safeInt(process.env.SPECD_CLAIM_STALE_MS, 45 * 60 * 1000);
const TEXT_MAX_BYTES = safeInt(process.env.SPECD_ITEM_TEXT_MAX_BYTES, 4096);
const IN_WORKER = process.env.SPECD_IN_WORKER === "1";

// Workers (Claude sessions spawned by the orchestrator) MUST NOT mutate the worklist.
// The orchestrator sets SPECD_IN_WORKER=1 in the worker's env; we refuse write verbs.
const WRITE_VERBS = new Set(["done", "fail", "release", "add", "update", "remove"]);

function die(msg, code = 1) { process.stderr.write(`worklist: ${msg}\n`); process.exit(code); }

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(LOCKFILE), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCKFILE, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // Stale check: prefer pid liveness when readable; fall back to mtime.
        let stale = false;
        try {
          const heldPid = parseInt(readFileSync(LOCKFILE, "utf-8").trim(), 10);
          if (heldPid && heldPid !== process.pid) {
            try { process.kill(heldPid, 0); } catch (e2) { if (e2.code === "ESRCH") stale = true; }
          }
        } catch {}
        if (!stale) {
          const age = Date.now() - statSync(LOCKFILE).mtimeMs;
          if (age > LOCK_STALE_MS) stale = true;
        }
        if (stale) {
          try { unlinkSync(LOCKFILE); }
          catch (e) { process.stderr.write(`worklist: warning: could not remove stale lockfile (${e.message})\n`); }
          continue;
        }
      } catch {}
      // brief backoff
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 50);
    }
  }
  die(`could not acquire lock ${LOCKFILE} within ${LOCK_TIMEOUT_MS}ms`);
}

function releaseLock() { try { unlinkSync(LOCKFILE); } catch {} }

function withLock(fn) { acquireLock(); try { return fn(); } finally { releaseLock(); } }

function load() {
  if (!existsSync(WORKLIST)) return { items: [] };
  try {
    return JSON.parse(readFileSync(WORKLIST, "utf-8"));
  } catch (e) {
    die(`worklist corrupt at ${WORKLIST}: ${e.message}. Restore from ${WORKLIST}.bak`);
  }
}

function save(state) {
  // Randomized .tmp suffix so an attacker can't pre-create / truncate the temp
  // file to race the rename. Symlink check on .bak ensures we don't follow a
  // symlink into a sensitive file when copying.
  const tmp = WORKLIST + ".tmp." + randomBytes(8).toString("hex");
  mkdirSync(dirname(WORKLIST), { recursive: true });
  if (existsSync(WORKLIST)) {
    const bak = WORKLIST + ".bak";
    try {
      if (existsSync(bak) && lstatSync(bak).isSymbolicLink()) unlinkSync(bak);
    } catch {}
    // Write .bak via wx so symlink replacement attempts fail.
    try {
      const src = readFileSync(WORKLIST);
      if (existsSync(bak)) unlinkSync(bak);
      const fd = openSync(bak, "wx");
      writeFileSync(fd, src);
      closeSync(fd);
    } catch (e) {
      // Non-fatal: bak is best-effort. Log to stderr for visibility.
      process.stderr.write(`worklist: warning: could not refresh .bak: ${e.message}\n`);
    }
  }
  // Write tmp via wx (random suffix means EEXIST is a real race, not normal); rename atomically.
  const fd = openSync(tmp, "wx");
  writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
  closeSync(fd);
  renameSync(tmp, WORKLIST);
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}

function validateSpecName(name) {
  if (!name) die("--spec must be non-empty");
  if (typeof name !== "string") die(`--spec must be a string, got ${typeof name}`);
  if (name.length > 64) die(`--spec name too long (${name.length} > 64)`);
  if (name.includes("/") || name.includes("\\")) die(`--spec cannot contain path separators: ${name}`);
  if (name.includes("..")) die(`--spec cannot contain ..: ${name}`);
  if (name.endsWith(".md")) die(`--spec is a spec name, not a filename — drop the .md: ${name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`--spec must match [A-Za-z0-9][A-Za-z0-9._-]*: ${name}`);
  if (REQUIRE_SPEC_FILE) {
    const path = join(SPECS_DIR, `${name}.md`);
    if (!existsSync(path)) die(`spec file not found: ${path} (disable check with SPECD_REQUIRE_SPEC_FILE=0)`);
    // Also run structural validation via specs.js so worklist items always point at valid specs.
    const specsScript = join(dirname(WORKLIST), ".claude", "scripts", "specs.js");
    if (existsSync(specsScript)) {
      const verb = REQUIRE_APPROVAL ? "gate" : "validate";
      const r = spawnSync("node", [specsScript, verb, name], {
        encoding: "utf-8",
        env: { ...process.env, SPECD_SPECS_DIR: SPECS_DIR },
        cwd: dirname(WORKLIST),
      });
      if (r.status !== 0) {
        die(`spec ${name} fails ${verb}:\n${r.stderr}`);
      }
    }
  }
}

function nextId(state, spec) {
  const existing = state.items.filter(i => i.spec === spec).map(i => {
    const m = i.id.match(/^.+-(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  return `${spec}-${existing.length ? Math.max(...existing) + 1 : 1}`;
}

function claimStale(item) {
  if (!item.in_progress) return false;
  const c = item.in_progress;
  // Future-timestamped claim (clock skew or buggy writer) is stale by default.
  const age = Date.now() - c.startedAt;
  if (!Number.isFinite(age) || age < 0) return true;

  // PID sanity: a worker can't be pid 0, 1 (init), or non-integer. Reject those
  // as inherently stale — they were planted to park items, not produced by a real claim.
  if (typeof c.pid !== "number" || !Number.isFinite(c.pid) || c.pid < 2 || !Number.isInteger(c.pid)) {
    return true;
  }

  // Hostname mismatch: we can't kill(0) check a remote PID, so we can't verify
  // liveness across hosts. The default is to treat foreign-host claims as stale
  // immediately — specd doesn't currently support multi-host orchestration.
  // (If you have a real shared-host setup, raise SPECD_CLAIM_STALE_MS to a value
  // that matches your fleet's expected turn time, and set SPECD_ALLOW_FOREIGN_CLAIMS=1.)
  if (c.hostname !== hostname()) {
    if (process.env.SPECD_ALLOW_FOREIGN_CLAIMS !== "1") return true;
    return age > CLAIM_STALE_MS;
  }

  // Same-host PID liveness: dead PID → stale immediately.
  try { process.kill(c.pid, 0); }
  catch (e) { if (e.code === "ESRCH") return true; }

  return age > CLAIM_STALE_MS;
}

function eligible(item) {
  if ((item.blocked_by || []).length) return false;
  if ((item.attempts || 0) >= ATTEMPTS_CAP) return false;
  if (item.in_progress && !claimStale(item)) return false;
  return true;
}

function findById(state, id) { return state.items.find(i => i.id === id); }

// Strip terminal control characters (C0 + C1 + DEL) so attacker-influenced text
// can't manipulate the operator's terminal when printed by `list`.
function stripControl(s) {
  if (typeof s !== "string") return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

// ─── Verbs ───────────────────────────────────────────────────────────────

const verbs = {
  // `next` atomically claims an item under the lock to prevent two
  // orchestrators picking the same one.
  next(args) {
    let chosen = null;
    withLock(() => {
      const state = load();
      const item = state.items.find(eligible);
      if (!item) return;
      item.in_progress = {
        pid: process.pid,
        hostname: hostname(),
        owner: args.owner || null,
        startedAt: Date.now(),
      };
      save(state);
      chosen = item;
    });
    if (!chosen) process.exit(0); // silent — empty queue
    process.stdout.write(JSON.stringify({ id: chosen.id, spec: chosen.spec, text: chosen.text }) + "\n");
  },

  done(args) {
    const id = args._[0];
    if (!id) die("done requires an id");
    withLock(() => {
      const state = load();
      const before = state.items.length;
      state.items = state.items.filter(i => i.id !== id);
      state.items.forEach(i => {
        if (i.blocked_by) i.blocked_by = i.blocked_by.filter(b => b !== id);
      });
      save(state);
      process.stderr.write(`done ${id} (${before - state.items.length} removed)\n`);
    });
  },

  fail(args) {
    const id = args._[0];
    if (!id) die("fail requires an id");
    withLock(() => {
      const state = load();
      const item = findById(state, id);
      if (!item) { process.stderr.write(`fail: ${id} not found (no-op)\n`); return; }
      item.attempts = (item.attempts || 0) + 1;
      delete item.in_progress;
      save(state);
      const status = item.attempts >= ATTEMPTS_CAP ? "SURFACED" : "retry";
      process.stderr.write(`fail ${id} attempts=${item.attempts} (${status})\n`);
    });
  },

  // Release a claim without counting an attempt (clean shutdown).
  release(args) {
    const id = args._[0];
    if (!id) die("release requires an id");
    withLock(() => {
      const state = load();
      const item = findById(state, id);
      if (!item) { process.stderr.write(`release: ${id} not found (no-op)\n`); return; }
      delete item.in_progress;
      save(state);
      process.stderr.write(`released ${id}\n`);
    });
  },

  add(args) {
    if (!args.spec) die("add requires --spec");
    validateSpecName(args.spec);
    if (!args.text) die("add requires --text");
    if (typeof args.text !== "string") die("--text must be a string value");
    if (args.text.length > TEXT_MAX_BYTES) die(`--text too long (${args.text.length} > ${TEXT_MAX_BYTES} bytes)`);
    withLock(() => {
      const state = load();
      const blockedBy = args["blocked-by"]
        ? String(args["blocked-by"]).split(",").map(s => s.trim()).filter(Boolean)
        : [];
      for (const b of blockedBy) {
        if (!findById(state, b)) die(`unknown blocker id: ${b} (add the blocking item first)`);
      }
      const id = nextId(state, args.spec);
      state.items.push({
        id, spec: args.spec, text: args.text,
        blocked_by: blockedBy, attempts: 0,
      });
      save(state);
      process.stdout.write(id + "\n");
    });
  },

  update(args) {
    const id = args._[0];
    if (!id) die("update requires an id");
    withLock(() => {
      const state = load();
      const item = findById(state, id);
      if (!item) die(`unknown id: ${id}`);
      if (args.text !== undefined) {
        if (typeof args.text !== "string") die("--text must be a string");
        if (args.text.length > TEXT_MAX_BYTES) die(`--text too long (${args.text.length} > ${TEXT_MAX_BYTES} bytes)`);
        item.text = args.text;
      }
      if (args["blocked-by"] !== undefined) {
        const blockedBy = String(args["blocked-by"]).split(",").map(s => s.trim()).filter(Boolean);
        for (const b of blockedBy) {
          if (!findById(state, b)) die(`unknown blocker id: ${b}`);
          if (b === id) die(`item cannot block itself: ${id}`);
        }
        item.blocked_by = blockedBy;
      }
      save(state);
      process.stderr.write(`updated ${id}\n`);
    });
  },

  remove(args) {
    const id = args._[0];
    if (!id) die("remove requires an id");
    withLock(() => {
      const state = load();
      const item = findById(state, id);
      if (!item) { process.stderr.write(`remove: ${id} not found (no-op)\n`); return; }
      const referrers = state.items.filter(i => (i.blocked_by || []).includes(id) && i.id !== id);
      if (referrers.length && !args.force) {
        die(`remove: ${referrers.length} item(s) still reference ${id} as a blocker: ` +
          referrers.map(r => r.id).join(", ") +
          `. Use --force to remove anyway (will silently unblock them).`);
      }
      state.items = state.items.filter(i => i.id !== id);
      state.items.forEach(i => {
        if (i.blocked_by) i.blocked_by = i.blocked_by.filter(b => b !== id);
      });
      save(state);
      process.stderr.write(`removed ${id}\n`);
    });
  },

  validate() {
    const state = load();
    const ids = new Set(state.items.map(i => i.id));
    const errors = [];
    if (ids.size !== state.items.length) errors.push("duplicate ids in worklist");
    for (const item of state.items) {
      try { validateSpecName(item.spec); } catch (e) { errors.push(`${item.id}: ${e.message || e}`); }
      for (const b of item.blocked_by || []) {
        if (!ids.has(b)) errors.push(`${item.id}: unknown blocker ${b}`);
      }
    }
    // cycle detection (DFS)
    const visiting = new Set(), visited = new Set();
    function visit(id, path) {
      if (visited.has(id)) return;
      if (visiting.has(id)) { errors.push(`cycle: ${[...path, id].join(" → ")}`); return; }
      visiting.add(id);
      const item = state.items.find(i => i.id === id);
      for (const b of (item?.blocked_by || [])) visit(b, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    }
    for (const item of state.items) visit(item.id, []);
    if (errors.length) { errors.forEach(e => process.stderr.write(e + "\n")); process.exit(1); }
    process.stderr.write(`ok: ${state.items.length} items, ${ids.size} unique ids\n`);
  },

  list(args) {
    const state = load();
    const items = args.spec ? state.items.filter(i => i.spec === args.spec) : state.items;
    if (!items.length) { process.stderr.write("(empty)\n"); return; }
    const bySpec = {};
    for (const i of items) (bySpec[i.spec] ||= []).push(i);
    for (const spec of Object.keys(bySpec).sort()) {
      process.stdout.write(`\n${spec}:\n`);
      for (const i of bySpec[spec]) {
        const tags = [];
        if ((i.blocked_by || []).length) tags.push(`blocked: ${i.blocked_by.join(",")}`);
        if (i.attempts) tags.push(`attempts=${i.attempts}${i.attempts >= ATTEMPTS_CAP ? " ⚠SURFACED" : ""}`);
        if (i.in_progress) {
          const age = Math.floor((Date.now() - i.in_progress.startedAt) / 1000);
          tags.push(`in_progress pid=${i.in_progress.pid} age=${age}s${claimStale(i) ? " ⚠STALE" : ""}`);
        }
        const tagStr = tags.length ? ` (${tags.join("; ")})` : "";
        // Strip control chars (ANSI escapes, NULs, etc.) so a worker-injected
        // `\x1b[2J` can't clear the operator's terminal or fake a green check.
        process.stdout.write(`  [${i.id}] ${stripControl(i.text)}${tagStr}\n`);
      }
    }
    process.stdout.write("\n");
  },
};

// ─── Dispatch ────────────────────────────────────────────────────────────

const [, , verb, ...rest] = process.argv;
if (!verb || !verbs[verb]) {
  process.stderr.write(`usage: worklist.js <next|done|fail|release|add|update|remove|validate|list> [args]\n`);
  process.exit(2);
}

// Workers (SPECD_IN_WORKER=1) must not mutate the worklist. Read verbs are fine.
if (IN_WORKER && WRITE_VERBS.has(verb)) {
  die(`refusing ${verb} inside a worker session (SPECD_IN_WORKER=1). Only the orchestrator may mutate the worklist.`);
}

verbs[verb](parseFlags(rest));
