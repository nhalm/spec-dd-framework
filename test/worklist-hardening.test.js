// Hardening tests: spec name validation, in_progress claim with PID liveness,
// SPECD_IN_WORKER write refusal, claim edge cases.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = resolve(__dirname, "..", "templates", "claude", "scripts", "worklist.js");

function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "wl-"));
  return {
    dir: d,
    path: join(d, "wl.json"),
    cleanup: () => rmSync(d, { recursive: true, force: true }),
  };
}

function run(env, ...args) {
  return spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

const load = (p) => JSON.parse(readFileSync(p, "utf-8"));

describe("spec name validation", () => {
  it("rejects spec name with .md suffix", () => {
    const { path, cleanup } = freshDir();
    try {
      const r = run({ SPECD_WORKLIST_PATH: path }, "add", "--spec", "greeter.md", "--text", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/drop the \.md/);
    } finally {
      cleanup();
    }
  });

  it("rejects spec name with path separator", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      expect(run(env, "add", "--spec", "foo/bar", "--text", "x").status).not.toBe(0);
      expect(run(env, "add", "--spec", "../etc/passwd", "--text", "x").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  it("rejects spec name with invalid chars", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      expect(run(env, "add", "--spec", "foo bar", "--text", "x").status).not.toBe(0);
      expect(run(env, "add", "--spec", "-foo", "--text", "x").status).not.toBe(0);
      expect(run(env, "add", "--spec", "", "--text", "x").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  it("accepts clean spec names", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      for (const name of ["auth", "billing-v2", "tier_one", "spec.subname"]) {
        expect(run(env, "add", "--spec", name, "--text", "x").status, name).toBe(0);
      }
    } finally {
      cleanup();
    }
  });

  it("SPECD_REQUIRE_SPEC_FILE rejects when specs/<name>.md missing", () => {
    const { dir, path, cleanup } = freshDir();
    try {
      const env = {
        SPECD_WORKLIST_PATH: path,
        SPECD_SPECS_DIR: join(dir, "specs"),
        SPECD_REQUIRE_SPEC_FILE: "1",
      };
      mkdirSync(join(dir, "specs"));
      writeFileSync(
        join(dir, "specs", "auth.md"),
        "# auth\n## Overview\nx\n## Specification\n### Behavior 1 — t\n**Description:** y\n**Test:**\n- run: `true`\n- exit: 0\n",
      );
      // The file exists but specs.js validate also runs. Since we're testing worklist only,
      // disable cross-call by using SPECD_VALIDATE_SPEC=0 implicitly via no scripts dir.
      // We skip; the file-existence check is what we want here.
      const r = run(env, "add", "--spec", "missing", "--text", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/spec file not found/);
    } finally {
      cleanup();
    }
  });
});

describe("in_progress claim", () => {
  it("next claims the item with pid + startedAt", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      const r = run(env, "next");
      expect(r.status).toBe(0);
      const state = load(path);
      expect(state.items[0].in_progress).toBeTruthy();
      expect(state.items[0].in_progress.pid).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("done clears the claim while removing the item", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b", "--blocked-by", "x-1");
      run(env, "next");
      run(env, "done", "x-1");
      const state = load(path);
      expect(state.items.length).toBe(1);
      expect(state.items[0].blocked_by).toEqual([]);
      expect(state.items[0].in_progress).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("fail clears claim and increments attempts", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "next");
      run(env, "fail", "x-1");
      const state = load(path);
      expect(state.items[0].attempts).toBe(1);
      expect(state.items[0].in_progress).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("release clears claim without incrementing attempts", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "next");
      run(env, "release", "x-1");
      const state = load(path);
      expect(state.items[0].attempts).toBe(0);
      expect(state.items[0].in_progress).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("next skips an item claimed by a live process", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b");
      const state = JSON.parse(readFileSync(path, "utf-8"));
      state.items[0].in_progress = {
        pid: process.pid,
        hostname: hostname(),
        startedAt: Date.now(),
      };
      writeFileSync(path, JSON.stringify(state));
      const r = JSON.parse(run(env, "next").stdout);
      expect(r.id).toBe("x-2");
    } finally {
      cleanup();
    }
  });

  it("next reclaims an item whose claim's pid is dead", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      const state = JSON.parse(readFileSync(path, "utf-8"));
      state.items[0].in_progress = { pid: 999999, hostname: hostname(), startedAt: Date.now() };
      writeFileSync(path, JSON.stringify(state));
      const r = JSON.parse(run(env, "next").stdout);
      expect(r.id).toBe("x-1");
    } finally {
      cleanup();
    }
  });

  it("rejects pid <= 1 / NaN / cross-host claims as stale", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      const claims = [
        { pid: 1, hostname: hostname(), startedAt: Date.now() },
        { pid: 0, hostname: hostname(), startedAt: Date.now() },
        { pid: "NaN", hostname: hostname(), startedAt: Date.now() },
        { pid: 1234, hostname: "other-host", startedAt: Date.now() },
      ];
      for (const c of claims) {
        const state = JSON.parse(readFileSync(path, "utf-8"));
        state.items[0].in_progress = c;
        delete state.items[0].attempts;
        writeFileSync(path, JSON.stringify({ items: [{ ...state.items[0], attempts: 0 }] }));
        const out = run(env, "next").stdout.trim();
        expect(out.length, `claim ${JSON.stringify(c)} should have been reclaimed`).toBeGreaterThan(
          0,
        );
      }
    } finally {
      cleanup();
    }
  });
});

describe("worker write refusal", () => {
  it("SPECD_IN_WORKER=1 refuses write verbs", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      const r = run({ ...env, SPECD_IN_WORKER: "1" }, "add", "--spec", "x", "--text", "evil");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/refusing add inside a worker/);
      const r2 = run({ ...env, SPECD_IN_WORKER: "1" }, "done", "x-1");
      expect(r2.status).not.toBe(0);
      expect(r2.stderr).toMatch(/refusing done inside a worker/);
    } finally {
      cleanup();
    }
  });

  it("SPECD_IN_WORKER=1 still permits read verbs", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      expect(run({ ...env, SPECD_IN_WORKER: "1" }, "list").status).toBe(0);
      expect(run({ ...env, SPECD_IN_WORKER: "1" }, "validate").status).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("validate spec name in existing item", () => {
  it("detects invalid spec name", () => {
    const { path, cleanup } = freshDir();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          items: [{ id: "bad-1", spec: "bad/spec", text: "a", blocked_by: [], attempts: 0 }],
        }),
      );
      const r = run({ SPECD_WORKLIST_PATH: path }, "validate");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/path separators/);
    } finally {
      cleanup();
    }
  });
});
