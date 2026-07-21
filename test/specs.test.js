import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJudgeVerdict } from "../templates/claude/scripts/specs.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = resolve(__dirname, "..", "templates", "claude", "scripts", "specs.js");

// A fake `claude` binary that mimics `claude --print --output-format json`: it reads the
// judge prompt on stdin, echoes back the nonce it was given, and emits the verdict named
// by STUB_VERDICT (default "pass"). STUB_HANG=1 makes it sleep so the review timeout fires.
// Lets us exercise the whole review path with zero API credits.
const STUB_CLAUDE = `#!/usr/bin/env node
if (process.env.STUB_HANG === "1") { setTimeout(() => {}, 60000); }
else if (process.env.STUB_EXIT) { process.stderr.write("boom\\n"); process.exit(Number(process.env.STUB_EXIT)); }
else if (process.env.STUB_BAD_JSON === "1") { process.stdout.write("not json at all\\n"); }
else {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const m = input.match(/must match exactly:\\s*([0-9a-f-]+)/i);
    const nonce = m ? m[1] : "MISSING";
    const verdict = process.env.STUB_VERDICT || "pass";
    const issues = verdict === "pass" ? [] : ["overview leaks implementation detail"];
    const result = "\\u0060\\u0060\\u0060json\\n" + JSON.stringify({ verdict, issues, nonce }) + "\\n\\u0060\\u0060\\u0060";
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }) + "\\n");
  });
}
`;

// Write the stub into <dir>/bin/claude, mark it executable, and return the bin dir to
// prepend onto PATH so specs.js's spawnSync("claude", …) resolves to it.
function installStubClaude(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const p = join(bin, "claude");
  writeFileSync(p, STUB_CLAUDE);
  chmodSync(p, 0o755);
  return bin;
}

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

// extractJudgeVerdict is the retained parser over the reviewer's (adversarial-ish)
// text output. It is the integrity boundary: only a verdict carrying THIS dispatch's
// nonce may be accepted. Imported directly (the module's main-guard keeps the CLI from
// firing on import).
describe("specs.js extractJudgeVerdict", () => {
  const N = "11111111-2222-3333-4444-555555555555";

  it("parses a fenced ```json block (the shape the model emits)", () => {
    const text =
      "Here is my grade:\n```json\n" +
      JSON.stringify({ verdict: "pass", issues: [], nonce: N }) +
      "\n```";
    expect(extractJudgeVerdict(text, N)).toEqual({ verdict: "pass", issues: [], nonce: N });
  });

  it("parses a bare object with trailing prose after it", () => {
    const text = `{"verdict":"needs_revision","issues":["x"],"nonce":"${N}"}\nThanks!`;
    expect(extractJudgeVerdict(text, N).verdict).toBe("needs_revision");
  });

  it("rejects a verdict carrying the WRONG nonce (forgery defense)", () => {
    const text = `{"verdict":"pass","issues":[],"nonce":"WRONG"}`;
    expect(extractJudgeVerdict(text, N)).toBe(null);
  });

  it("ignores malformed JSON and finds the last valid nonce-matched object", () => {
    const text =
      `{not json at all\n` +
      `{"verdict":"pass","nonce":"${N}"\n` + // missing closing brace — unparseable
      `{"verdict":"needs_revision","issues":[],"nonce":"${N}"}`;
    expect(extractJudgeVerdict(text, N).verdict).toBe("needs_revision");
  });

  it("picks the LAST nonce-matched object when several are present", () => {
    const text =
      `{"verdict":"needs_revision","issues":["a"],"nonce":"${N}"}\n` +
      `{"verdict":"pass","issues":[],"nonce":"${N}"}`;
    expect(extractJudgeVerdict(text, N).verdict).toBe("pass");
  });

  it("returns null for empty / null / no-object text", () => {
    expect(extractJudgeVerdict("", N)).toBe(null);
    expect(extractJudgeVerdict(null, N)).toBe(null);
    expect(extractJudgeVerdict("no json here", N)).toBe(null);
  });

  it("ignores an object with a matching nonce but no verdict field", () => {
    expect(extractJudgeVerdict(`{"nonce":"${N}"}`, N)).toBe(null);
  });
});

// The review verb runs the LLM-as-judge and, on pass, writes the HMAC-signed approval
// marker that `gate` requires. Exercised end-to-end against a stubbed `claude` binary —
// no --bg, no transcript scraping, no config-dir knowledge, no API credits.
describe("specs.js review (stubbed judge)", () => {
  function reviewProject(verdict) {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    const bin = installStubClaude(dir);
    const env = {
      PATH: bin + ":" + process.env.PATH,
      SPECD_HMAC_KEY_PATH: join(dir, "approval-key"),
      STUB_VERDICT: verdict,
    };
    return { dir, cleanup, env };
  }

  it("pass → writes a signed approval marker and `gate` then succeeds", () => {
    const { dir, cleanup, env } = reviewProject("pass");
    try {
      const r = run(env, dir, "review", "x");
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).verdict).toBe("pass");

      const markerPath = join(dir, ".specd-approvals", "x.json");
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      expect(marker.verdict).toBe("pass");
      expect(marker.spec).toBe("x");
      expect(typeof marker.sig).toBe("string");
      expect(marker.sig.length).toBeGreaterThan(0);

      const g = run(env, dir, "gate", "x");
      expect(g.status).toBe(0);
      expect(g.stderr).toMatch(/structurally valid and approved/);
    } finally {
      cleanup();
    }
  });

  it("needs_revision → clears approval and exits non-zero, so `gate` fails", () => {
    const { dir, cleanup, env } = reviewProject("needs_revision");
    try {
      const r = run(env, dir, "review", "x");
      expect(r.status).not.toBe(0);
      expect(existsSync(join(dir, ".specd-approvals", "x.json"))).toBe(false);

      const g = run(env, dir, "gate", "x");
      expect(g.status).not.toBe(0);
      expect(g.stderr).toMatch(/not approved/);
    } finally {
      cleanup();
    }
  });

  it("reports a non-zero reviewer exit clearly (not a silent pass)", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    const bin = installStubClaude(dir);
    try {
      const r = run(
        {
          PATH: bin + ":" + process.env.PATH,
          SPECD_HMAC_KEY_PATH: join(dir, "approval-key"),
          STUB_EXIT: "3",
        },
        dir,
        "review",
        "x",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/exited 3/);
      expect(existsSync(join(dir, ".specd-approvals", "x.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reports a non-JSON reviewer envelope as such (not an unhandled crash)", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    const bin = installStubClaude(dir);
    try {
      const r = run(
        {
          PATH: bin + ":" + process.env.PATH,
          SPECD_HMAC_KEY_PATH: join(dir, "approval-key"),
          STUB_BAD_JSON: "1",
        },
        dir,
        "review",
        "x",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/did not return JSON/);
      expect(existsSync(join(dir, ".specd-approvals", "x.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reports a reviewer timeout as a timeout, not an empty spawn failure", () => {
    const { dir, cleanup } = freshProject(VALID_SPEC);
    const bin = installStubClaude(dir);
    try {
      const r = run(
        {
          PATH: bin + ":" + process.env.PATH,
          SPECD_HMAC_KEY_PATH: join(dir, "approval-key"),
          SPECD_REVIEW_TIMEOUT_MS: "500",
          STUB_HANG: "1",
        },
        dir,
        "review",
        "x",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/timed out|timeout/i);
    } finally {
      cleanup();
    }
  });
});
