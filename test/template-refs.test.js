import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

function getAllTemplateMarkdown() {
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".md")) results.push(full);
    }
  };
  walk(TEMPLATES_DIR);
  return results;
}

// Extract backtick-quoted file paths from markdown content.
// Only considers strings that look like *paths* (contain a /) — bare filenames
// like `worklist.js` are typically CLI command names, not file references.
function extractFilePaths(content) {
  const paths = new Set();
  const backtickRe = /`([^`\n]+?\.(?:md|sh|js|mjs|ts|json|yml|yaml))`/g;
  let match;
  while ((match = backtickRe.exec(content)) !== null) {
    const path = match[1];
    if (!path.includes("/")) continue; // bare filename → CLI command, not a path ref
    if (path.includes("(") || path.includes(")")) continue;
    if (path.startsWith("http")) continue;
    if (path.includes("→")) continue;
    if (path.startsWith("~/")) continue; // user-home reference, not in templates
    if (path.includes("<") || path.includes(">")) continue; // placeholder, not a real path
    if (path.includes(" ") && !path.includes("/")) continue;
    paths.add(path);
  }
  return [...paths];
}

// Extract /specd:command references from markdown content.
function extractCommandRefs(content) {
  const commands = new Set();
  const re = /\/specd:([a-z-]+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    commands.add(match[1]);
  }
  return [...commands];
}

// Resolve a referenced path to the templates directory.
function resolveTemplatePath(refPath) {
  const normalized = refPath.replace(/^\.claude\//, "claude/");
  return join(TEMPLATES_DIR, normalized);
}

describe("template reference validation", () => {
  const allFiles = getAllTemplateMarkdown();

  for (const file of allFiles) {
    const relative = file.slice(TEMPLATES_DIR.length + 1);
    const content = readFileSync(file, "utf-8");
    const filePaths = extractFilePaths(content);
    const commandRefs = extractCommandRefs(content);

    for (const ref of filePaths) {
      it(`${relative} references valid file: ${ref}`, () => {
        const resolved = resolveTemplatePath(ref);
        expect(
          existsSync(resolved),
          `${relative} references \`${ref}\` but ${resolved} does not exist`,
        ).toBe(true);
      });
    }

    for (const cmd of commandRefs) {
      it(`${relative} references valid command: /specd:${cmd}`, () => {
        const cmdFile = join(TEMPLATES_DIR, "claude", "commands", "specd", `${cmd}.md`);
        expect(
          existsSync(cmdFile),
          `${relative} references /specd:${cmd} but ${cmdFile} does not exist`,
        ).toBe(true);
      });
    }
  }
});
