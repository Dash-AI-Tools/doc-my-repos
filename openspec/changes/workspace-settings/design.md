# Design

## Context

Configuration is read in three places today: `docmyrepos.config.yml` (repository narrowing, docs folders, limits, sync, comments, Ask limits), environment variables (GitHub App id, installation id, private key, webhook secret, `AI_*`), and the database (branding, Ask on/off, provider and model). `createRuntime()` in `src/server/runtime.ts` reads the file and environment **synchronously**, builds the GitHub token provider, client and sync context once, and caches it on `globalThis`; `reloadRuntime()` re-reads on `/api/sync`. Many pages call `getRuntime().db.db` only to reach the database, while a smaller set needs `loaded.config` or the GitHub client (sync, webhooks, image proxy, comments flag, Ask limits, scheduler). `Secret<T>` already keeps values out of logs. `/admin/workspace` is read-only. See proposal.md for motivation and specs/ for requirements.

## Goals / Non-Goals

**Goals:**
- One source of truth in the database for GitHub, provider and sync-scope settings, editable by admins, secrets encrypted at rest and write-only.
- Changes take effect without a restart, and a bad save never breaks a working setup.
- A fresh or half-configured portal still starts, serves stored content and tells admins what is missing.

**Non-Goals:**
- Importing existing env/YAML values automatically (the proposal accepts a manual re-entry).
- Moving `DATABASE_URL`, `SESSION_SECRET`, `SYNC_SECRET`, `ADMIN_*`, `LOG_LEVEL` or `SYNC_SCHEDULER` into the database.
- Encryption key rotation tooling, an external KMS or secret manager, per-admin permissions beyond "admin", and settings history/rollback (only an audit of who changed what).
- Multiple GitHub installations or multiple workspaces.

## Decisions

**1. Two stores: plain settings and encrypted secrets.**
`workspace_settings` is a single row (`id = 1` check, like `ask_settings`) holding the non-secret settings as validated JSONB (`github: {appId, installationId}`, `narrowing`, `defaults`, `limits`, `sync`, `comments`, `ask limits`, and the OpenAI-compatible base URL) plus an integer `version` and `updated_at/updated_by`. `workspace_secrets` has one row per named secret (`github_private_key`, `github_webhook_secret`, `anthropic_api_key`, `openai_api_key`) with `ciphertext`, `nonce`, `key_version`, `updated_at/updated_by`. Secrets are separate so ordinary reads of settings never touch ciphertext, and so a secret can be replaced or cleared without rewriting the rest. The existing `ask_settings` (enabled, provider, model) stays as is. *Alternative:* one JSONB blob with encrypted fields inside — rejected: harder to keep write-only and to audit field by field.

**2. Application-level AES-256-GCM with a server-held key.**
`SETTINGS_ENCRYPTION_KEY` (base64, at least 32 bytes after decoding) is validated at startup. Each secret is encrypted with `node:crypto` AES-256-GCM, a fresh 12-byte nonce, and the **secret's name as additional authenticated data**, so a ciphertext copied into another row fails to decrypt. `key_version` is stored for a future rotation but only version 1 exists now. A database dump alone reveals nothing; a dump plus the environment does, which is the same trust boundary as `SESSION_SECRET` today. *Alternatives:* Postgres `pgcrypto` (key passes through SQL and logs); storing the key in the database (defeats the purpose); an external KMS (a new dependency and service).

**3. Write-only secrets; nothing derived leaks.**
The read API returns, per secret, only `{set: boolean, updatedAt}`, never length or a hint. Saving a secret field that is empty keeps the stored value; there is an explicit "clear" action. Values travel only in the request body of the save (same-origin, admin session) and are wrapped in `Secret` immediately. The private key is validated with `createPrivateKey` on save and must be pasted as PEM text (no file path; the server never reads a path from admin input).

**4. Split the runtime: database vs. workspace.**
`getDb()` (already exists) is used by pages that only need the database; the `getRuntime().db.db` calls switch to it. A new async `getWorkspace()` returns the loaded settings plus the GitHub token provider, clients and sync context, or a typed `NotConfigured` result listing missing setting names. It replaces `createRuntime`/`loadConfig` for config and GitHub. Server entry points that need GitHub (sync, webhooks, image proxy, scheduler boot, status) await it and map `NotConfigured` to a fixed outcome. This makes the former synchronous constructor async, which is the main refactor cost. *Alternative:* keep the runtime synchronous and preload settings at boot — rejected: it cannot see admin changes and cannot be tested with a database.

**5. Cache keyed by settings version; apply without restart.**
`getWorkspace()` caches the built workspace together with the settings `version` and re-checks the version with one cheap query at most every 5 seconds; a save in this process invalidates the cache at once. Another instance picks a change up within 5 seconds. A sync or answer in progress keeps the workspace object it started with (the object is immutable). A save is optimistic: it carries the version it was based on and a stale save is refused with 409 so two admins cannot silently overwrite each other. Decrypted secrets live only inside the cached workspace and are never logged (`Secret`, `redactWhenLogged`).

**6. Webhook and sync secrets.**
The webhook secret is read through the same cache (decrypt once per settings version) before verifying the signature; if none is stored the endpoint answers 401 and does nothing. `SYNC_SECRET` stays in the environment: it guards a machine-to-machine endpoint that must work before an admin has configured anything.

**7. Admin interface.**
`/admin/workspace` becomes the editable page for GitHub App settings and the repository/sync scope (sections: GitHub App, Repositories, Docs folders, Limits, Sync, Comments), backed by `GET/PUT /api/admin/settings` and `POST /api/admin/settings/test`. `/admin/ask` gains the provider credentials (Anthropic key, OpenAI-compatible URL and key) next to the existing choice. The repository list is edited as lines of text (name, optional `docsPath`, `apiSpecs`); the server validates it with the existing zod schema (moved out of the file loader), which also supplies defaults, so there is one validator for the UI and the API. The admin index links both pages and shows setup state. Both pages are admin-only with the same session and same-origin checks as the other admin APIs.

**8. Fresh installs and unconfigured states.**
Missing GitHub settings are a normal state, not a crash. `getWorkspace()` reports the missing names; the status page and admin pages show them; sync, webhook and image-proxy callers return a fixed "not configured" outcome without trying GitHub. The bootstrap admin from `ADMIN_EMAIL/ADMIN_PASSWORD` is how the first administrator gets in.

**9. Audit.**
A `settings_audit` table records user id, time and the changed field names (never values), and the same event goes to the structured log with fixed names. Secrets are logged as `github_private_key changed`, nothing more.

**10. Retiring the file and variables.**
`config/load.ts`, the YAML parsing (and the `yaml` dependency if nothing else uses it), `CONFIG_PATH`, the example config, the compose config mount and the `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET` and `AI_*` variables are removed. If a file or those variables are still present, one startup log line and the status page say they are ignored. `parseEnv` shrinks to the remaining variables plus the encryption key.

## Risks / Trade-offs

- **Losing the encryption key makes stored secrets unrecoverable** → admins re-enter them; the docs say to back the key up with the database and that losing it only costs re-entry, not documents. Status shows "unreadable" without values.
- **Breaking upgrade with no auto-import** → the first start after upgrading serves stored content and shows "not configured"; the upgrade guide lists exactly what to re-enter. Accepted in the proposal.
- **Settings are now a database-compromise target** → encryption at rest with a key outside the database, write-only API, admin-only access, audit trail; an attacker with both database and environment still wins (same as today's `SESSION_SECRET`).
- **Async runtime touches many call sites** → done in one task group with the type system finding every caller; pages that only need the database move to `getDb()`.
- **Cache lag across instances (up to 5 seconds)** → accepted; a running sync always uses a consistent snapshot.
- **The background schedule is read at startup** (interval and run-on-startup) → the scheduler's timers are created once per process; making them live would mean re-arming timers on every settings change. Every tick still reads repositories, limits and credentials from the current workspace and is skipped while GitHub is not configured, so the scheduler can start before an admin has entered the App. The admin page, the guides and the spec say a schedule change needs a restart.
- **A bad save can lock GitHub out** (wrong key saved) → validation on save plus a required-for-success connection test is not enforced, but the test button is next to Save and the previous values are replaced only by a valid set; the audit shows who changed it.
- **Bootstrap lockout** if `ADMIN_*` is unset and no admin exists → unchanged from today; documented.
