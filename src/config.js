export const VERSION = "0.2.0";

/** Files that get overwritten on update */
export const FRAMEWORK_OWNED = [
  "AGENTS.md",
  ".claude/settings.json",
  ".claude/commands/specd/plan.md",
  ".claude/commands/specd/audit.md",
  ".claude/commands/specd/review-intake.md",
  ".claude/commands/specd/loop.md",
  ".claude/scripts/worklist.js",
  ".claude/scripts/review.js",
  ".claude/scripts/specs.js",
  ".claude/scripts/specd-loop.mjs",
];

/** Files installed once, never overwritten */
export const SCAFFOLD = [
  "CLAUDE.md",
  "PROJECT.md",
  "specs/README.md",
  "specs/example-spec.md",
  "specd_work_list.json",
  "specd_review.json",
];

/**
 * Files where the header (up to first ---) is updated but content below is preserved.
 * Empty in v0.2.0: the JSON state files replace markdown worklist + review.
 */
export const HEADER_UPDATABLE = [];

/** Files removed in this version (cleanup from prior installs) */
export const REMOVED = [
  // Pre-0.2.0 cleanups
  "GUIDE.md",
  ".claude/commands/implement.md",
  ".claude/commands/audit.md",
  ".claude/commands/full-audit.md",
  ".claude/commands/review-intake.md",
  ".claude/commands/setup.md",
  "planning_prompt.md",
  "tracks.md",
  "working_tracks.md",
  "review.md",
  ".specd-version",
  ".specd-checksums.json",
  "specd_history.md",
  "specd_decisions.jsonl",

  // 0.2.0: deterministic-loop migration retires the markdown-worklist + bash-loop design.
  "loop.sh",
  "specd_work_list.md",
  "specd_review.md",
  ".claude/commands/specd/implement.md", // orchestrator replaces this — agents no longer pick items
  ".claude/commands/specd/full-audit.md", // subsumed by specs.js test in the audit phase
  ".claude/commands/specd/setup.md", // folded into the plan flow
];

/** Old → new file renames. Applied during update before other steps. */
export const MIGRATIONS = [];

/** All installable files */
export const ALL_FILES = [...FRAMEWORK_OWNED, ...SCAFFOLD, ...HEADER_UPDATABLE];

/**
 * Map destination path to template source path.
 * Most files are 1:1 except .claude/ -> claude/
 */
export function srcFor(dest) {
  if (dest.startsWith(".claude/")) {
    return dest.replace(".claude/", "claude/");
  }
  return dest;
}
