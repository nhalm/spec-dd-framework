# {PROJECT_NAME} Agent Guidelines

## Spec Authority

**Specs are prescriptive, not descriptive.** The spec defines what code MUST do.

- **Spec is source of truth.** If code contradicts the spec, the code is wrong — refactor it.
- **Read the full spec on version changes.** When the spec version is newer than tracks.md, re-read the entire spec — not just the changelog. The changelog summarizes what changed, but context lives in the full spec.
- **Don't build on broken foundations.** If existing code uses the wrong model (e.g., wrong ID scheme, wrong data flow), fix it first. Don't add new features on top of incorrect code.
- **Spec index:** `specs/README.md` lists all specifications organized by phase. Only specs with status "Ready" should be implemented.
- **Changelogs are immutable.** When creating new changelog entries, old entries never change.

## Conventions

<!-- Customize these conventions for your project -->

- Follow patterns in existing code for naming, structure, and style
- See specs/ for directory layout and project structure specs

### Test Organization

<!-- Customize these conventions for your project and language of choice-->

- **Tests belong in separate files.** For any module `foo.rs`, tests should be in `foo_test.rs` (same directory) or `tests/foo.rs` (integration tests).
- **Do not use `#[cfg(test)] mod tests {}` in source files.** This bloats source files and makes navigation harder.
- **Exception:** Small modules (<200 lines) may include inline tests if the tests are brief.

### Mocking and Traits

- **Use traits for external dependencies.** Database access, HTTP clients, K8s clients — anything that crosses a boundary.
- **Mock at boundaries, not internals.** Mock the trait, not the implementation details.
- **Integration tests use real implementations.** Only database crates hit real databases.
