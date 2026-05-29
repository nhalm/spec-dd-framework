import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = resolve(__dirname, "..", "templates", "claude", "scripts", "specs.js");

function freshProject(specContents, name = "x") {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  mkdirSync(join(dir, "specs"));
  writeFileSync(join(dir, "specs", `${name}.md`), specContents);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(env, cwd, ...args) {
  return spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, ...env },
  });
}

const VALID_SPEC = `# example

## Overview

A simple test feature.

## Specification

### Behavior 1 — does the thing

**Description:** Prints "ok" to stdout and exits 0.

**Test:**
- run: \`echo ok\`
- stdout: \`ok\\n\`
- exit: 0

**Example:** \`example\` → \`ok\`

### Behavior 2 — fails on no arg

**Description:** Exits non-zero when invoked with no args.

**Test:**
- run: \`false\`
- exit: 1
`;

describe("specs.js validate", () => {
  it("passes a well-formed spec", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/2 behavior\(s\), structurally valid/);
    } finally {
      cleanup();
    }
  });

  it("rejects spec missing Overview", () => {
    const text = VALID_SPEC.replace(/## Overview[\s\S]*?## Specification/, "## Specification");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/Overview/);
    } finally {
      cleanup();
    }
  });

  it("rejects spec missing Description", () => {
    const text = VALID_SPEC.replace(/\*\*Description:\*\* Prints "ok" to stdout and exits 0\./, "");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing \*\*Description:\*\*/);
    } finally {
      cleanup();
    }
  });

  it("rejects spec missing Test block", () => {
    const text = VALID_SPEC.replace(/\*\*Test:\*\*\n- run: `false`\n- exit: 1\n/, "");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing \*\*Test:\*\*/);
    } finally {
      cleanup();
    }
  });

  it("rejects non-sequential behavior ids", () => {
    const text = VALID_SPEC.replace("### Behavior 2 —", "### Behavior 5 —");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/expected sequential id 2/);
    } finally {
      cleanup();
    }
  });

  it("rejects test missing exit code", () => {
    const text = VALID_SPEC.replace("- exit: 0", "");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing 'exit:'/);
    } finally {
      cleanup();
    }
  });

  it("rejects overlong Description", () => {
    const longDesc = "x".repeat(300);
    const text = VALID_SPEC.replace('Prints "ok" to stdout and exits 0.', longDesc);
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "validate", "x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/too long/);
    } finally {
      cleanup();
    }
  });
});

describe("specs.js outline", () => {
  it("lists behavior ids and titles", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    try {
      const r = run({}, dir, "outline", "x");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/1\. does the thing/);
      expect(r.stdout).toMatch(/2\. fails on no arg/);
    } finally {
      cleanup();
    }
  });
});

describe("specs.js test", () => {
  it("reports all-pass for matching commands", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    try {
      const r = run({}, dir, "test", "x");
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.allPass).toBe(true);
      expect(out.results.length).toBe(2);
      expect(out.results.every((x) => x.pass)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports specific failure on stdout mismatch", () => {
    const text = VALID_SPEC.replace("- stdout: `ok\\n`", "- stdout: `wrong\\n`");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "test", "x");
      expect(r.status).not.toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.allPass).toBe(false);
      expect(out.results[0].pass).toBe(false);
      expect(out.results[0].reason).toMatch(/stdout mismatch/);
    } finally {
      cleanup();
    }
  });

  it("--behavior runs only the named behavior", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    try {
      const r = run({}, dir, "test", "x", "--behavior", "1");
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.results.length).toBe(1);
      expect(out.results[0].behavior).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("catches wrong exit code", () => {
    const text = VALID_SPEC.replace("- run: `false`\n- exit: 1", "- run: `true`\n- exit: 1");
    const { dir, cleanup } = freshProject(text);
    try {
      const r = run({}, dir, "test", "x");
      expect(r.status).not.toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.results[1].pass).toBe(false);
      expect(out.results[1].reason).toMatch(/exit 0 ≠ expected 1/);
    } finally {
      cleanup();
    }
  });

  it("respects stdout_contains substring match", () => {
    const text = VALID_SPEC.replace("- stdout: `ok\\n`", "- stdout_contains: `o`");
    const { dir, cleanup } = freshProject(text);
    try {
      expect(run({}, dir, "test", "x").status).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("specs.js list", () => {
  it("flags structurally invalid specs", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-"));
    try {
      mkdirSync(join(dir, "specs"));
      writeFileSync(join(dir, "specs", "good.md"), VALID_SPEC);
      writeFileSync(join(dir, "specs", "bad.md"), "# bad\n(missing everything)\n");
      const r = run({}, dir, "list");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/✓ good/);
      expect(r.stdout).toMatch(/✗ bad/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
