---
title: Change log
description: Changes to this documentation, in the order they were written.
---

# Change log

Changes to this documentation, oldest first. New entries go at the end.

## 2026-10-10

- Added the [GitHub App setup guide](./github-app-setup.md) and the App manifest. The guide has not yet been checked against a real GitHub App, so it is marked as a draft.
- Wrote the documentation set as an OKF v0.2 bundle: [architecture](./architecture/index.md), [guides](./guides/index.md), [reference](./reference/index.md) and [decisions](./decisions/index.md), each folder summarized by its `index.md`.
- Added a test, `packages/server/src/docs/dogfood.test.ts`, that syncs this folder into a throwaway database and checks the type counts, the links and the search results.

## 2026-10-15

- Added the [Comments guide](./guides/comments.md): who can comment, where comments are stored, what happens to them when a document moves, the limits, moderation and the `comments.enabled` switch.

## 2026-10-16

- Added the [Ask the docs guide](./guides/ask.md): setting up the provider and model, what is sent to the provider, how answers are grounded and cited, the limits, privacy and the proxy settings for streaming.
- Rewrote [Configuration](./guides/configuration.md), [GitHub App setup](./github-app-setup.md), [Getting started](./guides/getting-started.md), [Comments](./guides/comments.md) and [Ask](./guides/ask.md) for workspace settings: the GitHub App, repository scope, limits and provider keys are now entered by admins in the app and stored in the database (secrets encrypted with `SETTINGS_ENCRYPTION_KEY`). `docmyrepos.config.yml` and the `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`, `AI_*` and `CONFIG_PATH` variables are no longer read; the README has the upgrade steps.
- Described the first-run onboarding: an administrator of an unconfigured workspace is sent to the Workspace configuration page, where a pop-up lists the setup steps.

## 2026-10-16 (install script)

- Added the [Install with the script guide](./guides/install-script.md): the one-command installer, its questions, flags and variables, the files it writes, and what to do next in the app.
- Added [Writing OKF documents with an agent](./guides/okf-authoring.md) and [OKF validation codes](./reference/okf-validation.md): the guidelines file and generated draft, the write-and-validate flow for AI agents, and every finding the validator reports.
- Added the [MCP server reference](./reference/mcp.md): the endpoint and its authentication, the six tools and the prompt, the limits, the failures, the visibility and untrusted-content rules.
- Documented `install.sh --upgrade` in the [install script guide](./guides/install-script.md#upgrade): the order of steps, the database backup, the refusal to downgrade and how to go back.

## 2026-10-27

- Added the [Extension API reference](./reference/extension-api.md) and the decision record [Compose a host app from packages](./decisions/0005-host-app-composition.md): DocMyRepos is built from the packages `@docmyrepos/core`, `@docmyrepos/server` and `@docmyrepos/ui`, which a host app can install and extend.
- Documented the host app's adapters (secrets, blob storage, email) and the domain event catalogue with its delivery rules in the [Extension API reference](./reference/extension-api.md).
- Documented background jobs per tenant (the jobs adapter, `app.jobs.run`, webhook tenant resolution) and the plugin API (routes, pages, jobs, schedules, migrations and UI slots) in the [Extension API reference](./reference/extension-api.md); updated [Sync engine](./architecture/sync-engine.md) and [ADR 0002](./decisions/0002-advisory-locks-no-queue.md) for the jobs adapter.
