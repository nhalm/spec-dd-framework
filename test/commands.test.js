import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { init, update, doctor } from "../src/commands.js";
import { ALL_FILES, FRAMEWORK_OWNED, SCAFFOLD, REMOVED, VERSION } from "../src/config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "specd-test-"));
}

function runInit(dir, name = "TestProject", desc = "A test project") {
  return init(dir, TEMPLATES_DIR, { projectName: name, description: desc });
}

describe("init", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates all expected files (new design)", () => {
    runInit(tmp);
    // Framework-owned: the deterministic engine + slash commands + settings
    expect(existsSync(join(tmp, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/commands/specd/plan.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/commands/specd/audit.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/commands/specd/review-intake.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/commands/specd/loop.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/scripts/worklist.js"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/scripts/review.js"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/scripts/specs.js"))).toBe(true);
    expect(existsSync(join(tmp, ".claude/scripts/specd-loop.mjs"))).toBe(true);
    // Scaffold: state files + docs + example spec
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmp, "PROJECT.md"))).toBe(true);
    expect(existsSync(join(tmp, "specs/README.md"))).toBe(true);
    expect(existsSync(join(tmp, "specs/example-spec.md"))).toBe(true);
    expect(existsSync(join(tmp, "specd_work_list.json"))).toBe(true);
    expect(existsSync(join(tmp, "specd_review.json"))).toBe(true);
  });

  it("does NOT create retired files", () => {
    runInit(tmp);
    expect(existsSync(join(tmp, "loop.sh"))).toBe(false);
    expect(existsSync(join(tmp, "specd_work_list.md"))).toBe(false);
    expect(existsSync(join(tmp, "specd_review.md"))).toBe(false);
    expect(existsSync(join(tmp, ".claude/commands/specd/implement.md"))).toBe(false);
    expect(existsSync(join(tmp, ".claude/commands/specd/full-audit.md"))).toBe(false);
    expect(existsSync(join(tmp, ".claude/commands/specd/setup.md"))).toBe(false);
  });

  it("replaces {PROJECT_NAME} in PROJECT.md", () => {
    runInit(tmp);
    const content = readFileSync(join(tmp, "PROJECT.md"), "utf-8");
    expect(content).toContain("TestProject");
    expect(content).not.toContain("{PROJECT_NAME}");
  });

  it("replaces {PROJECT_NAME} in specs/README.md", () => {
    runInit(tmp);
    const content = readFileSync(join(tmp, "specs/README.md"), "utf-8");
    expect(content).toContain("TestProject");
    expect(content).not.toContain("{PROJECT_NAME}");
  });

  it("replaces {One-line project description} in specs/README.md", () => {
    runInit(tmp);
    const content = readFileSync(join(tmp, "specs/README.md"), "utf-8");
    expect(content).toContain("A test project");
    expect(content).not.toContain("{One-line project description}");
  });

  it("creates .specd with correct version and checksums", () => {
    runInit(tmp);
    const data = JSON.parse(readFileSync(join(tmp, ".specd"), "utf-8"));
    expect(data.version).toBe(VERSION);
    expect(data.checksums).toBeDefined();
    expect(Object.keys(data.checksums).length).toBe(ALL_FILES.length);
  });

  it("adds new specd state files to .gitignore", () => {
    runInit(tmp);
    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf-8");
    expect(gitignore).toContain("specd_work_list.json");
    expect(gitignore).toContain("specd_review.json");
    expect(gitignore).toContain(".specd-loop.log");
    expect(gitignore).toContain(".specd-loop.pid");
    expect(gitignore).toContain("specd_loop_events.jsonl");
    expect(gitignore).toContain(".specd-approvals/");
  });

  it("skips files that already exist", () => {
    writeFileSync(join(tmp, "CLAUDE.md"), "DO NOT OVERWRITE");
    runInit(tmp);
    expect(readFileSync(join(tmp, "CLAUDE.md"), "utf-8")).toBe("DO NOT OVERWRITE");
  });

  it("reports correct file counts", () => {
    const result = runInit(tmp);
    expect(result.copied).toBe(ALL_FILES.length);
    expect(result.skipped).toBe(0);
  });

  it("seeds empty JSON state files", () => {
    runInit(tmp);
    const worklist = JSON.parse(readFileSync(join(tmp, "specd_work_list.json"), "utf-8"));
    expect(worklist).toEqual({ items: [] });
    const review = JSON.parse(readFileSync(join(tmp, "specd_review.json"), "utf-8"));
    expect(review).toEqual({ findings: [] });
  });

  it("handles special characters in project name", () => {
    init(tmp, TEMPLATES_DIR, {
      projectName: "My Project (Beta)",
      description: "A $pecial & <project>",
    });
    const project = readFileSync(join(tmp, "PROJECT.md"), "utf-8");
    expect(project).toContain("My Project (Beta)");
    const readme = readFileSync(join(tmp, "specs/README.md"), "utf-8");
    expect(readme).toContain("A $pecial & <project>");
  });
});

describe("update", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
    runInit(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stops on locally modified framework files without --overwrite", () => {
    const planPath = join(tmp, ".claude/commands/specd/plan.md");
    writeFileSync(planPath, "CORRUPTED");
    const result = update(tmp, TEMPLATES_DIR);
    expect(result.conflicts).toContain(".claude/commands/specd/plan.md");
    expect(readFileSync(planPath, "utf-8")).toBe("CORRUPTED");
  });

  it("overwrites locally modified framework files with --overwrite", () => {
    const planPath = join(tmp, ".claude/commands/specd/plan.md");
    writeFileSync(planPath, "CORRUPTED");
    const result = update(tmp, TEMPLATES_DIR, { overwrite: true });
    expect(result.conflicts).toHaveLength(0);
    expect(readFileSync(planPath, "utf-8")).not.toContain("CORRUPTED");
  });

  it("updates unmodified framework files without --overwrite", () => {
    const result = update(tmp, TEMPLATES_DIR);
    expect(result.conflicts).toHaveLength(0);
    expect(result.updated).toBeGreaterThan(0);
  });

  it("does not overwrite SCAFFOLD files (user customizations preserved)", () => {
    const path = join(tmp, "PROJECT.md");
    const original = readFileSync(path, "utf-8");
    writeFileSync(path, original + "\nCUSTOM CONTENT");
    update(tmp, TEMPLATES_DIR);
    expect(readFileSync(path, "utf-8")).toContain("CUSTOM CONTENT");
  });

  it("does not overwrite the worklist JSON (it's SCAFFOLD)", () => {
    const path = join(tmp, "specd_work_list.json");
    const customState = {
      items: [{ id: "user-1", spec: "x", text: "in-flight item", blocked_by: [], attempts: 0 }],
    };
    writeFileSync(path, JSON.stringify(customState, null, 2));
    update(tmp, TEMPLATES_DIR);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.items).toHaveLength(1);
    expect(after.items[0].id).toBe("user-1");
  });

  it("deletes files in REMOVED list", () => {
    writeFileSync(join(tmp, "loop.sh"), "old bash loop");
    writeFileSync(join(tmp, "specd_work_list.md"), "old markdown");
    writeFileSync(join(tmp, ".claude/commands/specd/implement.md"), "old slash command");
    update(tmp, TEMPLATES_DIR);
    expect(existsSync(join(tmp, "loop.sh"))).toBe(false);
    expect(existsSync(join(tmp, "specd_work_list.md"))).toBe(false);
    expect(existsSync(join(tmp, ".claude/commands/specd/implement.md"))).toBe(false);
  });

  it("backfills missing scaffold files (e.g. JSON state for old installs)", () => {
    rmSync(join(tmp, "specd_work_list.json"), { force: true });
    rmSync(join(tmp, "specd_review.json"), { force: true });
    update(tmp, TEMPLATES_DIR);
    expect(existsSync(join(tmp, "specd_work_list.json"))).toBe(true);
    expect(existsSync(join(tmp, "specd_review.json"))).toBe(true);
  });

  it("writes .specd with current version", () => {
    rmSync(join(tmp, ".specd"), { force: true });
    update(tmp, TEMPLATES_DIR);
    expect(existsSync(join(tmp, ".specd"))).toBe(true);
    const data = JSON.parse(readFileSync(join(tmp, ".specd"), "utf-8"));
    expect(data.version).toBe(VERSION);
  });

  it("dry-run does not modify files", () => {
    const planPath = join(tmp, ".claude/commands/specd/plan.md");
    writeFileSync(planPath, "MODIFIED");
    const result = update(tmp, TEMPLATES_DIR, { dryRun: true, overwrite: true });
    expect(readFileSync(planPath, "utf-8")).toBe("MODIFIED");
    expect(result.messages.some((m) => m.includes("WOULD"))).toBe(true);
    expect(result.messages.some((m) => m.includes("Dry run complete"))).toBe(true);
  });

  it("adds missing gitignore entries on update for existing installs", () => {
    // Simulate an old install whose gitignore only has the markdown entries.
    writeFileSync(join(tmp, ".gitignore"), "specd_work_list.md\nspecd_review.md\n");
    update(tmp, TEMPLATES_DIR);
    const gi = readFileSync(join(tmp, ".gitignore"), "utf-8");
    expect(gi).toContain("specd_work_list.json");
    expect(gi).toContain(".specd-loop.log");
  });

  it("migrates old .specd-version and .specd-checksums.json to .specd", () => {
    const data = JSON.parse(readFileSync(join(tmp, ".specd"), "utf-8"));
    rmSync(join(tmp, ".specd"));
    writeFileSync(join(tmp, ".specd-version"), data.version);
    writeFileSync(join(tmp, ".specd-checksums.json"), JSON.stringify(data.checksums, null, 2));
    update(tmp, TEMPLATES_DIR);
    expect(existsSync(join(tmp, ".specd"))).toBe(true);
    expect(existsSync(join(tmp, ".specd-version"))).toBe(false);
    expect(existsSync(join(tmp, ".specd-checksums.json"))).toBe(false);
  });
});

describe("doctor", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports all files present on clean init", () => {
    runInit(tmp);
    const result = doctor(tmp);
    expect(result.fail).toBe(0);
    expect(result.pass).toBeGreaterThan(0);
  });

  it("fails when a required file is missing", () => {
    runInit(tmp);
    rmSync(join(tmp, ".claude/scripts/specd-loop.mjs"));
    const result = doctor(tmp);
    expect(result.fail).toBeGreaterThan(0);
  });

  it("fails when the orchestrator script is missing", () => {
    runInit(tmp);
    rmSync(join(tmp, ".claude/scripts/specd-loop.mjs"));
    const result = doctor(tmp);
    expect(result.fail).toBeGreaterThan(0);
  });

  it("detects missing .specd", () => {
    runInit(tmp);
    rmSync(join(tmp, ".specd"));
    const result = doctor(tmp);
    expect(result.fail).toBeGreaterThan(0);
  });

  it("warns on version mismatch", () => {
    runInit(tmp);
    const specdPath = join(tmp, ".specd");
    const data = JSON.parse(readFileSync(specdPath, "utf-8"));
    data.version = "0.0.1";
    writeFileSync(specdPath, JSON.stringify(data, null, 2) + "\n");
    const result = doctor(tmp);
    expect(result.fail).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.includes("Version mismatch"))).toBe(true);
  });

  it("reports correct fail count with one missing file", () => {
    runInit(tmp);
    rmSync(join(tmp, "CLAUDE.md"));
    const result = doctor(tmp);
    expect(result.fail).toBe(1);
  });
});

describe("config sanity", () => {
  it("FRAMEWORK_OWNED and SCAFFOLD lists are disjoint", () => {
    for (const f of FRAMEWORK_OWNED) expect(SCAFFOLD).not.toContain(f);
  });
  it("FRAMEWORK_OWNED and REMOVED lists are disjoint", () => {
    for (const f of FRAMEWORK_OWNED) expect(REMOVED).not.toContain(f);
  });
  it("SCAFFOLD and REMOVED lists are disjoint", () => {
    for (const f of SCAFFOLD) expect(REMOVED).not.toContain(f);
  });
  it("ALL_FILES has no duplicates", () => {
    expect(new Set(ALL_FILES).size).toBe(ALL_FILES.length);
  });
  it("every FRAMEWORK_OWNED file has a corresponding template", () => {
    for (const f of FRAMEWORK_OWNED) {
      const tmplPath = join(
        TEMPLATES_DIR,
        f.startsWith(".claude/") ? f.replace(".claude/", "claude/") : f,
      );
      expect(existsSync(tmplPath), `template missing for ${f}`).toBe(true);
    }
  });
  it("every SCAFFOLD file has a corresponding template", () => {
    for (const f of SCAFFOLD) {
      const tmplPath = join(
        TEMPLATES_DIR,
        f.startsWith(".claude/") ? f.replace(".claude/", "claude/") : f,
      );
      expect(existsSync(tmplPath), `template missing for ${f}`).toBe(true);
    }
  });
});

describe("error handling", () => {
  it("init throws when templates directory is missing", () => {
    const tmp = makeTmp();
    try {
      expect(() =>
        init(tmp, "/nonexistent/templates", { projectName: "T", description: "T" }),
      ).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
