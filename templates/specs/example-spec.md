# greeter

## Overview

A small command-line greeter for users. Demonstrates the spec-driven loop end-to-end:
multiple discrete behaviors compose into one executable script, each behavior verified by
its own runnable test.

This is an EXAMPLE spec showing the strict format `specs.js validate` enforces. Delete it
once you've drafted your real specs.

## Specification

### Behavior 1 — default greeting

**Description:** When invoked with one positional argument (a name), print a friendly greeting on stdout and exit 0.

**Test:**
- run: `node greeter.mjs Alice`
- stdout: `Hello, Alice!\n`
- exit: 0

**Example:** `Alice` → `Hello, Alice!`

### Behavior 2 — shout mode

**Description:** When invoked with `--shout` before the name, the greeting is uppercased.

**Test:**
- run: `node greeter.mjs --shout Alice`
- stdout: `HELLO, ALICE!\n`
- exit: 0

**Example:** `--shout Alice` → `HELLO, ALICE!`

### Behavior 3 — missing name error

**Description:** When invoked with no name, print an error to stderr and exit 1.

**Test:**
- run: `node greeter.mjs`
- stderr_contains: `name required`
- exit: 1

**Example:** (no args) → stderr "error: name required", exit 1

### Behavior 4 — help output

**Description:** When invoked with `--help`, print usage to stdout and exit 0.

**Test:**
- run: `node greeter.mjs --help`
- stdout_contains: `--shout`
- exit: 0

**Example:** `--help` → usage text listing both default and `--shout` modes

## Constraints

- Pure Node ESM (.mjs); no external dependencies.
- No comments inside the script.
