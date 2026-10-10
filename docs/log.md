---
title: Change log
description: Changes to this documentation, in the order they were written.
---

# Change log

Changes to this documentation, oldest first. New entries go at the end.

## 2026-10-10

- Added the [GitHub App setup guide](./github-app-setup.md) and the App manifest. The guide has not yet been checked against a real GitHub App, so it is marked as a draft.
- Wrote the documentation set as an OKF v0.2 bundle: [architecture](./architecture/index.md), [guides](./guides/index.md), [reference](./reference/index.md) and [decisions](./decisions/index.md), each folder summarized by its `index.md`.
- Added a test, `src/server/docs/dogfood.test.ts`, that syncs this folder into a throwaway database and checks the type counts, the links and the search results.
