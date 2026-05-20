import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

function readTemplate(relPath) {
  return readFileSync(join(TEMPLATES_DIR, relPath), "utf-8");
}

const AUTH_SPEC = `# Auth Spec

| Field | Value |
| ----- | ----- |
| Status | Ready |
| Last Updated | 2025-01-01 |

## Overview

User authentication via JWT tokens.

### What
- POST /auth/register to create accounts
- POST /auth/login to get a JWT
- Auth middleware to protect routes

### Why
Users need to authenticate before accessing protected resources.

### Scope
- Registration with email/password
- Login returning JWT
- Middleware that validates JWT on protected routes

### Out of Scope
- OAuth, social login
- Password reset

## Specification

### POST /auth/register
- Accepts: { email: string, password: string }
- Validates email format
- Hashes password with bcrypt
- Returns 201 with { id: string }
- Returns 400 if email invalid or already taken

### POST /auth/login
- Accepts: { email: string, password: string }
- Verifies credentials
- Returns 200 with { token: string } (JWT with user ID claim)
- Returns 401 if credentials invalid

### Auth middleware
- Reads Authorization header (Bearer token)
- Validates JWT signature and expiry
- Sets req.user with decoded claims
- Returns 401 if token missing or invalid
`;

const DEFAULT_SPECS_README = `# Specs

| Spec | Version | Status |
| ---- | ------- | ------ |
| [auth](auth.md) | v0.1 | Ready |
`;

// Build a context block with all project files the prompt might reference,
// so claude doesn't need tool access to read them.
function buildContext(vars) {
  const agents = readTemplate("AGENTS.md");
  const specsReadme =
    vars.extra_specs?.find((s) => s.path === "specs/README.md")?.content ||
    DEFAULT_SPECS_README;
  const worklist = vars.worklist_override || readTemplate("specd_work_list.md");
  const review = vars.review_override || readTemplate("specd_review.md");
  const exampleSpec = readTemplate("specs/example-spec.md");

  let context = `<file path="AGENTS.md">
${agents}
</file>

<file path="specs/README.md">
${specsReadme}
</file>

<file path="specs/auth.md">
${AUTH_SPEC}
</file>

<file path="specs/example-spec.md">
${exampleSpec}
</file>

<file path="specd_work_list.md">
${worklist}
</file>

<file path="specd_review.md">
${review}
</file>`;

  // Add extra specs (other than README which is already included)
  if (vars.extra_specs) {
    for (const spec of vars.extra_specs) {
      if (spec.path === "specs/README.md") continue;
      context += `\n\n<file path="${spec.path}">\n${spec.content}\n</file>`;
    }
  }

  // Add extra files
  if (vars.extra_files) {
    for (const file of vars.extra_files) {
      context += `\n\n<file path="${file.path}">\n${file.content}\n</file>`;
    }
  }

  // Add environment variables
  if (vars.env_vars) {
    context += `\n\n<environment>`;
    for (const [key, value] of Object.entries(vars.env_vars)) {
      context += `\n${key}=${value}`;
    }
    context += `\n</environment>`;
  }

  return context;
}

export default function transformVars(vars) {
  const systemPrompt = readTemplate(vars.template);
  const context = buildContext(vars);
  return {
    ...vars,
    system_prompt: systemPrompt,
    context,
  };
}
