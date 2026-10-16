# Tasks

## 1. Encryption key and secret storage

- [ ] 1.1 Add `SETTINGS_ENCRYPTION_KEY` to `parseEnv` (base64, at least 32 bytes, fixed messages naming only the variable) and drop `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET` and `AI_*` parsing; verify the env tests cover missing, short, non-base64 and valid keys and never print a value
- [ ] 1.2 Add an AES-256-GCM `encryptSecret` / `decryptSecret` module (fresh nonce, secret name as additional authenticated data, `key_version`); verify tests for round trip, tampered ciphertext, wrong key, and a ciphertext moved to another name all fail closed
- [ ] 1.3 Add tables `workspace_settings` (single row, JSONB, `version`, updated by/at), `workspace_secrets` and `settings_audit` with a Drizzle migration; verify migrate and constraint tests (single row, one row per secret name, FK set null)
- [ ] 1.4 Add the settings store: read/validate/save settings with optimistic `version` (409 on stale), write-only secret read (`set`, `updatedAt` only), set/clear secret, and audit rows with field names only; verify tests on a real database including that no clear text is stored and a stale save changes nothing

## 2. Settings schema and validation

- [ ] 2.1 Move the file schema (`repos`/`exclude`, `docsPath`, `apiSpecs`, `defaults`, `limits`, `sync`, `comments`, `ask`) into the settings schema with the existing rules and a GitHub block (`appId`, `installationId`) and the OpenAI-compatible base URL (https or loopback http); verify the existing schema tests pass against it and new ones cover the GitHub block and URL rule
- [ ] 2.2 Validate secrets on save: PEM private key via `createPrivateKey`, webhook secret length and placeholder rule, provider key shape; verify tests that errors name the field and never echo the value

## 3. Workspace runtime

- [ ] 3.1 Add async `getWorkspace()` (settings + decrypted secrets, token provider, GitHub clients, sync context) cached by settings `version`, rechecked at most every 5 seconds and invalidated by a local save, returning a typed `NotConfigured` listing missing setting names; verify tests for caching, local invalidation, another instance's change seen after the interval, and an in-flight snapshot staying unchanged
- [ ] 3.2 Move `getRuntime().db.db` callers to `getDb()` and make every config/GitHub caller (sync service, scheduler boot, webhooks, image proxy, comments flag, Ask limits, status) use `getWorkspace()` and map `NotConfigured` to a fixed outcome; verify typecheck, the existing unit tests updated, and tests that each entry point returns its "not configured" result without any GitHub call
- [ ] 3.3 Read the webhook secret through `getWorkspace()` (401 when none is stored) and keep `SYNC_SECRET` in the environment; verify webhook tests for valid, invalid, and unconfigured cases
- [ ] 3.4 Remove `config/load.ts`, YAML parsing, `CONFIG_PATH`, `readWebhookSecret` and the private key file path; log once at startup and show on the status page when a config file or retired variables are still present; verify a test that they are ignored and reported, and drop the `yaml` dependency if nothing else imports it

## 4. Admin API

- [ ] 4.1 Add `GET/PUT /api/admin/settings` (admin only, same-origin, strict zod, 413/400/409, secrets write-only, explicit clear) with audit and log events carrying names only; verify tests for access, validation errors naming the field, stale 409, secret never in any response or log
- [ ] 4.2 Add `POST /api/admin/settings/test` for GitHub (mint token and count accessible repositories using submitted-but-unsaved or stored values, fixed result words, 5/minute) and move Ask credentials into `/api/admin/ask` (Anthropic key, OpenAI-compatible URL and key) with the connection test reading stored credentials; verify tests with the fake GitHub and fake provider
- [ ] 4.3 Make `providerAvailability`/`providerCredentials` read the stored settings instead of the environment and keep `resolveAsk` as the single decision point; verify Ask on/off/unavailable tests and that a cleared key hides Ask at once

## 5. Admin interface

- [ ] 5.1 Make `/admin/github` an editable page (GitHub App, Repositories, Docs folders, Limits, Sync, Comments) with write-only secret fields ("set, changed on …", Replace, Clear), per-field errors, Save and Test; verify component tests for secrets never rendered, empty secret keeps value, stale-save message
- [ ] 5.2 Add provider credentials to `/admin/ask` and show setup state (GitHub configured, key readable, Ask usable) on the admin index and the status page by setting name only; verify page tests and that nothing secret appears in markup
- [ ] 5.3 End-to-end: a fresh stack with no settings (status shows what is missing, webhook refused, sync "not configured"), then an admin enters the fake GitHub values and a provider key, sync runs, a replaced key applies without restart, the database holds no clear text, axe and 24px targets pass in light and dark; verify with `pnpm test:e2e`

## 6. Docs and clean-up

- [ ] 6.1 Update `.env.example`, `docker-compose.yml` (drop the config mount and GitHub secrets), delete `docmyrepos.config.example.yml` and its tests, and update the README, `docs/guides/configuration.md`, the GitHub App guide, the Ask guide and `docs/log.md` including an upgrade section listing what to re-enter and how to back up the encryption key; verify the example-file and dogfood tests and that every documented command runs as written
- [ ] 6.2 Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` and `openspec validate workspace-settings`; verify all pass

## Workflow follow-up

- Archive the change after review and sync the delta specs.
