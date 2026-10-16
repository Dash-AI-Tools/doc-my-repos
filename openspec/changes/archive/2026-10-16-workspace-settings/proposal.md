# Proposal

## Why

Today an operator must edit `docmyrepos.config.yml` and environment variables, then restart, to change which GitHub App the portal uses, which repositories it shows, or which model provider Ask calls. Admins already manage users, branding and Ask on admin pages, but these settings are out of their reach, so every change needs file and deploy access. Moving them into the database, encrypted where secret, lets admins manage the workspace from one admin interface and change it later without a redeploy.

## What Changes

- Store the **GitHub App settings** (App id, installation id, private key, webhook secret) in the database. Secret values are encrypted at rest and never shown again after they are saved.
- Store the **model provider settings** for Ask (Anthropic key; OpenAI-compatible base URL and key) in the database, encrypted where secret.
- Store the **repository narrowing and sync settings** that now live in `docmyrepos.config.yml` (`repos` / `exclude`, per-repo `docsPath` and `apiSpecs`, `defaults.docsPaths`, `limits`, `sync`, `comments`, `ask` limits) in the database.
- Add an admin **Workspace settings** interface to view and change all of the above, with validation, a connection test for GitHub and for the model provider, and an audit log entry (names only, never values) for each change.
- Changes **apply without a restart**: the next sync, webhook, image-proxy request or question uses the new values.
- A new server-held **encryption key** (one environment variable) protects the stored secrets. It is the only new secret the operator manages.
- **BREAKING**: `docmyrepos.config.yml`, `CONFIG_PATH`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET` and the `AI_*` variables are no longer read. There is no automatic import: an existing deployment must enter these values once on the new admin page after upgrading. Until it does, it keeps serving stored content, and sync, webhooks and Ask report "not configured".
- Stays in the environment: `DATABASE_URL`, `SESSION_SECRET`, `SYNC_SECRET`, the bootstrap `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `LOG_LEVEL`, `SYNC_SCHEDULER`, and the new encryption key.

## Capabilities

### New Capabilities
- `workspace-settings`: admin-managed workspace configuration stored in the database: what is stored, how secrets are protected, who can change it, how changes apply and are audited, and how an unconfigured or unreadable workspace behaves.

### Modified Capabilities
- `config-and-sources`: repository narrowing, docs folders, limits and sync settings, and GitHub App credentials come from admin settings instead of the config file and environment; validation moves to save time and to startup for what remains in the environment.
- `ai-provider-config`: provider credentials and endpoints are entered by an administrator and stored encrypted instead of read from the environment.

## Impact

- Code: `src/server/config/*` (env and file loading shrink; a settings store, encryption and validation are added), `src/server/runtime.ts` (built from the database and rebuilt when settings change; becomes async), GitHub token provider, webhook and sync secret reads, image proxy, Ask provider credentials, `/admin/workspace` (read-only today), `/admin/ask`, status page, and the server boot (`src/instrumentation.ts`).
- Database: new tables for settings and encrypted secrets (migration).
- Environment and docs: `.env.example`, `docmyrepos.config.example.yml` (removed), `docker-compose.yml`, README, the configuration, GitHub App and Ask guides, and the example-file tests.
- Tests: config and env tests are rewritten around the settings store; a real test database is used for load, encryption round trips and apply-without-restart.
- No new dependencies: encryption uses Node's built-in `crypto`.
