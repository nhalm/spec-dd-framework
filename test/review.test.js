import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = resolve(__dirname, "..", "templates", "claude", "scripts", "review.js");

function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "rv-"));
  return {
    dir: d,
    path: join(d, "rv.json"),
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

describe("review.js", () => {
  it("add creates finding with status pending and returns id", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      const r = run(
        env,
        "add",
        "--spec",
        "auth",
        "--finding",
        "missing exp check",
        "--code",
        "auth/mw.js:42",
        "--spec-says",
        "reject expired",
        "--option",
        "A: fix code",
        "--option",
        "B: update spec",
        "--recommendation",
        "A",
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("auth-r1");
      const state = load(path);
      expect(state.findings.length).toBe(1);
      expect(state.findings[0].status).toBe("pending");
      expect(state.findings[0].decision).toBe(null);
      expect(state.findings[0].options).toEqual(["A: fix code", "B: update spec"]);
    } finally {
      cleanup();
    }
  });

  it("assigns sequential ids per spec with -r prefix", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      expect(run(env, "add", "--spec", "auth", "--finding", "a").stdout.trim()).toBe("auth-r1");
      expect(run(env, "add", "--spec", "auth", "--finding", "b").stdout.trim()).toBe("auth-r2");
      expect(run(env, "add", "--spec", "billing", "--finding", "c").stdout.trim()).toBe(
        "billing-r1",
      );
    } finally {
      cleanup();
    }
  });

  it("pending returns only pending findings", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      expect(run(env, "pending").stdout.trim()).toBe("");
      run(env, "add", "--spec", "x", "--finding", "f1");
      run(env, "add", "--spec", "x", "--finding", "f2");
      expect(run(env, "pending").stdout.trim().split("\n").length).toBe(2);
      run(env, "decide", "x-r1", "A");
      const out = run(env, "pending").stdout.trim().split("\n");
      expect(out.length).toBe(1);
      expect(out[0]).toMatch(/x-r2/);
    } finally {
      cleanup();
    }
  });

  it("decide records text and sets status decided", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      run(env, "add", "--spec", "x", "--finding", "f");
      run(env, "decide", "x-r1", "A, but only for tokens <7d");
      const state = load(path);
      expect(state.findings[0].status).toBe("decided");
      expect(state.findings[0].decision).toBe("A, but only for tokens <7d");
    } finally {
      cleanup();
    }
  });

  it("decide rejects unknown id", () => {
    const { path, cleanup } = freshDir();
    try {
      expect(run({ SPECD_REVIEW_PATH: path }, "decide", "ghost-r99", "A").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  it("undecide reverts to pending", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      run(env, "add", "--spec", "x", "--finding", "f");
      run(env, "decide", "x-r1", "A");
      run(env, "undecide", "x-r1");
      const state = load(path);
      expect(state.findings[0].status).toBe("pending");
      expect(state.findings[0].decision).toBe(null);
    } finally {
      cleanup();
    }
  });

  it("resolve removes a finding (idempotent)", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_REVIEW_PATH: path };
      run(env, "add", "--spec", "x", "--finding", "f");
      expect(run(env, "resolve", "x-r1").status).toBe(0);
      expect(load(path).findings.length).toBe(0);
      expect(run(env, "resolve", "x-r1").status).toBe(0);
      expect(run(env, "resolve", "never-existed").status).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("validate rejects decided-without-decision", () => {
    const { path, cleanup } = freshDir();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          findings: [{ id: "x-r1", spec: "x", status: "decided", finding: "f", decision: null }],
        }),
      );
      expect(run({ SPECD_REVIEW_PATH: path }, "validate").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });
});
