# {PROJECT_NAME} Agent Guidelines

## Spec Authority

**Specs are prescriptive, not descriptive.** The spec defines what code MUST do.

- **Spec is source of truth.** If code contradicts the spec, the code is wrong — refactor it.
- **Read the full spec on version changes.** When the spec version is newer than tracks.md, re-read the entire spec — not just the changelog. The changelog summarizes what changed, but context lives in the full spec.
- **Don't build on broken foundations.** If existing code uses the wrong model (e.g., wrong ID scheme, wrong data flow), fix it first. Don't add new features on top of incorrect code.
- **Spec index:** `specs/README.md` lists all specifications organized by phase. Only specs with status "Ready" should be implemented.
- **Changelogs are immutable.** When creating new changelog entries, old entries never change.

## tracks.md

**Never read tracks.md in full — it exceeds context limits.** Use targeted reads:

1. **Find your section:** `Grep` for `## <your-spec>.md` to get the line number
2. **Read your section:** `Read` with `offset` and `limit` (typically 30-50 lines) starting from that line number
3. **Write updates:** Use `Edit` to modify only your section — never rewrite the file

## Build & Test

<!-- Customize: document your project's build and test commands -->

- Use the project's standard build tooling. See specs/ for build and toolchain details.
- Validate with the full test suite, not just unit tests. If integration tests fail, that's a real failure — do not dismiss them.

## Conventions

<!-- Customize: add project-specific conventions (language, style, patterns) -->

- Follow patterns in existing code for naming, structure, and style
- See specs/ for directory layout and project structure specs

### Interfaces and Dependencies

- **Use interfaces for external dependencies.** Database access, HTTP clients, external services — anything that crosses a boundary.
- **Mock at boundaries, not internals.** Mock the interface, not implementation details.
- **Dependency injection over globals.** Pass dependencies explicitly rather than importing singletons.
