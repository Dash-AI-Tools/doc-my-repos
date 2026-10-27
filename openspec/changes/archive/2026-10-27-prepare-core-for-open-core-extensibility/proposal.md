# Proposal

## Why

DocMyRepos is the open-source core of a product. A separate, private SaaS layer will add billing, signup and organizations, SSO, metering, and admin and marketing pages. That SaaS layer will be multi-tenant, with one Postgres database per tenant behind a shared application tier. It has to consume this repo as versioned npm packages plus the container image, and extend it only through public APIs.

Today that is not possible. Wiring is hard-coded across four places:

- Next.js file routes.
- `src/instrumentation.ts`.
- `src/proxy.ts`.
- `globalThis` singletons: the database handle, the workspace cache, the scheduler and the asset cache.

Beyond that wiring:

- Every permission check is an inline `role` comparison.
- Every UI list is a literal: header nav, account menu, admin links, workspace tabs and footer.
- The process assumes exactly one database and one workspace.

This change adds the seams the SaaS layer needs while self-hosters keep exactly what they have: the same environment variables, CLI, Docker usage and data.

## What Changes

- **App factory.** `createApp({ config, hooks, adapters, plugins })` becomes the single composition root. It returns the route handlers, page bindings, the instrumentation `start()` and the job runner. The OSS app becomes a thin caller using the defaults:
  - `src/docmyrepos.ts` builds the app.
  - Route files, `instrumentation.ts` and `proxy.ts` re-export from the packages.

  Configuration still comes from the same environment variables, and workspace settings still come from the database.
- **Typed, versioned hooks, each with an OSS default:**
  - `resolveTenant(request)` → `TenantContext | null` (default: the single built-in tenant).
  - `listTenants()`, for background work (default: the built-in tenant only).
  - `authenticate(request)` → `User | null` (default: today's session and token checks).
  - `authorize(ctx, action, resource)` (default: today's role and ownership rules, moved to one place).
  - `checkEntitlement(ctx, feature)` (default: always true).
  - `onEvent(event)` for usage and audit events, emitted after key domain actions (default: no-op).

  `listTenants` is added to the requested hook set because, with a database per tenant, the scheduler needs to know which tenants exist.
- **Adapters behind interfaces, with today's implementations as defaults:**
  - Database: one handle per tenant, built from `DATABASE_URL` by default.
  - Jobs: the scheduler and webhook work go through a job runner; the default runs in-process, as today.
  - Secrets: the encryption key per tenant, from `SETTINGS_ENCRYPTION_KEY` by default.
  - Blob storage: the branding logo; the default stays in the database.
  - Email: core sends none today; the default rejects as not configured.
- **Plugin API.** Plugins register API routes under `/api/plugins/<id>/…`, pages under `/-/<id>/…`, named jobs and schedules, their own migrations, and contributions to named UI slots. Plugin routes may be public only under a `public/` segment. Slots: header nav, account menu, admin sections, workspace tabs, a banner above the page and footer links. Core's own items move into the same lists, which removes the duplicated admin link list.
- **Tenant readiness.**
  - A `TenantContext` is threaded through request handling, services, jobs, events, logs and in-process cache and limiter keys.
  - Session cookies are bound to their tenant. A cookie for the built-in tenant keeps its current format, so existing sessions stay valid.
  - There is no data isolation in a shared database, and no tenant column.
- **Packaging.** Code is split into `@docmyrepos/core` (contracts and shared pure code), `@docmyrepos/server` and `@docmyrepos/ui`.
  - Each package's `exports` is its public surface; everything else is internal and not covered by semver.
  - Versioning is lockstep through Changesets, with a changelog.
  - The packages are published from release tags, using npm trusted publishing.
  - The existing image build is kept and now builds the thin OSS app from the packages.
- **Contract tests.** A suite boots `createApp` with stub hooks and adapters, two tenant databases and a sample plugin that imports only public entrypoints. It runs in CI, alongside a public API surface check.
- **Behavior tightening (not breaking).** Content pages and their APIs now confirm the user in the database (through `authenticate`), as admin pages already do. Today they rely only on the cookie signature, so a disabled user, or one whose password or role changed, keeps reading until the cookie expires. Tenant-bound sessions need this, and it closes that gap. Nothing else a self-hoster sees changes.

## Capabilities

### New Capabilities

- `app-composition`: the `createApp` factory, its defaults, configuration loading, start-up, and how an OSS or host app wires routes, pages, instrumentation and the proxy through it.
- `extension-hooks`: the versioned hook contract (tenant resolution and listing, authentication, authorization, entitlements, events), the defaults, and failure behavior.
- `runtime-adapters`: the database, jobs, secrets, blob storage and email adapter contracts and their default implementations.
- `plugin-api`: plugin definition and validation, plugin routes and pages, jobs and schedules, migrations, and UI slots.
- `tenant-context`: how the tenant is resolved and carried through requests, sessions, jobs, events, logs and caches. It also covers the guarantees that hold for the built-in tenant.
- `core-packages`: the published packages, their public surface and internal boundary, versioning and changelog, and the extension contract test suite.

### Modified Capabilities

- `access-control`: requirement "1. Login and session". A session is valid only for the tenant it was issued for, every authenticated page and API confirms the user in the database, and plugin `public/` paths pass the session gate.
- `container-image-release`: requirement "Installer and image versions match". The npm packages join the single release version check, and release tags publish them.
- `deployment-and-oss`: requirement "Continuous integration". CI also runs the extension contract suite and the public API surface check.

## Impact

- **Code:**
  - Every `src/app/**` route file, `src/instrumentation.ts` and `src/proxy.ts` become thin re-exports.
  - The about 27 `getDb()` fallbacks in `src/server/**` change to take the request or job context.
  - `src/server/workspace.ts` caches per tenant.
  - The inline role checks in `src/server/{admin,comments,mcp,ask,auth}` move behind `authorize`.
  - The scheduler and webhooks run through the jobs adapter.
  - Branding logo storage moves behind the blob adapter.
  - The UI lists in `site-header`, `account-menu`, `site-footer`, `app/admin/page.tsx` and `app/admin/workspace/page.tsx` are replaced by slots.
  - `src/server`, `src/components` and `src/lib` move into `packages/{server,ui,core}`.
- **Dependencies:** `@changesets/cli` (dev). No runtime dependencies, and no new framework.
- **Build and release:**
  - `pnpm-workspace.yaml` gains `packages`.
  - `next.config.ts` uses an exported `withDocMyRepos()` helper.
  - The Dockerfile copies the workspace packages before install.
  - `release.yml` gains a package publish job, and `scripts/check-release-versions.sh` checks the package versions.
- **Unchanged for self-hosters:** environment variables, `docker compose` and `docker run` usage, `install.sh`, `pnpm` scripts, the migration command, the database schema and data, URLs, log fields, and existing sessions.
- **Out of scope:** billing, signup and organizations, SSO, marketing pages, shared-database row isolation, licensing.
