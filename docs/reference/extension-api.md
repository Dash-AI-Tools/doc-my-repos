---
type: Reference
title: Extension API
description: How DocMyRepos is built from published packages so another application can extend it without forking. The packages and what each one holds, the direction of their dependencies, and which entrypoints are public.
tags: [reference, packages, extension]
status: stable
sources:
  - pnpm-workspace.yaml
  - packages/core/package.json
  - packages/server/package.json
  - packages/ui/package.json
  - packages/server/src/app/create-app.ts
  - packages/server/src/proxy.ts
  - packages/server/src/next.ts
  - packages/ui/src/bind-page.ts
  - tests/contract/docs-examples/host/src/docmyrepos.ts
  - packages/server/src/app/context.ts
  - packages/server/src/workspace.ts
  - tests/contract/tenants.test.ts
  - packages/core/src/contracts/authorize.ts
  - packages/server/src/auth/authenticate.ts
  - tests/contract/authorization.test.ts
  - tests/contract/entitlements.test.ts
  - packages/core/src/contracts/events.ts
  - tests/contract/events.test.ts
  - tests/contract/event-delivery.test.ts
  - tests/contract/adapters.test.ts
  - tests/contract/jobs.test.ts
  - tests/contract/plugins.test.ts
  - tests/contract/sample-plugin/index.tsx
  - packages/server/src/plugins/dispatch.ts
  - packages/server/src/plugins/slots.ts
  - packages/server/src/db/plugin-migrations.ts
  - packages/server/src/jobs/runner.ts
  - packages/server/src/jobs/core.ts
  - packages/server/src/app/defaults.ts
generated: 2026-10-27
verified: 2026-10-27
stale_after: 2999-01-01
---

# Extension API

DocMyRepos is the open-source core of a product. Another application, the **host app**, can build a deployment from the same code by installing the published packages and passing its own hooks, adapters and plugins to the application factory. The open-source app in this repository is such a host app itself, using the defaults. Why it works this way is in [Compose a host app from packages](../decisions/0005-host-app-composition.md).

## Packages

| Package              | Holds                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@docmyrepos/core`   | The contracts: tenant, user, hook, adapter, plugin, slot and event types and version constants, plus shared code with no I/O. |
| `@docmyrepos/server` | The server runtime: the application factory, services, default adapters, route handlers, migrations and the proxy.            |
| `@docmyrepos/ui`     | React pages and components, slot rendering and the styles.                                                                    |

The dependencies run one way only: `core ← server ← ui ← app`. Core imports nothing from the other two, server imports core, ui imports core and server, and an app imports all three. No package imports the app.

## Public and internal entrypoints

A package's public API is the set of entrypoints in its `exports` map, other than `./internal/*`. Public entrypoints follow semantic versioning.

`./internal/*` entrypoints exist so the packages can use each other. They are not part of the public API and can change in any release. A host app never imports them. All packages share one version, so the internal entrypoints of matching versions always fit together.

## The application

`createApp` from `@docmyrepos/server` composes the application from four optional parts and returns the object every route file, the instrumentation hook and background work go through.

| Option     | What it is                                                                                                      | Default                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `config`   | The startup settings, with the names of the variables in `.env.example` (`DATABASE_URL`, `SESSION_SECRET`, ...) | `process.env`                            |
| `hooks`    | The decisions the host takes over: tenant, identity, permissions, entitlements and events                       | The open-source behavior, `defaultHooks` |
| `adapters` | The infrastructure: database, secrets, blob storage, email and jobs                                             | The open-source implementations          |
| `plugins`  | Routes, pages, jobs, migrations and UI contributions                                                            | None                                     |

`createApp` validates the composition before anything runs and throws a `CompositionError` that names each problem: a hook that is not a function, an unknown hook or adapter, an adapter method that is missing, a plugin with an invalid or repeated id, or a plugin written for another major version of the extension API. It never reads the database or the network.

The application object has:

- `start()`, for the instrumentation hook: it reports configuration problems and retired settings (names only) and starts the background sync scheduler where it is enabled. It never throws, and only the first call in a process does anything.
- `routes`, the core API routes by name, each a set of HTTP method handlers. A route handler module loads on first use.
- `jobs.run(job)`, which runs a background job for the tenant it names: what a host's queue worker calls (see Jobs).
- `context(request)` and `pageContext()`, the request context: the tenant and its database, workspace, signed-in user, permission and entitlement checks and event emission. `context` is for route handlers; `pageContext` is for server components, built once per request.
- `config`, `hooks`, `adapters` and `plugins` as composed, and `apiVersion`, the extension API version.

The open-source app in this repository is `createApp()` with nothing passed: see `src/docmyrepos.ts`.

## Build a host app

A host app is a Next.js app that depends on the three packages. It has a module that composes the application and thin files that bind it. Route files spell out `dynamic` and `runtime` themselves, because Next.js reads them statically.

`src/docmyrepos.ts`:

```ts
import { createApp } from "@docmyrepos/server";

export const app = createApp({
  hooks: {
    onEvent: (event) => {
      console.log(event.name, event.tenantId);
    },
  },
});
```

Routes bind `app.routes`; pages and layouts bind a page of `@docmyrepos/ui/pages/*` with `bindPage`, which hands the page the application:

`src/app/api/search/route.ts`:

```ts
import { app } from "../../../docmyrepos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, HEAD, POST, PUT, PATCH, DELETE } = app.routes.search;
```

`src/app/page.tsx`:

```tsx
import { bindPage } from "@docmyrepos/ui";
import { HomePage } from "@docmyrepos/ui/pages/home";

import { app } from "../docmyrepos";

export const dynamic = "force-dynamic";

export default bindPage(HomePage, app);
```

`src/app/layout.tsx`:

```tsx
import "./globals.css";

import { bindPage } from "@docmyrepos/ui";
import { RootLayout } from "@docmyrepos/ui/pages/root-layout";

import { app } from "../docmyrepos";

export default bindPage(RootLayout, app);
export { generateMetadata, viewport } from "@docmyrepos/ui/pages/root-layout";
```

The stylesheet comes from the UI package; the host's own styles can follow it:

`src/app/globals.css`:

```css
@import "@docmyrepos/ui/styles.css";
```

The instrumentation hook starts the application in the Node.js runtime only, so the Edge runtime never loads server code:

`src/instrumentation.ts`:

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { app } = await import("./docmyrepos");
  await app.start();
}
```

The proxy sets the security headers and the CSP nonce and gates every path that needs a session. `createProxy` takes extra public paths (each covers what lies below it) and, for a host with its own session cookie, an `isSignedIn` check that replaces the default cookie check. The matcher must be written out literally:

`src/proxy.ts`:

```ts
import { createProxy } from "@docmyrepos/server/proxy";

export const proxy = createProxy({ publicPaths: ["/pricing"] });

export const config = {
  matcher: ["/((?!_next/static/).*)"],
};
```

`withDocMyRepos` adds what every DocMyRepos app needs to the Next.js configuration: compiling the packages, the security headers of the build output, the Swagger UI build workaround and the standalone output for container images. The host's own options win, and its `headers` and `transpilePackages` are added to the defaults:

`next.config.ts`:

```ts
import { withDocMyRepos } from "@docmyrepos/server/next";

export default withDocMyRepos({});
```

## Tenants

Every request and background job runs for exactly one **tenant**: `{ id, attributes }`, where `id` is a lowercase slug of at most 63 characters and `attributes` is the host's own data (plan, region, database name), which the core never reads. The open-source app has one tenant, `DEFAULT_TENANT`, with the id `default`.

| Hook            | Decides                                                           | Default            |
| --------------- | ----------------------------------------------------------------- | ------------------ |
| `resolveTenant` | The tenant of an incoming request, or `null` when it matches none | Always `default`   |
| `listTenants`   | The tenants background work runs for                              | `[DEFAULT_TENANT]` |

A request that matches no tenant is answered 404 with the body `Not Found` before anything else runs: no route code, no database and no plugin. A hook that throws counts as "no tenant" and is logged as `hook.failed` with the hook's name only.

### The database of a tenant

The `database` adapter gives each tenant its Postgres database as a handle (`{ db, pool, close }`). Build one with `createDb(url)` from `@docmyrepos/server`, which binds the core's schema; keep the handles in a bounded cache of your own. The default adapter serves the database at `DATABASE_URL` to the built-in tenant and refuses any other tenant. Postgres stays required: the adapter chooses a database, it does not replace Postgres.

```ts
const handles = new Map<string, DbHandle>();
const app = createApp({
  hooks: { resolveTenant: (request) => tenantFromHost(request.headers.get("host")) },
  adapters: {
    database: {
      async forTenant(tenant) {
        let handle = handles.get(tenant.id);
        if (!handle) handles.set(tenant.id, (handle = createDb(databaseUrlOf(tenant))));
        return handle;
      },
    },
  },
});
```

Each tenant database gets the core migrations with `migrateDatabase(url)` from `@docmyrepos/server/migrate`, an entrypoint of its own because it reads the migration files from disk and must not be bundled into the Next.js server.

### What is kept per tenant

- **Workspace settings** (GitHub App, repository scope, limits, provider keys) are read from the tenant's database and cached per tenant, at most `MAX_CACHED_WORKSPACES` (500) at a time. A settings save drops only that tenant's cached workspace.
- **In-process limits and caches** are keyed by tenant, because user, token and repository ids repeat across tenant databases: the Ask "one answer at a time" gate, the MCP per-token limit and the image cache. The process-wide caps (concurrent answers, MCP calls, GitHub image fetches, search and status requests) count every tenant together.
- **Locks** need nothing: Postgres advisory locks belong to the database that takes them, so tenants on separate databases never contend.
- **Logs** of a tenant other than `default` carry its id in a `tenant` field; the built-in tenant's lines are unchanged.

### The request context

`app.context(request)` (route handlers) and `app.pageContext()` (server components) return the request context, or `null` when the request matches no tenant:

| Member                  | What it gives                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `tenant`                | The tenant                                                                                  |
| `log`                   | The logger, with the tenant on every line unless it is the built-in tenant                  |
| `db()`, `dbHandle()`    | The tenant's database, asked of the adapter once per request                                |
| `workspace({ fresh })`  | The tenant's workspace settings                                                             |
| `user()`                | The signed-in user (`authenticate`), once per request                                       |
| `can(action, resource)` | `authorize` for that user; false when the hook throws                                       |
| `entitled(feature)`     | `checkEntitlement` for the tenant; false when the hook throws                               |
| `emit(event)`           | Hands an event to `onEvent` after the fact; never waits and never throws                    |
| `adapters`              | The app's `blobs`, `email` and `jobs` adapters, for plugin code; each call names the tenant |

## Authentication

`authenticate(request, tenant)` returns the signed-in user (`{ id, email, role }`) or `null`. The default accepts a valid session cookie issued for the request's tenant, whose user exists in the tenant's database, is enabled, and still has the password version and role the cookie was issued with; on `/api/mcp` only, it accepts a valid API token of the tenant instead. Every page and API behind the session gate calls it once per request; a missing user redirects a page to `/login` and answers an API `401 {"error":"Unauthorized"}`. A hook that throws counts as signed out.

A host with its own sign-in (SSO) can either return its own user from `authenticate`, or sign the user in to a core session with `app.issueSession(ctx, userId)`, which returns the `Set-Cookie` value a password login would set. The second keeps the proxy's cookie check and the default `authenticate` working unchanged. To fall back to the default inside a host hook, call `app.defaults.hooks.authenticate`.

## Authorization

`authorize(ctx, action, resource)` decides every permission check the core makes. Repository visibility is not an action: it stays with the visibility filter of the query layer. A hook that throws denies. The default, `defaultAuthorize` from `@docmyrepos/core`, is the open-source rule set:

| Action                           | Default rule                                                 | Resource                                        |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `admin.manage`                   | the user is an admin                                         | `{ kind: "workspace" }`                         |
| `content.read`                   | anyone signed in                                             | `{ kind: "workspace" }`                         |
| `ask.use`                        | anyone signed in                                             | `{ kind: "workspace" }`                         |
| `comment.create`                 | anyone signed in                                             | `{ kind: "document", githubRepoId, path }`      |
| `comment.create_as_organization` | admins                                                       | `{ kind: "document", githubRepoId, path }`      |
| `comment.edit`, `comment.delete` | the author; for a comment posted as the organization, admins | `{ kind: "comment", authorId, asOrganization }` |
| `comment.resolve`                | the author or any admin                                      | `{ kind: "comment", authorId, asOrganization }` |
| `comment.moderate`               | admins                                                       | `{ kind: "comment", authorId, asOrganization }` |
| `comment.view_author_email`      | admins                                                       | `{ kind: "workspace" }`                         |
| `token.manage_own`               | the token's owner                                            | `{ kind: "token", ownerId }`                    |
| `token.manage_any`               | admins                                                       | `{ kind: "token", ownerId }`                    |

The answers keep their meaning whatever decides them: a denied `admin.manage` shows "Access denied" on admin pages and answers admin APIs `403`; a denied `content.read` hides every page and answers APIs `403`; a denied comment, token or Ask action answers as the open-source app does for a user without that permission. The pages offer only what the hook allows: each comment arrives with the viewer's permissions on it, and the account menu shows the admin links only to users allowed `admin.manage`.

Some rules are data invariants, not permissions, and hold whatever the hook answers: an admin cannot demote or disable themselves, and the last enabled admin cannot lose the admin role.

## Entitlements

`checkEntitlement(ctx, feature)` decides whether the request's tenant may use a feature. The core asks it for `ask`, `mcp` and `comments` (`CORE_FEATURES`); a plugin can ask it for names of its own with `ctx.entitled(name)`. The default allows everything. A hook that throws denies.

A denied feature behaves exactly as if an administrator had turned it off in the workspace settings, with no new states to handle: `/ask` answers 404, the Ask launcher and "Ask instead" links disappear and `POST /api/ask` gives its "off" answer; the MCP endpoint and the token pages answer 404; the comments section and the comment APIs answer as when comments are off. The stored settings are not changed, so the feature comes back as it was when the entitlement returns.

## Adapters

Each adapter is an object with the methods below, every one taking the tenant it works for. `createApp` checks each given adapter has them all. Anything not given uses the open-source default, and `app.defaults.adapters` holds the defaults for a host adapter that falls back to one.

| Adapter    | Methods                                                                | Default                                                                    |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `database` | `forTenant(tenant)`                                                    | The database at `DATABASE_URL`, for the built-in tenant only (see Tenants) |
| `secrets`  | `encryptionKey(tenant)`                                                | The key from `SETTINGS_ENCRYPTION_KEY`, for every tenant                   |
| `blobs`    | `get(tenant, name)`, `put(tenant, name, blob)`, `delete(tenant, name)` | `branding/logo` in the tenant's `site_branding` row                        |
| `email`    | `send(tenant, message)`                                                | Rejects with `EmailNotConfiguredError`                                     |
| `jobs`     | `submit(job, options?)`                                                | Runs the job in the server process at once                                 |

### Secrets

`encryptionKey(tenant)` returns the key that encrypts the tenant's stored workspace secrets (the GitHub App private key, the webhook secret, provider API keys), as `{ key, problem: null }` or `{ key: null, problem }`. Build the key with `parseEncryptionKey(value)` from `@docmyrepos/server`, from base64 text of at least 32 bytes; a host can keep one per tenant in its own secret manager. The values are encrypted with AES-256-GCM, so a value encrypted with one tenant's key cannot be read with another's. Without a key, secrets cannot be saved and stored ones read as missing; the admin settings page says so.

Startup secrets stay in the environment (or the `config` object): `DATABASE_URL`, `SESSION_SECRET`, `SYNC_SECRET` and `SETTINGS_ENCRYPTION_KEY` are read once from the startup configuration and never from the database or an adapter. The default secrets adapter is what reads `SETTINGS_ENCRYPTION_KEY` for requests.

### Blob storage

The core stores one file, the portal logo, under the name `branding/logo` as `{ bytes, contentType }`. Its size (at most 512 KB) and type (PNG, JPEG, WebP or SVG, read from the bytes) are checked before `put` is called, and `/api/branding/logo` serves only those types, whatever `get` returns. The tenant's `site_branding` row keeps the logo's type and `logoVersion`, which tells the pages there is a logo and changes the logo URL on every upload and removal. The default keeps the bytes in that row, where logos have always been stored; it rejects any other name with `UnsupportedBlobError`.

### Email

The open-source core sends no mail. `send(tenant, { to, subject, text, html? })` is for plugins (an invitation, a sign-up confirmation), which reach it as `ctx.adapters.email`. The default rejects every message with `EmailNotConfiguredError`, so a message is never dropped silently.

### Jobs

Background work reaches the jobs adapter as a job, `{ name, payload }`, whose JSON payload always names its tenant in `tenantId`. The core submits:

| Job                | Payload                           | Submitted by                          |
| ------------------ | --------------------------------- | ------------------------------------- |
| `sync.full`        | `trigger` (`startup`, `schedule`) | The scheduler                         |
| `sync.drain`       | none                              | The scheduler, every drain tick       |
| `sync.reap`        | none                              | The scheduler, at startup             |
| `webhook.dispatch` | `event`, `payload`, `deliveryId`  | The webhook endpoint, once verified   |
| `sync.repo`        | `githubId`, `trigger`             | Not submitted by the core; a host can |

`app.jobs.run(job)` runs a job: it finds the tenant among `listTenants()`, builds its context (with no signed-in user) and runs the job over that tenant's database and current workspace. It rejects without running anything for an unknown name (`UnknownJobError`), a tenant that is not listed (`UnknownJobTenantError`) or a payload the job does not take (`InvalidJobPayloadError`).

`submit` returns `{ done }` when it runs the job in this process, `done` settling with the job, or `{}` when it queues the job for a worker that calls `app.jobs.run`. The default runs the job at once; the scheduler then backs off when a sync fails, and the webhook endpoint waits up to 5 seconds for `done` before it answers 202. With a queue, the endpoint answers 202 at once. Syncs stay serialized per repository and coalesced by the locks and markers in the tenant's database, whatever runs the job, so the same job run twice, or two at once, leaves the state of one sync.

The scheduler runs one schedule per tenant of `listTenants()` and reads the list again on every drain tick (once a minute), so tenants added or removed are picked up within a minute; one tenant's failures never stop another's. Give each tenant's database handle a pool of at least the default size (10): a scheduled sync holds several connections at once.

A GitHub webhook is resolved to its tenant before it is verified: `resolveTenant` gets a copy of the request, so it can read the payload's `installation.id`. The delivery is then verified with that tenant's webhook secret, and a delivery for an installation that is not the tenant's is acknowledged and ignored.

## Plugins

A plugin is a plain object, checked with `definePlugin` from `@docmyrepos/core` and passed to `createApp({ plugins })`. Its `id` is a lowercase slug; routes, pages, jobs and its database schema are named after it. `apiVersion` is the `EXTENSION_API_VERSION` it was written for: `createApp` refuses a plugin for another major version, a repeated id, an invalid path and a job outside the plugin's namespace, naming each problem. The sample plugin in `tests/contract/sample-plugin/index.tsx` uses every part and imports the public API only:

```tsx
export const samplePlugin: Plugin = definePlugin<Plugin>({
  id: "sample",
  apiVersion: EXTENSION_API_VERSION,
  routes: [
    {
      method: "GET",
      path: "usage",
      handler: async (request, ctx) => Response.json({ tenant: ctx.tenant.id }),
    },
  ],
  pages: [
    {
      path: "account",
      title: "Sample account",
      render: async (ctx) => <p>Tenant {ctx.tenant.id}</p>,
    },
  ],
  jobs: [
    {
      name: "sample.tick",
      handler: async (payload, ctx) => {
        /* ... */
      },
    },
  ],
  schedules: [{ job: "sample.tick", everyMs: 60_000 }],
  migrations: { folder: fileURLToPath(new URL("./migrations", import.meta.url)) },
  slots: { "header.nav": () => ({ href: "/-/sample/account", label: "Sample" }) },
});
```

| Part         | Served at, or runs                                    | Rules                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes`     | `/api/plugins/<id>/<path>`                            | Unknown path 404 and other method 405, before plugin code. A route needs a signed-in user allowed to read content (401, 403), unless it is `public` and its path starts with `public/`. Unsafe methods must pass the same-origin check (JSON, matching origin) unless the route is a `machine` endpoint, which authenticates its caller itself. A handler that throws is answered 500. |
| `pages`      | `/-/<id>/<path>`, inside the site layout              | The same gate as the core pages, or none for a `public/` page. The page gets the path segments below its own in `rest`.                                                                                                                                                                                                                                                                |
| `jobs`       | `app.jobs.run`, the jobs adapter                      | Named `<id>.<name>`; never a core job's name.                                                                                                                                                                                                                                                                                                                                          |
| `schedules`  | Every `everyMs` (at least a minute), for every tenant | Run beside the sync schedule where the scheduler runs (`SYNC_SCHEDULER`). A failing run is logged as `plugin.job_failed` and stops nothing.                                                                                                                                                                                                                                            |
| `migrations` | `migrateDatabase(url, { plugins })`                   | After the core's, in schema `plugin_<id>` (hyphens as underscores) with its own journal, one transaction per plugin. A migration that changes the core's tables, columns, constraints, indexes or triggers is rolled back and fails naming the plugin.                                                                                                                                 |
| `slots`      | The UI places below                                   | Evaluated per request with the request context; return an item, a list or `null`. A contribution that throws is left out and logged as `plugin.failed`.                                                                                                                                                                                                                                |

The proxy lets `/api/plugins/<id>/public/...` and `/-/<id>/public/...` through without a session; the dispatcher still serves only paths a plugin declared public. `migrateDatabase` from `@docmyrepos/server/migrate` takes the plugins; `pnpm db:migrate` and the container's start-up migration apply the core's only.

### Slots

| Slot                   | Item                           | Where                                         | Core items, always first                                                               |
| ---------------------- | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `header.nav`           | `{ href, label }`              | The main navigation                           | Repositories, Ask (when on)                                                            |
| `account.menu`         | `{ href, label, adminOnly? }`  | The account menu; `adminOnly` items to admins | Users, Workspace configuration, Branding, the AI agent pages (MCP on)                  |
| `admin.sections`       | `{ href, label, description }` | The administration home                       | Users, Repository access, Comments, AI agent tokens, Workspace configuration, Branding |
| `admin.workspace.tabs` | `{ id, label, render(ctx) }`   | Tabs of the workspace configuration page      | GitHub & sync, Repository access, Folders, Ask                                         |
| `layout.banner`        | `{ render(ctx) }`              | Above the main content of every page          | None                                                                                   |
| `footer.links`         | `{ href, label }`              | The footer                                    | Sync status                                                                            |

`app.slots.resolve(slot, ctx)` returns a slot's items for a request, the core's first and then each plugin's in plugin order. A contribution can depend on the user, the tenant or an entitlement: the sample plugin's banner shows to one tenant only.

## Events

`onEvent(event)` receives a record of each domain action, for usage metering and audit. The default does nothing. Every event has the same envelope (`DomainEvent` from `@docmyrepos/core`):

| Field           | What it is                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| `name`          | One of `EVENT_NAMES`                                                        |
| `schemaVersion` | `EVENT_SCHEMA_VERSION`, the version of the envelope and the payloads        |
| `tenantId`      | The tenant the action happened in                                           |
| `at`            | ISO 8601 time the action completed                                          |
| `actorId`       | The signed-in user who acted, or `null` (a sync, a webhook, a failed login) |
| `payload`       | The event's fields, below                                                   |

Payloads carry ids and counts only, never document content, search queries, comment text, prompts, answers, email addresses or secrets.

| Event                  | When                                                   | Payload                                                        |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `sync.completed`       | A repository synced                                    | `githubRepoId`, `trigger`, `added`, `changed`, `removed`       |
| `sync.failed`          | A repository's sync failed                             | `githubRepoId`, `trigger`, `reason` (a fixed kind, no message) |
| `auth.login_succeeded` | A password sign-in succeeded                           | `userId`                                                       |
| `auth.login_failed`    | A password sign-in failed                              | none                                                           |
| `auth.logout`          | Someone signed out                                     | `userId`, or `null` when nobody was signed in                  |
| `user.created`         | An admin created a user                                | `userId`, `role`                                               |
| `user.updated`         | An admin changed a user                                | `userId`, `fields` (names of the changed fields)               |
| `token.created`        | Someone created an API token                           | `tokenId`, `ownerId`                                           |
| `token.revoked`        | A token was revoked (not when it already was)          | `tokenId`, `ownerId`                                           |
| `settings.updated`     | An admin saved the workspace settings                  | `version`, `sections` (names of the changed sections)          |
| `branding.updated`     | An admin changed or reset the branding                 | `logoChanged`                                                  |
| `repo.access_changed`  | An admin allowed or blocked a repository               | `githubRepoId`, `allowed`                                      |
| `comment.created`      | Someone posted a comment or a reply                    | `commentId`, `githubRepoId`, `asOrganization`, `reply`         |
| `comment.deleted`      | A comment was deleted, by its author or by a moderator | `commentId`, `githubRepoId`, `byModerator`                     |
| `search.performed`     | Someone searched                                       | `resultCount`, `scoped`                                        |
| `ask.answered`         | Ask answered a question                                | `provider`, `inputTokens`, `outputTokens` (every model call)   |
| `mcp.tool_called`      | An agent called an MCP tool                            | `tool`, `outcome` (`ok` or `error`)                            |

Delivery:

- An event is emitted once, after the action has succeeded and its change is stored. A request that is refused or fails (invalid input, a conflict, a missing record, a denied permission) emits nothing. Revoking a token that is already revoked, and saving a repository's access unchanged, emit nothing either.
- Delivery is detached: the action never waits for `onEvent`, and a hook that throws or rejects changes nothing about the response. The failure is logged as `hook.failed` with the event name only.
- Delivery is at most once and in process: an event is not stored, retried or replayed, and is lost if the process stops before the hook runs. A host that needs a durable record writes the event to its own store from `onEvent`.
- A new event name or a new payload field is a minor release; removing or changing one is a major release and a new `schemaVersion`.
