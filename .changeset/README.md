# Changesets

Every pull request that changes a package under `packages/` adds a changeset: `pnpm changeset`,
then pick the bump and describe the change for the changelog. All packages and the app share one
version (`fixed`), so one changeset versions them together. See `CONTRIBUTING.md`.
