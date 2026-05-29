import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  VERSION,
  FRAMEWORK_OWNED,
  SCAFFOLD,
  HEADER_UPDATABLE,
  REMOVED,
  MIGRATIONS,
  ALL_FILES,
  srcFor,
} from "./config.js";

const SPECD_FILE = ".specd";

function computeChecksum(filePath) {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function loadSpecdFile(targetDir) {
  const filePath = join(targetDir, SPECD_FILE);
  if (existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }
  // Migrate from old format
  const data = { version: null, checksums: {} };
  const oldVersion = join(targetDir, ".specd-version");
  if (existsSync(oldVersion)) {
    data.version = readFileSync(oldVersion, "utf-8").trim();
  }
  const oldChecksums = join(targetDir, ".specd-checksums.json");
  if (existsSync(oldChecksums)) {
    data.checksums = JSON.parse(readFileSync(oldChecksums, "utf-8"));
  }
  return data;
}

function saveSpecdFile(targetDir, data) {
  writeFileSync(join(targetDir, SPECD_FILE), JSON.stringify(data, null, 2) + "\n");
}

function readTemplate(templatesDir, dest) {
  const src = srcFor(dest);
  return readFileSync(join(templatesDir, src), "utf-8");
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

// Local-only files the user should never commit. Kept in one place so `init` and `update`
// both ensure they're gitignored. The deterministic-loop additions (.specd-loop.*,
// specd_loop_events.jsonl, .specd-approvals/) get added on update for existing users.
const GITIGNORE_ENTRIES = [
  "specd_work_list.json",
  "specd_work_list.json.bak",
  "specd_review.json",
  "specd_review.json.bak",
  "specd_loop_events.jsonl",
  ".specd-loop.log",
  ".specd-loop.log.*",
  ".specd-loop.pid",
  ".specd-loop.status.json",
  ".specd-loop.status.json.tmp",
  ".specd-approvals/",
];

function ensureGitignore(targetDir, messages) {
  const gitignorePath = join(targetDir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = existing.split("\n");
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  const block = `${suffix}\n# specd local tracking (not committed)\n${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, existing + block);
  messages.push(`  UPDATE  .gitignore (added ${missing.length} specd entries)`);
}

export function init(targetDir, templatesDir, { projectName, description }) {
  let copied = 0;
  let skipped = 0;
  const messages = [];

  for (const dest of ALL_FILES) {
    const destPath = join(targetDir, dest);

    if (existsSync(destPath)) {
      messages.push(`  SKIP  ${dest} (already exists)`);
      skipped++;
      continue;
    }

    let content = readTemplate(templatesDir, dest);
    content = content.replaceAll("{PROJECT_NAME}", projectName);
    content = content.replaceAll("{One-line project description}", description);

    ensureDir(destPath);
    writeFileSync(destPath, content);
    messages.push(`  CREATE  ${dest}`);
    copied++;
  }

  ensureGitignore(targetDir, messages);

  // Save .specd with version and checksums
  const checksums = {};
  for (const dest of ALL_FILES) {
    const destPath = join(targetDir, dest);
    if (existsSync(destPath)) {
      checksums[dest] = computeChecksum(destPath);
    }
  }
  saveSpecdFile(targetDir, { version: VERSION, checksums });
  messages.push("  CREATE  .specd");

  messages.push("");
  messages.push(`Done. ${copied} files created, ${skipped} skipped.`);

  return { copied, skipped, messages };
}

export function update(targetDir, templatesDir, { dryRun = false, overwrite = false } = {}) {
  let updated = 0;
  let skipped = 0;
  let deleted = 0;
  const messages = [];
  const conflicts = [];

  const pfx = (label) => (dryRun ? `WOULD ${label}` : label);

  const specdData = loadSpecdFile(targetDir);
  const storedChecksums = specdData.checksums;
  const newChecksums = { ...storedChecksums };

  if (specdData.version) {
    messages.push(`Current version: ${specdData.version}`);
  } else {
    messages.push("No .specd found (first update).");
  }
  messages.push(`Updating to: ${VERSION}`);
  messages.push("");

  // Migrate renamed files (old → new) before other steps
  for (const [oldName, newName] of MIGRATIONS) {
    const oldPath = join(targetDir, oldName);
    const newPath = join(targetDir, newName);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      if (!dryRun) {
        ensureDir(newPath);
        writeFileSync(newPath, readFileSync(oldPath, "utf-8"));
        unlinkSync(oldPath);
      }
      messages.push(`  ${pfx("RENAME")}  ${oldName} → ${newName}`);
    }
  }

  // Pass 1: scan all framework-owned files for conflicts before writing anything
  for (const dest of FRAMEWORK_OWNED) {
    const srcPath = join(templatesDir, srcFor(dest));
    const destPath = join(targetDir, dest);

    if (!existsSync(srcPath)) continue;

    const locallyModified =
      existsSync(destPath) &&
      storedChecksums[dest] &&
      computeChecksum(destPath) !== storedChecksums[dest];

    if (locallyModified && !overwrite) {
      messages.push(`  CONFLICT  ${dest} (modified locally — use --overwrite to replace)`);
      conflicts.push(dest);
      skipped++;
    }
  }

  // Pass 2: only write framework-owned files if no conflicts were found
  if (conflicts.length === 0) {
    for (const dest of FRAMEWORK_OWNED) {
      const srcPath = join(templatesDir, srcFor(dest));
      const destPath = join(targetDir, dest);

      if (!existsSync(srcPath)) {
        messages.push(`  MISSING  ${dest} (template not found)`);
        continue;
      }

      const locallyModified =
        existsSync(destPath) &&
        storedChecksums[dest] &&
        computeChecksum(destPath) !== storedChecksums[dest];

      if (locallyModified) {
        messages.push(`  ${pfx("OVERWRITE")}  ${dest} (modified locally)`);
      } else {
        messages.push(`  ${pfx("UPDATE")}  ${dest}`);
      }

      if (!dryRun) {
        ensureDir(destPath);
        writeFileSync(destPath, readFileSync(srcPath, "utf-8"));
      }
      updated++;
    }
  }

  // Scaffold files: create if missing, skip if exists
  for (const dest of SCAFFOLD) {
    const destPath = join(targetDir, dest);
    if (existsSync(destPath)) {
      messages.push(`  ${pfx("SKIP")}  ${dest} (scaffold — not overwritten)`);
      skipped++;
    } else {
      const srcPath = join(templatesDir, srcFor(dest));
      if (!dryRun) {
        ensureDir(destPath);
        writeFileSync(destPath, readFileSync(srcPath, "utf-8"));
      }
      messages.push(`  ${pfx("CREATE")}  ${dest} (new in this version)`);
      updated++;
    }
  }

  // Update headers on header-updatable files
  for (const dest of HEADER_UPDATABLE) {
    const srcPath = join(templatesDir, srcFor(dest));
    const destPath = join(targetDir, dest);

    if (!existsSync(destPath)) {
      if (!dryRun) {
        ensureDir(destPath);
        writeFileSync(destPath, readFileSync(srcPath, "utf-8"));
      }
      messages.push(`  ${pfx("CREATE")}  ${dest}`);
      updated++;
      continue;
    }

    const existing = readFileSync(destPath, "utf-8");
    if (!existing.includes("\n---\n") && !existing.endsWith("\n---\n")) {
      // Check for --- on its own line
      const lines = existing.split("\n");
      const hasSeparator = lines.some((line) => line === "---");
      if (!hasSeparator) {
        messages.push(
          `  ${pfx("SKIP")}  ${dest} (no --- separator found — cannot update header safely)`,
        );
        skipped++;
        continue;
      }
    }

    const template = readFileSync(srcPath, "utf-8");
    const templateLines = template.split("\n");
    const separatorIdx = templateLines.indexOf("---");
    const newHeader = templateLines.slice(0, separatorIdx + 1).join("\n");

    const existingLines = existing.split("\n");
    const existingSepIdx = existingLines.indexOf("---");
    const existingContent = existingLines.slice(existingSepIdx + 1).join("\n");

    if (!dryRun) {
      writeFileSync(destPath, newHeader + "\n" + existingContent);
    }
    messages.push(`  ${pfx("UPDATE")}  ${dest} (header only)`);
    updated++;
  }

  // Remove obsolete files
  for (const dest of REMOVED) {
    const destPath = join(targetDir, dest);
    if (existsSync(destPath)) {
      if (!dryRun) {
        unlinkSync(destPath);
      }
      messages.push(`  ${pfx("DELETE")}  ${dest}`);
      deleted++;
    }
  }

  if (!dryRun && conflicts.length === 0) {
    // Keep the gitignore aligned for existing users picking up the deterministic-loop additions.
    ensureGitignore(targetDir, messages);

    // Recompute and save checksums for all files
    for (const dest of ALL_FILES) {
      const destPath = join(targetDir, dest);
      if (existsSync(destPath)) {
        newChecksums[dest] = computeChecksum(destPath);
      } else {
        delete newChecksums[dest];
      }
    }
    saveSpecdFile(targetDir, { version: VERSION, checksums: newChecksums });

    // Clean up old format files
    for (const old of [".specd-version", ".specd-checksums.json"]) {
      const oldPath = join(targetDir, old);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
  }

  messages.push("");
  if (conflicts.length > 0) {
    messages.push(
      `Aborted. ${conflicts.length} file(s) modified locally. Review the changes above, then run with --overwrite to replace them.`,
    );
  } else if (dryRun) {
    messages.push("Dry run complete. No files were modified.");
  } else {
    messages.push(`Done. ${updated} updated, ${skipped} skipped, ${deleted} deleted.`);
  }

  return { updated, skipped, deleted, conflicts, messages };
}

export function doctor(targetDir) {
  let pass = 0;
  let fail = 0;
  const messages = [];

  messages.push("Checking files...");
  messages.push("");

  for (const dest of ALL_FILES) {
    if (existsSync(join(targetDir, dest))) {
      messages.push(`  PASS  ${dest}`);
      pass++;
    } else {
      messages.push(`  FAIL  ${dest}`);
      fail++;
    }
  }

  messages.push("");

  const specdFile = join(targetDir, SPECD_FILE);
  if (existsSync(specdFile)) {
    const data = JSON.parse(readFileSync(specdFile, "utf-8"));
    messages.push(`  PASS  .specd (${data.version})`);
    pass++;
    if (data.version !== VERSION) {
      messages.push(
        `  WARN  Version mismatch: project ${data.version}, framework ${VERSION} (run 'specd update')`,
      );
      fail++;
    }
  } else {
    messages.push("  FAIL  .specd exists");
    fail++;
  }

  messages.push("");
  messages.push(`${pass} passed, ${fail} failed.`);

  return { pass, fail, messages };
}
