#!/usr/bin/env node
// Version consistency guard: exits 0 only when the CLI VERSION reported by the
// code equals the package.json version, so CI can refuse a mismatched publish.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/config.js";

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

if (VERSION === pkgVersion) {
  console.log(`ok: ${VERSION}`);
  process.exit(0);
}

console.error(
  `version mismatch: config.js VERSION ${VERSION} !== package.json version ${pkgVersion}`,
);
process.exit(1);
