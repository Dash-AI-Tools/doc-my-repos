## What and why

<!-- What does this change, and why? Link the issue: Fixes #123 -->

## Checklist

- [ ] The spec is updated for any change in behavior (the spec delta in `openspec/changes/<name>/specs/`, and `design.md` for a changed decision), and `openspec validate --all` passes. Not needed for a bug fix that restores specified behavior.
- [ ] Tests are added or updated (unit for pure logic, a real Postgres for sync and search, Playwright for UI).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` pass locally. For UI changes `pnpm test:e2e` passes too.
- [ ] Documentation is updated: README, `docs/` and `.env.example` for new settings.
- [ ] **UI changes:** screenshots in **both light and dark** are attached below, and `pnpm screenshots` was run if the README images changed.
- [ ] Security rules are respected: no secrets or credentials in code, logs or errors; every read of repos, documents, search, facets and assets goes through the visibility filter; HTML stays sanitized.
- [ ] No unrelated changes or refactors.

## Screenshots (UI changes)

| Light | Dark |
| ----- | ---- |
|       |      |

## Notes for the reviewer

<!-- Trade-offs, follow-ups, anything you were unsure about. -->
