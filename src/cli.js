#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { init, update, doctor } from "./commands.js";
import * as loop from "./loop.js";
import { VERSION } from "./config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "templates");

function usage() {
  console.log("specd — Spec-driven development framework for AI agents");
  console.log("");
  console.log("Usage: specd <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log(
    "  init   [dir]            Initialize a project with the specd framework (default: cwd)",
  );
  console.log("  update [dir]            Update framework-owned files to the latest version");
  console.log("  doctor [dir]            Check that all expected files are in place");
  console.log("  loop <verb> [options]   Drive the autonomous coding loop");
  console.log("");
  console.log("Loop verbs:");
  console.log("  specd loop start         Start the orchestrator (background by default)");
  console.log("  specd loop run-once      Foreground + single iteration");
  console.log("  specd loop status        Show heartbeat, current item, cycle");
  console.log("  specd loop stop          Send SIGTERM (clean shutdown)");
  console.log("  specd loop cost [--today]  Summarize per-item token + cost from events.jsonl");
  console.log("  specd loop logs [--tail N] [--follow]");
  console.log("");
  console.log("Common options:");
  console.log("  --dry-run               Preview update changes / drive loop without dispatching");
  console.log("  --overwrite             Overwrite locally modified framework files during update");
  console.log("  --foreground            Run loop in current terminal (default is detached)");
  console.log("  --once                  Run loop for one iteration then exit");
  console.log("  --skip-audit            Skip the audit phase at queue drain");
  console.log("  --help, -h              Show this help message");
  console.log("  --version, -v           Show version number");
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  process.on("SIGINT", () => {
    console.log("\nAborted.");
    process.exit(0);
  });

  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const [command, ...rest] = positional;
  const dryRun = flags.includes("--dry-run");

  if (flags.includes("--help") || flags.includes("-h")) {
    usage();
    return;
  }

  if (flags.includes("--version") || flags.includes("-v")) {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "init": {
      const targetDir = resolve(rest[0] || ".");
      if (!existsSync(targetDir)) {
        console.error(`Error: Directory not found: ${targetDir}`);
        process.exit(1);
      }

      const projectName = await prompt("Project name (e.g., my-app): ");
      if (!projectName) {
        console.error("Error: Project name is required.");
        process.exit(1);
      }

      const description = await prompt(
        "One-line project description (e.g., A task management API): ",
      );
      if (!description) {
        console.error("Error: Project description is required.");
        process.exit(1);
      }

      const result = init(targetDir, TEMPLATES_DIR, { projectName, description });
      result.messages.forEach((m) => console.log(m));
      break;
    }

    case "update": {
      const targetDir = resolve(rest[0] || ".");
      if (!existsSync(targetDir)) {
        console.error(`Error: Directory not found: ${targetDir}`);
        process.exit(1);
      }

      const overwrite = flags.includes("--overwrite");
      const result = update(targetDir, TEMPLATES_DIR, { dryRun, overwrite });
      result.messages.forEach((m) => console.log(m));
      if (result.conflicts.length > 0) process.exit(1);
      break;
    }

    case "doctor": {
      const targetDir = resolve(rest[0] || ".");
      if (!existsSync(targetDir)) {
        console.error(`Error: Directory not found: ${targetDir}`);
        process.exit(1);
      }

      const result = doctor(targetDir);
      result.messages.forEach((m) => console.log(m));
      if (result.fail > 0) process.exit(1);
      break;
    }

    case "loop": {
      const [verb] = rest;
      const flagSet = parseFlags(args.slice(args.indexOf("loop") + 1));
      const targetDir = process.cwd();
      switch (verb) {
        case "start":
          loop.start(targetDir, {
            foreground: !!flagSet.foreground,
            once: !!flagSet.once,
            dryRun: !!flagSet["dry-run"],
            skipAudit: !!flagSet["skip-audit"],
          });
          break;
        case "run-once":
          loop.start(targetDir, { foreground: true, once: true });
          break;
        case "status":
          loop.status(targetDir);
          break;
        case "stop":
          loop.stop(targetDir);
          break;
        case "cost":
          loop.cost(targetDir, { today: !!flagSet.today });
          break;
        case "logs":
          loop.logs(targetDir, { tail: flagSet.tail || 30, follow: !!flagSet.follow });
          break;
        case undefined:
          console.error(
            "Error: 'specd loop' requires a verb (start, stop, status, cost, logs, run-once)",
          );
          process.exit(2);
          break;
        default:
          console.error(`Error: Unknown loop verb "${verb}"`);
          process.exit(2);
      }
      break;
    }

    default:
      if (command) {
        console.error(`Error: Unknown command "${command}"`);
      }
      usage();
      if (command) process.exit(1);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
