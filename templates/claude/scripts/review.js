#!/usr/bin/env node
// review.js — deterministic bookkeeping for specd_review.json
// Verbs: add | list | pending | decide <id> "<text>" | undecide <id> | resolve <id> | validate
// Mirrors worklist.js patterns: atomic writes, lockfile, structured JSON.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const REVIEW = process.env.SPECD_REVIEW_PATH || resolve(process.cwd(), "specd_review.json");
const LOCKFILE = REVIEW + ".lock";
const LOCK_TIMEOUT_MS = parseInt(process.env.SPECD_LOCK_TIMEOUT_MS || "10000", 10);
const LOCK_STALE_MS = parseInt(process.env.SPECD_LOCK_STALE_MS || "30000", 10);

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
      // Stale check: prefer pid liveness when readable; fall back to mtime.
      // Mirrors the worklist.js Round-1 logic so DoS via planted lockfile is consistent.
      try {
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
          catch (e3) { process.stderr.write(`review: warning: could not remove stale lockfile (${e3.message})\n`); }
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  die(`could not acquire lock ${LOCKFILE}`);
}

function releaseLock() { try { unlinkSync(LOCKFILE); } catch {} }

function withLock(fn) { acquireLock(); try { return fn(); } finally { releaseLock(); } }

function load() {
  if (!existsSync(REVIEW)) return { findings: [] };
  try { return JSON.parse(readFileSync(REVIEW, "utf-8")); }
  catch (e) { die(`review corrupt at ${REVIEW}: ${e.message}. Restore from ${REVIEW}.bak`); }
}

function save(state) {
  const tmp = REVIEW + ".tmp." + randomBytes(8).toString("hex");
  mkdirSync(dirname(REVIEW), { recursive: true });
  if (existsSync(REVIEW)) {
    const bak = REVIEW + ".bak";
    try { if (existsSync(bak) && lstatSync(bak).isSymbolicLink()) unlinkSync(bak); } catch {}
    try {
      const src = readFileSync(REVIEW);
      if (existsSync(bak)) unlinkSync(bak);
      const fd = openSync(bak, "wx");
      writeFileSync(fd, src);
      closeSync(fd);
    } catch (e) {
      process.stderr.write(`review: warning: could not refresh .bak: ${e.message}\n`);
    }
  }
  const fd = openSync(tmp, "wx");
  writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
  closeSync(fd);
  renameSync(tmp, REVIEW);
}

function die(msg, code = 1) { process.stderr.write(`review: ${msg}\n`); process.exit(code); }

function validateSpecName(name) {
  if (!name) die("--spec must be non-empty");
  if (typeof name !== "string") die(`--spec must be a string, got ${typeof name}`);
  if (name.length > 64) die(`--spec too long (${name.length} > 64)`);
  if (name.includes("/") || name.includes("\\")) die(`--spec cannot contain path separators: ${name}`);
  if (name.includes("..")) die(`--spec cannot contain ..: ${name}`);
  if (name.endsWith(".md")) die(`--spec is a name, not a filename — drop the .md: ${name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`--spec must match [A-Za-z0-9][A-Za-z0-9._-]*: ${name}`);
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else if (k === "option") { (out.options ||= []).push(v); i++; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}

function nextId(state, spec) {
  const existing = state.findings.filter(f => f.spec === spec).map(f => {
    const m = f.id.match(/^.+-r(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  return `${spec}-r${existing.length ? Math.max(...existing) + 1 : 1}`;
}

function findById(state, id) { return state.findings.find(f => f.id === id); }

// ─── Verbs ───────────────────────────────────────────────────────────────

const verbs = {
  add(args) {
    if (!args.spec) die("add requires --spec");
    validateSpecName(args.spec);
    if (!args.finding) die("add requires --finding");
    if (typeof args.finding !== "string") die("--finding must be a string");
    withLock(() => {
      const state = load();
      const id = nextId(state, args.spec);
      state.findings.push({
        id, spec: args.spec, status: "pending",
        finding: args.finding,
        code: args.code || null,
        spec_says: args["spec-says"] || null,
        options: args.options || [],
        recommendation: args.recommendation || null,
        decision: null,
      });
      save(state);
      process.stdout.write(id + "\n");
    });
  },

  list(args) {
    const state = load();
    const filtered = args.spec ? state.findings.filter(f => f.spec === args.spec) : state.findings;
    if (!filtered.length) { process.stderr.write("(empty)\n"); return; }
    for (const f of filtered) {
      const tag = f.status === "pending" ? "⏳" : f.status === "decided" ? "✅" : "·";
      process.stdout.write(`\n${tag} [${f.id}] (${f.spec})\n`);
      process.stdout.write(`  Finding: ${f.finding}\n`);
      if (f.code) process.stdout.write(`  Code: ${f.code}\n`);
      if (f.spec_says) process.stdout.write(`  Spec: ${f.spec_says}\n`);
      if (f.options?.length) {
        process.stdout.write(`  Options:\n`);
        f.options.forEach(o => process.stdout.write(`    - ${o}\n`));
      }
      if (f.recommendation) process.stdout.write(`  Recommendation: ${f.recommendation}\n`);
      if (f.decision) process.stdout.write(`  Decision: ${f.decision}\n`);
    }
    process.stdout.write("\n");
  },

  pending() {
    const state = load();
    const pending = state.findings.filter(f => f.status === "pending");
    if (!pending.length) process.exit(0); // silent — none pending
    for (const f of pending) {
      process.stdout.write(JSON.stringify({ id: f.id, spec: f.spec, finding: f.finding }) + "\n");
    }
  },

  decide(args) {
    const id = args._[0];
    const text = args._[1];
    if (!id) die("decide requires an id");
    if (text === undefined) die("decide requires a decision string");
    withLock(() => {
      const state = load();
      const f = findById(state, id);
      if (!f) die(`unknown id: ${id}`);
      f.decision = String(text);
      f.status = "decided";
      save(state);
      process.stderr.write(`decided ${id}\n`);
    });
  },

  undecide(args) {
    const id = args._[0];
    if (!id) die("undecide requires an id");
    withLock(() => {
      const state = load();
      const f = findById(state, id);
      if (!f) die(`unknown id: ${id}`);
      f.decision = null;
      f.status = "pending";
      save(state);
      process.stderr.write(`reverted ${id} to pending\n`);
    });
  },

  resolve(args) {
    const id = args._[0];
    if (!id) die("resolve requires an id");
    withLock(() => {
      const state = load();
      const before = state.findings.length;
      state.findings = state.findings.filter(f => f.id !== id);
      save(state);
      process.stderr.write(`resolved ${id} (${before - state.findings.length} removed)\n`);
    });
  },

  validate() {
    const state = load();
    const ids = new Set(state.findings.map(f => f.id));
    if (ids.size !== state.findings.length) die("duplicate ids in review state");
    for (const f of state.findings) {
      if (!["pending", "decided"].includes(f.status)) die(`${f.id}: invalid status ${f.status}`);
      if (f.status === "decided" && !f.decision) die(`${f.id}: decided but no decision text`);
    }
    process.stderr.write(`ok: ${state.findings.length} findings\n`);
  },
};

// ─── Dispatch ────────────────────────────────────────────────────────────

const [, , verb, ...rest] = process.argv;
if (!verb || !verbs[verb]) {
  process.stderr.write(`usage: review.js <add|list|pending|decide|undecide|resolve|validate> [args]\n`);
  process.exit(2);
}
verbs[verb](parseFlags(rest));
