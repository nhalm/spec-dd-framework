#!/usr/bin/env node
// specs.js — strict spec format parser, structural validator, executable test runner,
// and LLM-as-judge content reviewer.
//
// Spec format (specs/<name>.md):
//   # <title>
//   ## Overview
//   <one paragraph>
//   ## Specification
//   ### Behavior 1 — <short title>
//   **Description:** <one sentence>
//   **Test:**
//   - run: <shell command>
//   - stdin: <optional>
//   - stdout: <optional exact match>
//   - stdout_contains: <optional substring>
//   - stderr: <optional>
//   - stderr_contains: <optional>
//   - exit: <integer>
//   **Example:** <optional human-readable>
//   ### Behavior 2 — ...
//   ## Constraints (optional)
//
// Verbs: validate <name> | test <name> [--behavior N] | review <name> | outline <name> | list

import {
  readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync,
  chmodSync, lstatSync, openSync, closeSync, renameSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

const SPECS_DIR = process.env.SPECD_SPECS_DIR || resolve(process.cwd(), "specs");
const APPROVALS_DIR = process.env.SPECD_APPROVALS_DIR || resolve(dirname(SPECS_DIR), ".specd-approvals");
const TEST_TIMEOUT_MS = safeInt(process.env.SPECD_TEST_TIMEOUT_MS, 30000);
const REVIEW_TIMEOUT_MS = safeInt(process.env.SPECD_REVIEW_TIMEOUT_MS, 5 * 60 * 1000);
const SPEC_MAX_BYTES = safeInt(process.env.SPECD_SPEC_MAX_BYTES, 256 * 1024);
const IN_WORKER = process.env.SPECD_IN_WORKER === "1";

// Validate parsed env ints — silently letting NaN through (parseInt("abc")) caused
// SPECD_ATTEMPTS_CAP=abc to make every comparison false → items never SURFACE.
function safeInt(str, fallback) {
  const n = parseInt(str, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ─── Approval markers (HMAC-signed) ─────────────────────────────────────
//
// The threat: a worker can write a `.specd-approvals/<name>.json` with the spec's
// sha256 and `verdict: "pass"`, bypassing the planning gate. To stop this we MAC
// the marker with a per-machine key stored OUTSIDE the repo, in the user's config
// dir (chmod 600). The worker runs in the project tree; it doesn't see the key
// unless it climbs out to ~/.config/specd/, which the hard-rule prompt forbids
// and which a properly sandboxed worker can't reach at all.

const HMAC_KEY_PATH = process.env.SPECD_HMAC_KEY_PATH || join(homedir(), ".config", "specd", "approval-key");

function loadOrCreateKey() {
  // Refuse to follow a symlink — an attacker could plant the symlink before
  // first run to either (a) point the read at their own key file or (b) cause
  // writeFileSync to follow it and overwrite an arbitrary file with 32 random
  // bytes.
  if (existsSync(HMAC_KEY_PATH)) {
    try {
      if (lstatSync(HMAC_KEY_PATH).isSymbolicLink()) {
        die(`refusing to use HMAC key at ${HMAC_KEY_PATH}: file is a symlink. Remove it and re-run specs.js review.`);
      }
    } catch (e) {
      die(`could not stat HMAC key at ${HMAC_KEY_PATH}: ${e.message}`);
    }
    return readFileSync(HMAC_KEY_PATH);
  }
  // Create with O_EXCL so a TOCTOU symlink planted between existsSync and openSync fails.
  mkdirSync(dirname(HMAC_KEY_PATH), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  const fd = openSync(HMAC_KEY_PATH, "wx", 0o600);
  writeFileSync(fd, key);
  closeSync(fd);
  try { chmodSync(HMAC_KEY_PATH, 0o600); } catch {}
  return key;
}

// Canonical JSON: sort top-level keys so the signed bytes don't depend on
// insertion order. (Node guarantees insertion order for string keys today, but
// the prior round's review flagged this as forward-compat fragility.)
function canonicalize(obj) {
  if (obj === null) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function signApproval(payload) {
  const key = loadOrCreateKey();
  return createHmac("sha256", key).update(canonicalize(payload)).digest("hex");
}

function verifyApproval(payload, sig) {
  if (!sig || typeof sig !== "string") return false;
  const key = loadOrCreateKey();
  const expected = createHmac("sha256", key).update(canonicalize(payload)).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch { return false; }
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function approvalPath(name) { return join(APPROVALS_DIR, `${name}.json`); }

export function readApproval(name) {
  const p = approvalPath(name);
  if (!existsSync(p)) return null;
  let raw;
  try { raw = readFileSync(p, "utf-8"); }
  catch (e) { die(`approval marker for ${name} unreadable: ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) { die(`approval marker for ${name} is not valid JSON: ${e.message}`); }
}

function writeApproval(name, payload) {
  mkdirSync(APPROVALS_DIR, { recursive: true });
  const sig = signApproval(payload);
  const wrapped = { ...payload, sig };
  const target = approvalPath(name);
  // Symlink-resistant atomic write — same pattern as the worklist .tmp/.bak.
  const tmp = target + ".tmp." + randomBytes(8).toString("hex");
  try {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) unlinkSync(target);
  } catch {}
  const fd = openSync(tmp, "wx");
  writeFileSync(fd, JSON.stringify(wrapped, null, 2) + "\n");
  closeSync(fd);
  renameSync(tmp, target);
}

function clearApproval(name) {
  const p = approvalPath(name);
  try { unlinkSync(p); } catch {}
}

// Returns { approved: true } or { approved: false, reason }.
export function checkApproval(name, specText) {
  const a = readApproval(name);
  if (!a) return { approved: false, reason: `no approval marker for ${name}; run \`specs.js review ${name}\`` };
  if (!a.sig) return { approved: false, reason: `approval marker for ${name} is missing its signature (legacy or forged)` };
  // Name-binding: the marker must be for THIS spec. Otherwise a worker can copy a
  // legitimately-signed marker for spec A to .specd-approvals/B.json and gate B.
  if (a.spec !== name) {
    return { approved: false, reason: `approval marker is for "${a.spec}", not "${name}" — refusing cross-spec replay` };
  }
  // Reconstruct the payload that was signed (everything except the signature).
  const { sig, ...payload } = a;
  if (!verifyApproval(payload, sig)) {
    return { approved: false, reason: `approval marker for ${name} has an invalid signature — likely forged or the HMAC key changed` };
  }
  const current = contentHash(specText);
  if (a.content_hash !== current) {
    return { approved: false, reason: `spec ${name} has changed since last approval; re-run \`specs.js review ${name}\`` };
  }
  if (a.verdict !== "pass") return { approved: false, reason: `last review of ${name} returned ${a.verdict}: ${(a.issues || []).join("; ")}` };
  return { approved: true, approval: a };
}

function die(msg, code = 1) { process.stderr.write(`specs: ${msg}\n`); process.exit(code); }

// ─── Parser ──────────────────────────────────────────────────────────────

export function parseSpec(text) {
  const lines = text.split("\n");
  const spec = { title: null, overview: "", behaviors: [], constraints: "", errors: [] };

  let section = null;        // "overview" | "specification" | "constraints" | null
  let behavior = null;       // current behavior object
  let testBlockLines = null; // accumulating test sub-list
  let pendingField = null;   // collecting a multi-line bold field
  let inFence = false;       // ``` fenced code block — skip header detection inside

  const flushBehavior = () => {
    if (!behavior) return;
    if (testBlockLines) { behavior.test = parseTestBlock(testBlockLines, behavior, spec); testBlockLines = null; }
    spec.behaviors.push(behavior);
    behavior = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Toggle fence state. Inside a fence we don't parse headers/behaviors so
    // documentation examples don't accidentally execute.
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // Top-level title
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      spec.title = line.slice(2).trim();
      continue;
    }

    // Section headers
    if (line.startsWith("## Overview")) { flushBehavior(); section = "overview"; continue; }
    if (line.startsWith("## Specification")) { flushBehavior(); section = "specification"; continue; }
    if (line.startsWith("## Constraints")) { flushBehavior(); section = "constraints"; continue; }
    if (line.startsWith("## ")) { flushBehavior(); section = null; continue; }

    // Behavior headers — strict: id must be a positive integer without leading zero,
    // and must be on its own line at column 0 (already guaranteed by markdown).
    const bm = line.match(/^###\s+Behavior\s+([1-9]\d*)\s*[—–-]\s*(.+?)\s*$/i);
    if (bm) {
      flushBehavior();
      if (section !== "specification") {
        spec.errors.push(`line ${i + 1}: ### Behavior found outside ## Specification section`);
      }
      behavior = { id: parseInt(bm[1], 10), title: bm[2].trim(), description: null, test: null, example: null };
      continue;
    }

    // Inside a behavior: look for **Description:**, **Test:**, **Example:**
    if (behavior && line.match(/^\*\*Description:\*\*/i)) {
      if (behavior.description !== null) {
        spec.errors.push(`Behavior ${behavior.id}: duplicate **Description:** block`);
      }
      const inline = line.replace(/^\*\*Description:\*\*\s*/i, "").trim();
      behavior.description = inline;
      pendingField = "description"; testBlockLines = null;
      continue;
    }
    if (behavior && line.match(/^\*\*Test:\*\*/i)) {
      if (behavior.test !== null || testBlockLines !== null) {
        spec.errors.push(`Behavior ${behavior.id}: duplicate **Test:** block (only one Test per behavior)`);
      }
      testBlockLines = [];
      pendingField = "test";
      continue;
    }
    if (behavior && line.match(/^\*\*Example:\*\*/i)) {
      if (behavior.example !== null) {
        spec.errors.push(`Behavior ${behavior.id}: duplicate **Example:** block`);
      }
      behavior.example = line.replace(/^\*\*Example:\*\*\s*/i, "").trim();
      pendingField = "example"; testBlockLines = null;
      continue;
    }

    // Continuation lines for the current field
    if (pendingField === "test" && testBlockLines !== null) {
      // Test block: collect sub-list lines (starting with `-` or 2-space indent), stop on blank or non-list
      if (line.match(/^\s*-\s+/) || line.match(/^\s{2,}/)) {
        testBlockLines.push(line);
        continue;
      }
      if (line.trim() === "") {
        // End of test block
        behavior.test = parseTestBlock(testBlockLines, behavior, spec);
        testBlockLines = null;
        pendingField = null;
        continue;
      }
      // Non-list, non-blank — end of test block too
      behavior.test = parseTestBlock(testBlockLines, behavior, spec);
      testBlockLines = null;
      pendingField = null;
      // fall through to consider this line
    }

    if (pendingField === "description" && behavior && line.trim() !== "" && !line.startsWith("**")) {
      // Multi-line description — append.
      behavior.description = (behavior.description + " " + line.trim()).trim();
      continue;
    }
    if (pendingField === "description" && line.trim() === "") {
      pendingField = null;
      continue;
    }

    // Accumulate section bodies
    if (section === "overview" && !behavior) spec.overview += line + "\n";
    if (section === "constraints" && !behavior) spec.constraints += line + "\n";
  }
  flushBehavior();

  spec.overview = spec.overview.trim();
  spec.constraints = spec.constraints.trim();
  return spec;
}

function parseTestBlock(lines, behavior, spec) {
  // Each list item is "- key: value" possibly with multi-line value continuations.
  const test = {};
  let currentKey = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*-\s+([a-z_]+)\s*:\s*(.*)$/i);
    if (m) {
      currentKey = m[1].toLowerCase();
      test[currentKey] = m[2];
    } else if (currentKey && raw.trim() !== "") {
      test[currentKey] = (test[currentKey] + "\n" + raw.trim()).trim();
    }
  }
  // Strip surrounding backticks/quotes from common fields.
  for (const k of ["run", "stdout", "stderr", "stdout_contains", "stderr_contains", "stdin"]) {
    if (typeof test[k] === "string") {
      test[k] = unquote(test[k]);
    }
  }
  // Empty *_contains matches everything by accident — reject (treat as undefined).
  if (test.stdout_contains === "") delete test.stdout_contains;
  if (test.stderr_contains === "") delete test.stderr_contains;
  if (test.exit !== undefined) {
    const n = parseInt(String(test.exit), 10);
    test.exit = Number.isFinite(n) ? n : null;
  }
  return test;
}

function unquote(s) {
  s = s.trim();
  // Require >= 2 chars so a single-char quote (`"`) doesn't collapse to "".
  if (s.length < 2) return s;
  if ((s.startsWith("`") && s.endsWith("`")) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  }
  return s;
}

// ─── Validator ──────────────────────────────────────────────────────────

export function validateSpec(spec) {
  const errors = [...(spec.errors || [])];
  if (!spec.title) errors.push("missing top-level title (# ...)");
  if (!spec.overview) errors.push("missing or empty ## Overview section");
  if (!spec.behaviors.length) errors.push("missing ### Behavior N entries under ## Specification");

  const seenIds = new Set();
  for (let i = 0; i < spec.behaviors.length; i++) {
    const b = spec.behaviors[i];
    const expected = i + 1;
    if (b.id !== expected) errors.push(`Behavior ${b.id}: expected sequential id ${expected}`);
    if (seenIds.has(b.id)) errors.push(`Behavior ${b.id}: duplicate id`);
    seenIds.add(b.id);
    if (!b.title) errors.push(`Behavior ${b.id}: missing title`);
    if (!b.description) errors.push(`Behavior ${b.id}: missing **Description:**`);
    else if (b.description.length > 280) errors.push(`Behavior ${b.id}: Description too long (${b.description.length} > 280 chars; aim for one sentence)`);
    if (!b.test) errors.push(`Behavior ${b.id}: missing **Test:**`);
    else {
      if (!b.test.run) errors.push(`Behavior ${b.id}: Test missing 'run:' command`);
      if (b.test.exit === undefined || b.test.exit === null) errors.push(`Behavior ${b.id}: Test missing 'exit:' integer`);
      const hasOutcome = b.test.stdout !== undefined || b.test.stdout_contains !== undefined ||
                         b.test.stderr !== undefined || b.test.stderr_contains !== undefined;
      if (!hasOutcome && (b.test.exit === undefined)) {
        errors.push(`Behavior ${b.id}: Test must specify at least one of stdout, stdout_contains, stderr, stderr_contains, or exit`);
      }
    }
  }
  return errors;
}

function validateSpecName(name) {
  if (!name || typeof name !== "string") die(`spec name required`);
  if (name.length > 64) die(`spec name too long (${name.length} > 64): ${name.slice(0, 64)}…`);
  if (name.includes("/") || name.includes("\\")) die(`spec name cannot contain path separators: ${name}`);
  if (name.includes("..")) die(`spec name cannot contain ..: ${name}`);
  if (name.endsWith(".md")) die(`spec name is not a filename; drop the .md: ${name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`spec name must match [A-Za-z0-9][A-Za-z0-9._-]*: ${name}`);
}

export function loadSpec(name) {
  validateSpecName(name);
  const path = join(SPECS_DIR, `${name}.md`);
  if (!existsSync(path)) die(`spec not found: ${path}`);
  const stats = lstatSync(path);
  if (stats.size > SPEC_MAX_BYTES) {
    die(`spec ${name} too large (${stats.size} > ${SPEC_MAX_BYTES} bytes); raise SPECD_SPEC_MAX_BYTES if intentional`);
  }
  const text = readFileSync(path, "utf-8");
  return { path, text, spec: parseSpec(text) };
}

// ─── Test runner ────────────────────────────────────────────────────────

// Scrub sensitive env vars before spawning a test command. Tests are arbitrary
// shell from the spec author; if the spec is poisoned, anything we leak via env
// is a credential.
const ENV_SCRUB_PATTERNS = [
  /KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /PASSWD/i, /CREDENTIAL/i,
  /^ANTHROPIC_/i, /^AWS_/i, /^AZURE_/i, /^GOOGLE_/i, /^GCP_/i,
  /^GH_/i, /^GITHUB_/i, /^OPENAI_/i, /^HF_/i, /^NPM_TOKEN/i, /^CARGO_REGISTRY/i,
  // Round-2: agent forwarding, runtime injection, dynamic linker hijacks.
  // /i so Mixed_Case env names (rare but possible on macOS/HFS+) get caught too.
  /^SSH_AUTH_SOCK$/i, /^GIT_SSH_COMMAND$/i, /^GIT_ASKPASS$/i, /^SSH_ASKPASS$/i,
  /^LD_PRELOAD$/i, /^LD_LIBRARY_PATH$/i, /^DYLD_INSERT_LIBRARIES$/i, /^DYLD_LIBRARY_PATH$/i,
  /^NODE_OPTIONS$/i, /^NODE_PATH$/i, /^PYTHONPATH$/i, /^PYTHONSTARTUP$/i,
  /^PERL5OPT$/i, /^PERL5LIB$/i, /^RUBYOPT$/i, /^RUBYLIB$/i,
  /^BUNDLE_GEMFILE$/i, /^IRBRC$/i,
  // Round-3 additions: container/orchestration credentials with paths.
  /^KUBECONFIG$/i, /^DOCKER_HOST$/i, /^DOCKER_CONFIG$/i, /^DOCKER_CERT_PATH$/i,
];

function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_SCRUB_PATTERNS.some(p => p.test(k))) continue;
    out[k] = v;
  }
  // Keep a handful of essentials.
  out.PATH = process.env.PATH;
  out.HOME = process.env.HOME;
  out.LANG = process.env.LANG;
  out.TZ = process.env.TZ;
  return out;
}

// Bounded stream collection: cap per stream so a runaway test can't OOM us.
const STREAM_BYTE_CAP = parseInt(process.env.SPECD_TEST_STREAM_CAP || (1024 * 1024).toString(), 10);

async function runOne(test, cwd) {
  return new Promise((resolveTest) => {
    const result = { pass: false, exit: null, stdout: "", stderr: "", reason: null, timedOut: false };
    // Optional outer sandbox: wrap the user's `run` with whatever SPECD_TEST_SANDBOX_CMD is.
    // Example: `sandbox-exec -f /path/profile.sb`. The user-supplied string is prepended.
    const cmd = process.env.SPECD_TEST_SANDBOX_CMD
      ? `${process.env.SPECD_TEST_SANDBOX_CMD} /bin/sh -c ${JSON.stringify(test.run)}`
      : test.run;
    // Spawn in a new process group so we can SIGKILL the whole tree on timeout.
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: scrubbedEnv(), detached: true });
    if (test.stdin !== undefined) child.stdin.end(test.stdin);
    let stdoutBytes = 0, stderrBytes = 0, overflow = false;
    const onData = (which, d) => {
      const buf = Buffer.from(d);
      if (which === "stdout") {
        if (stdoutBytes + buf.length > STREAM_BYTE_CAP) { overflow = true; }
        else { result.stdout += buf.toString(); stdoutBytes += buf.length; }
      } else {
        if (stderrBytes + buf.length > STREAM_BYTE_CAP) { overflow = true; }
        else { result.stderr += buf.toString(); stderrBytes += buf.length; }
      }
      if (overflow) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    };
    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };
    const timer = setTimeout(() => { result.timedOut = true; killTree("SIGKILL"); }, TEST_TIMEOUT_MS);
    child.stdout.on("data", (d) => onData("stdout", d));
    child.stderr.on("data", (d) => onData("stderr", d));
    child.on("error", (err) => { clearTimeout(timer); result.reason = `spawn error: ${err.message}`; resolveTest(result); });
    child.on("close", (code) => {
      clearTimeout(timer);
      result.exit = code;
      if (result.timedOut) { result.reason = `timeout after ${TEST_TIMEOUT_MS}ms (process group killed)`; resolveTest(result); return; }
      if (overflow) { result.reason = `output overflow (>${STREAM_BYTE_CAP} bytes — process group killed)`; resolveTest(result); return; }
      // Check expectations.
      const reasons = [];
      if (test.exit !== undefined && test.exit !== null && code !== test.exit) {
        reasons.push(`exit ${code} ≠ expected ${test.exit}`);
      }
      if (test.stdout !== undefined && result.stdout !== test.stdout) {
        reasons.push(`stdout mismatch (got ${JSON.stringify(truncate(result.stdout))}, expected ${JSON.stringify(truncate(test.stdout))})`);
      }
      if (test.stdout_contains !== undefined && !result.stdout.includes(test.stdout_contains)) {
        reasons.push(`stdout missing substring ${JSON.stringify(truncate(test.stdout_contains))}`);
      }
      if (test.stderr !== undefined && result.stderr !== test.stderr) {
        reasons.push(`stderr mismatch (got ${JSON.stringify(truncate(result.stderr))}, expected ${JSON.stringify(truncate(test.stderr))})`);
      }
      if (test.stderr_contains !== undefined && !result.stderr.includes(test.stderr_contains)) {
        reasons.push(`stderr missing substring ${JSON.stringify(truncate(test.stderr_contains))}`);
      }
      result.pass = reasons.length === 0;
      if (!result.pass) result.reason = reasons.join("; ");
      resolveTest(result);
    });
  });
}

function truncate(s) { return s.length > 120 ? s.slice(0, 120) + "…" : s; }

// ─── LLM-as-judge ───────────────────────────────────────────────────────

function reviewRubric(spec, specPath) {
  const nonce = randomUUID();
  const prompt = `You are a spec reviewer for an autonomous coding loop. Grade the spec at ${specPath} against these criteria. Return ONLY a single JSON object on its own final line — nothing after it.

Spec contents:
---
${readFileSync(specPath, "utf-8")}
---

Rubric — answer YES/NO for each:
1. The Overview names the user-facing feature in one paragraph (no implementation details).
2. Every Behavior N — title has a clear, descriptive title (not generic like "feature").
3. Every Description is one sentence and states WHAT, not HOW (no library names, no internal function names).
4. No two behaviors overlap; each is a distinct, separable unit of work.
5. The set of behaviors is complete for the Overview's stated feature (no obvious missing case).
6. Each Test's run command is a real, runnable shell command (not pseudocode or placeholder).
7. Each Test's outcome (stdout / stderr / exit) is concrete (no "should work" hand-waving).
8. The Constraints section (if present) is about HOW (language, deps, patterns), not WHAT.

Return EXACTLY:
{"verdict":"pass","issues":[],"nonce":"${nonce}"}
OR
{"verdict":"needs_revision","issues":["<one-line issue>", ...],"nonce":"${nonce}"}

The nonce field is REQUIRED and must match exactly: ${nonce}`;
  return { prompt, nonce };
}

function dispatchReviewer(spec, specPath) {
  const { prompt, nonce } = reviewRubric(spec, specPath);
  const r = spawnSync("claude", ["--bg", "--dangerously-skip-permissions"], {
    encoding: "utf-8",
    input: prompt,
    env: { ...process.env, SPECD_IN_WORKER: "1" },
  });
  if (r.error || r.status !== 0) die(`claude --bg failed: ${r.error?.message || r.stderr}`);
  const m = r.stdout.match(/backgrounded\s*·\s*([0-9a-f]{8})/);
  if (!m) die(`could not parse session id from: ${r.stdout}`);
  return { shortId: m[1], nonce, dispatchedAt: Date.now() };
}

function findSession(sessionIdPrefix, dispatchedAt) {
  for (let i = 0; i < 20; i++) {
    const r = spawnSync("claude", ["agents", "--json"], { encoding: "utf-8" });
    if (r.status === 0) {
      try {
        const list = JSON.parse(r.stdout);
        const m = list.find(s => s.sessionId && s.sessionId.startsWith(sessionIdPrefix) &&
                                  s.kind === "background" && s.startedAt >= dispatchedAt - 5_000);
        if (m) return m;
      } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return null;
}

function findSessionJsonl(fullSessionId, cwd) {
  const encoded = cwd.replaceAll("/", "-");
  const direct = join(homedir(), ".claude", "projects", encoded, `${fullSessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${fullSessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function lastAssistantText(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === "assistant" && obj.message?.content) {
        const text = obj.message.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        if (text) return text;
      }
    } catch {}
  }
  return null;
}

function extractJudgeVerdict(text, expectedNonce) {
  if (!text) return null;
  // Look for last balanced JSON object containing nonce + verdict
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "}") continue;
    let depth = 0, start = -1;
    for (let j = i; j >= 0; j--) {
      if (text[j] === "}") depth++;
      else if (text[j] === "{") { depth--; if (depth === 0) { start = j; break; } }
    }
    if (start < 0) continue;
    try {
      const obj = JSON.parse(text.slice(start, i + 1));
      if (obj?.nonce === expectedNonce && obj.verdict) return obj;
    } catch {}
  }
  return null;
}

async function runReview(spec, specPath) {
  const dispatched = dispatchReviewer(spec, specPath);
  process.stderr.write(`dispatched reviewer ${dispatched.shortId}\n`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(1500);
  const session = findSession(dispatched.shortId, dispatched.dispatchedAt);
  if (!session) die(`reviewer session not found in agents list`);
  const deadline = Date.now() + REVIEW_TIMEOUT_MS;
  let sawBusy = false;
  while (Date.now() < deadline) {
    const r = spawnSync("claude", ["agents", "--json"], { encoding: "utf-8" });
    if (r.status === 0) {
      try {
        const list = JSON.parse(r.stdout);
        const s = list.find(x => x.sessionId === session.sessionId);
        if (s) {
          if (s.status === "busy") sawBusy = true;
          if (sawBusy && (s.status === "idle" || s.status === "completed" || s.status === "failed")) break;
        }
      } catch {}
    }
    await sleep(2000);
  }
  // Read transcript
  for (let i = 0; i < 5; i++) {
    const jsonl = findSessionJsonl(session.sessionId, process.cwd());
    if (jsonl) {
      const text = lastAssistantText(jsonl);
      const verdict = extractJudgeVerdict(text, dispatched.nonce);
      if (verdict) {
        spawnSync("claude", ["stop", session.sessionId], { stdio: "ignore" });
        return verdict;
      }
    }
    await sleep(500);
  }
  spawnSync("claude", ["stop", session.sessionId], { stdio: "ignore" });
  die(`could not extract reviewer verdict (nonce mismatch or no JSON found)`);
}

// ─── Verbs ──────────────────────────────────────────────────────────────

const verbs = {
  validate(args) {
    const name = args._[0];
    if (!name) die("validate requires a spec name");
    const { spec, path } = loadSpec(name);
    const errors = validateSpec(spec);
    if (errors.length) {
      process.stderr.write(`✗ ${path}: ${errors.length} error(s)\n`);
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
    process.stderr.write(`✓ ${path}: ${spec.behaviors.length} behavior(s), structurally valid\n`);
  },

  async test(args) {
    const name = args._[0];
    if (!name) die("test requires a spec name");
    const { spec, path } = loadSpec(name);
    const errors = validateSpec(spec);
    if (errors.length) { errors.forEach(e => process.stderr.write(`  - ${e}\n`)); die(`spec ${name} fails structural validation; fix before testing`); }
    const behaviorId = args.behavior ? parseInt(args.behavior, 10) : null;
    const targets = behaviorId ? spec.behaviors.filter(b => b.id === behaviorId) : spec.behaviors;
    if (!targets.length) die(`no matching behaviors (behavior=${behaviorId})`);
    const results = [];
    for (const b of targets) {
      process.stderr.write(`  [${b.id}] ${b.title} … `);
      const r = await runOne(b.test, process.cwd());
      results.push({ behavior: b.id, title: b.title, pass: r.pass, reason: r.reason, exit: r.exit });
      process.stderr.write(r.pass ? `✓\n` : `✗  ${r.reason}\n`);
    }
    const allPass = results.every(r => r.pass);
    process.stdout.write(JSON.stringify({ spec: name, allPass, results }, null, 2) + "\n");
    process.exit(allPass ? 0 : 1);
  },

  async review(args) {
    const name = args._[0];
    if (!name) die("review requires a spec name");
    const { spec, path, text } = loadSpec(name);
    const errors = validateSpec(spec);
    if (errors.length) { errors.forEach(e => process.stderr.write(`  - ${e}\n`)); die(`structural errors; fix before review`); }
    const verdict = await runReview(spec, path);
    process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    if (verdict.verdict === "pass") {
      writeApproval(name, {
        spec: name,
        content_hash: contentHash(text),
        approved_at: new Date().toISOString(),
        verdict: verdict.verdict,
        issues: verdict.issues || [],
      });
      process.stderr.write(`approval written to ${approvalPath(name)}\n`);
    } else {
      clearApproval(name);
      process.exit(1);
    }
  },

  gate(args) {
    const name = args._[0];
    if (!name) die("gate requires a spec name");
    const { spec, text } = loadSpec(name);
    const errors = validateSpec(spec);
    if (errors.length) {
      errors.forEach(e => process.stderr.write(`  - ${e}\n`));
      die(`structural errors: ${name}`);
    }
    const a = checkApproval(name, text);
    if (!a.approved) die(`spec ${name} not approved: ${a.reason}`);
    process.stderr.write(`✓ ${name}: structurally valid and approved (${a.approval.approved_at})\n`);
  },

  outline(args) {
    const name = args._[0];
    if (!name) die("outline requires a spec name");
    const { spec } = loadSpec(name);
    process.stdout.write(`${spec.title || name}\n`);
    process.stdout.write(`${spec.behaviors.length} behavior(s):\n`);
    for (const b of spec.behaviors) {
      process.stdout.write(`  ${b.id}. ${b.title}\n`);
    }
  },

  list() {
    if (!existsSync(SPECS_DIR)) { process.stderr.write(`(no specs/ dir at ${SPECS_DIR})\n`); return; }
    const files = readdirSync(SPECS_DIR).filter(f => f.endsWith(".md") && f !== "README.md");
    if (!files.length) { process.stderr.write("(no specs)\n"); return; }
    for (const f of files) {
      const name = basename(f, ".md");
      try {
        const { spec } = loadSpec(name);
        const errs = validateSpec(spec);
        const mark = errs.length ? "✗" : "✓";
        process.stdout.write(`${mark} ${name}  (${spec.behaviors.length} behavior(s))${errs.length ? "  " + errs.length + " error(s)" : ""}\n`);
      } catch (e) {
        process.stdout.write(`✗ ${name}  parse error: ${e.message}\n`);
      }
    }
  },
};

// ─── Dispatch ───────────────────────────────────────────────────────────

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

// Worker sessions (SPECD_IN_WORKER=1) must not dispatch nested LLM reviewers.
// validate/test/list/outline are fine (read-only); review and gate (which
// triggers a review) are forbidden — review costs money and recursive worker
// dispatch is explicitly out of scope.
const WORKER_FORBIDDEN_VERBS = new Set(["review"]);

const [, , verb, ...rest] = process.argv;
if (!verb || !verbs[verb]) {
  process.stderr.write(`usage: specs.js <validate|test|review|gate|outline|list> <name> [args]\n`);
  process.exit(2);
}
if (IN_WORKER && WORKER_FORBIDDEN_VERBS.has(verb)) {
  die(`refusing ${verb} inside a worker session (SPECD_IN_WORKER=1). The orchestrator dispatches reviews; workers don't.`);
}
await verbs[verb](parseFlags(rest));
