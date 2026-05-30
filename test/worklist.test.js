// Engine tests for templates/claude/scripts/worklist.js (the shipped script).
// Ports the prototype's node:test suite to vitest.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("worklist.js add", () => {
  it("assigns sequential ids per spec", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      expect(run(env, "add", "--spec", "auth", "--text", "a").stdout.trim()).toBe("auth-1");
      expect(run(env, "add", "--spec", "auth", "--text", "b").stdout.trim()).toBe("auth-2");
      expect(run(env, "add", "--spec", "billing", "--text", "c").stdout.trim()).toBe("billing-1");
      expect(run(env, "add", "--spec", "auth", "--text", "d").stdout.trim()).toBe("auth-3");
    } finally {
      cleanup();
    }
  });

  it("rejects unknown blocker id", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "auth", "--text", "first");
      const r = run(env, "add", "--spec", "auth", "--text", "second", "--blocked-by", "auth-99");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unknown blocker/);
    } finally {
      cleanup();
    }
  });

  it("accepts existing blocker id", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "auth", "--text", "first");
      const r = run(env, "add", "--spec", "auth", "--text", "second", "--blocked-by", "auth-1");
      expect(r.status).toBe(0);
      const state = load(path);
      expect(state.items[1].blocked_by).toEqual(["auth-1"]);
    } finally {
      cleanup();
    }
  });

  it("fails without required flags", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      expect(run(env, "add", "--spec", "auth").status).not.toBe(0);
      expect(run(env, "add", "--text", "x").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js next", () => {
  it("picks first eligible item in insertion order", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "auth", "--text", "first");
      run(env, "add", "--spec", "auth", "--text", "second", "--blocked-by", "auth-1");
      run(env, "add", "--spec", "auth", "--text", "third");
      const item = JSON.parse(run(env, "next").stdout.trim());
      expect(item.id).toBe("auth-1");
    } finally {
      cleanup();
    }
  });

  it("skips blocked items", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "auth", "--text", "first");
      run(env, "add", "--spec", "auth", "--text", "second", "--blocked-by", "auth-1");
      run(env, "done", "auth-1");
      const item = JSON.parse(run(env, "next").stdout.trim());
      expect(item.id).toBe("auth-2");
    } finally {
      cleanup();
    }
  });

  it("returns empty when queue is empty", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      expect(run(env, "next").stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("skips items at attempts cap (no head-of-line blocking)", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path, SPECD_ATTEMPTS_CAP: "2" };
      run(env, "add", "--spec", "x", "--text", "first");
      run(env, "add", "--spec", "x", "--text", "second");
      run(env, "fail", "x-1");
      run(env, "fail", "x-1");
      const item = JSON.parse(run(env, "next").stdout.trim());
      expect(item.id).toBe("x-2");
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js done", () => {
  it("removes item and clears blocker references", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b", "--blocked-by", "x-1");
      run(env, "add", "--spec", "x", "--text", "c", "--blocked-by", "x-1,x-2");
      run(env, "done", "x-1");
      const state = load(path);
      expect(state.items.length).toBe(2);
      expect(state.items.find((i) => i.id === "x-2").blocked_by).toEqual([]);
      expect(state.items.find((i) => i.id === "x-3").blocked_by).toEqual(["x-2"]);
    } finally {
      cleanup();
    }
  });

  it("is idempotent on missing id", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      expect(run(env, "done", "x-1").status).toBe(0);
      expect(run(env, "done", "x-1").status).toBe(0);
      expect(run(env, "done", "never-existed").status).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js fail", () => {
  it("increments attempts; SURFACED at cap", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path, SPECD_ATTEMPTS_CAP: "2" };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "fail", "x-1");
      expect(load(path).items[0].attempts).toBe(1);
      expect(run(env, "fail", "x-1").stderr).toMatch(/SURFACED/);
      expect(load(path).items[0].attempts).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js validate", () => {
  it("passes on clean state", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b", "--blocked-by", "x-1");
      expect(run(env, "validate").status).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("detects dangling blocker", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      writeFileSync(
        path,
        JSON.stringify({
          items: [{ id: "x-1", spec: "x", text: "a", blocked_by: ["missing-1"], attempts: 0 }],
        }),
      );
      const r = run(env, "validate");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unknown blocker/);
    } finally {
      cleanup();
    }
  });

  it("detects cycle", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      writeFileSync(
        path,
        JSON.stringify({
          items: [
            { id: "x-1", spec: "x", text: "a", blocked_by: ["x-2"], attempts: 0 },
            { id: "x-2", spec: "x", text: "b", blocked_by: ["x-1"], attempts: 0 },
          ],
        }),
      );
      const r = run(env, "validate");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/cycle/);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js update", () => {
  it("changes text and blocked_by", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "old");
      run(env, "add", "--spec", "x", "--text", "blocker");
      run(env, "update", "x-1", "--text", "new", "--blocked-by", "x-2");
      const state = load(path);
      expect(state.items[0].text).toBe("new");
      expect(state.items[0].blocked_by).toEqual(["x-2"]);
    } finally {
      cleanup();
    }
  });

  it("rejects self-reference in blocked_by", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      expect(run(env, "update", "x-1", "--blocked-by", "x-1").status).not.toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js remove", () => {
  it("refuses if other items still reference the id", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b", "--blocked-by", "x-1");
      const r = run(env, "remove", "x-1");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/still reference/);
      expect(load(path).items.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("--force strips id from referrers", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "a");
      run(env, "add", "--spec", "x", "--text", "b", "--blocked-by", "x-1");
      const r = run(env, "remove", "x-1", "--force");
      expect(r.status).toBe(0);
      const state = load(path);
      expect(state.items.length).toBe(1);
      expect(state.items[0].blocked_by).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js atomic write", () => {
  it("creates .bak before overwriting", () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      run(env, "add", "--spec", "x", "--text", "first");
      const v1 = readFileSync(path, "utf-8");
      run(env, "add", "--spec", "x", "--text", "second");
      expect(existsSync(path + ".bak")).toBe(true);
      expect(readFileSync(path + ".bak", "utf-8")).toBe(v1);
    } finally {
      cleanup();
    }
  });
});

describe("worklist.js lockfile / concurrency", () => {
  it("100 concurrent adds yield unique sequential ids", { timeout: 60_000 }, async () => {
    const { path, cleanup } = freshDir();
    try {
      const env = { SPECD_WORKLIST_PATH: path };
      await Promise.all(
        Array.from(
          { length: 100 },
          (_, i) =>
            new Promise((res) => {
              spawnSync("node", [SCRIPT, "add", "--spec", "s", "--text", `item ${i}`], {
                env: { ...process.env, ...env },
              });
              res();
            }),
        ),
      );
      const state = load(path);
      expect(state.items.length).toBe(100);
      const ids = new Set(state.items.map((i) => i.id));
      expect(ids.size).toBe(100);
      for (let i = 1; i <= 100; i++) expect(ids.has(`s-${i}`)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
