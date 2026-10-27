# plugin-api Specification

## Purpose

Lets external code add routes, pages, background jobs, database migrations and UI contributions to DocMyRepos through a declared plugin object, without modifying or forking the core.

## Requirements

### Requirement: Plugin definition
A plugin SHALL be a plain object with:
- a lowercase slug `id`;
- the plugin API major version it targets;
- optional route, page, job, schedule, migration and slot contributions.

A plugin SHALL reach core behavior only through the context and public package exports it is given.

#### Scenario: Minimal plugin
- **WHEN** a plugin with only an `id` and API version is passed to `createApp`
- **THEN** the app starts and behaves as without it

### Requirement: Plugin API routes
A plugin SHALL be able to register HTTP handlers, served at `/api/plugins/<id>/<path>` for the methods it declares. A handler receives the request and a context with the tenant, the user (or null), the tenant's database, the adapters, `authorize`, `checkEntitlement` and event emission. Other methods SHALL answer 405, and unregistered paths 404.

#### Scenario: Registered handler
- **WHEN** a plugin `metering` registers `GET usage` and a signed-in user requests `GET /api/plugins/metering/usage`
- **THEN** the handler runs with that user and the request's tenant, and its response is returned

#### Scenario: Unregistered path
- **WHEN** a request reaches `/api/plugins/metering/other` and no such route is registered
- **THEN** the response is 404 and no plugin code runs

### Requirement: Plugin pages
A plugin SHALL be able to register server-rendered pages, served at `/-/<id>/<path>` inside the regular site layout (header, footer, theme). They get the same context as plugin routes. The `/-/` prefix SHALL never be treated as a repository owner.

#### Scenario: Plugin page
- **WHEN** a plugin `billing` registers the page `plan` and a signed-in user opens `/-/billing/plan`
- **THEN** the page renders inside the site header and footer, in both themes

### Requirement: Plugin routes are private unless declared public
Plugin routes and pages SHALL require a signed-in user, exactly like core pages and APIs. A plugin MAY declare a route or page public only under a `public/` path segment (`/api/plugins/<id>/public/…`, `/-/<id>/public/…`); those are served without a session. A `public/` path the plugin did not declare public SHALL answer 404.

#### Scenario: Private by default
- **WHEN** an unauthenticated request reaches `/-/billing/plan`
- **THEN** it is redirected to `/login`, like any core page

#### Scenario: Declared public
- **WHEN** a plugin declares the public page `public/pricing` and an unauthenticated visitor opens `/-/billing/public/pricing`
- **THEN** the page renders without a session

#### Scenario: Undeclared public path
- **WHEN** an unauthenticated request reaches `/api/plugins/billing/public/invoices`, which the plugin registered as private
- **THEN** the response is 404 and no plugin code runs

### Requirement: Plugin writes are protected like core writes
Plugin routes with an unsafe method (POST, PUT, PATCH, DELETE) SHALL be subject to the same same-origin check as core write APIs before the handler runs, unless the plugin declares the route a machine endpoint. A machine endpoint SHALL authenticate the caller itself.

#### Scenario: Cross-origin write
- **WHEN** a cross-origin POST reaches a plugin route that is not declared a machine endpoint
- **THEN** it is refused as core write APIs refuse it, and the handler does not run

### Requirement: Plugin jobs and schedules
A plugin SHALL be able to register named jobs, whose names start with its `id` and a dot, and periodic schedules for them. A job runs through the jobs adapter with the tenant in its payload. The built-in scheduler SHALL run each schedule once per interval for every tenant from `listTenants()`, with the same enablement as the sync scheduler. A failing plugin job SHALL be logged and SHALL NOT stop other jobs.

#### Scenario: Scheduled plugin job
- **WHEN** a plugin schedules `metering.report` hourly and the scheduler is on
- **THEN** the job runs about once an hour for each listed tenant

#### Scenario: Job name outside the namespace
- **WHEN** a plugin `metering` registers a job named `sync.full`
- **THEN** `createApp` rejects the composition

### Requirement: Plugin migrations
A plugin SHALL be able to ship SQL migrations that the migration routine applies after the core migrations, in order, recorded separately per plugin. A plugin migration SHALL NOT be able to modify or drop core tables. It runs in a database schema owned by the plugin.

#### Scenario: Plugin migration applied
- **WHEN** a plugin with two migrations runs the migration routine against a database for the first time
- **THEN** both are applied after the core migrations, in the plugin's own schema, and recorded so the next run applies neither

#### Scenario: Core schema untouched
- **WHEN** the core migrations of a later release run on a database that has plugin migrations applied
- **THEN** they apply as on a database without plugins

### Requirement: UI slots
The core SHALL expose named UI slots: `header.nav`, `account.menu`, `admin.sections`, `admin.workspace.tabs`, `layout.banner` and `footer.links`. Plugins contribute to them. A contribution is evaluated per request with the context and MAY render nothing. Contributions appear after the core's own items, in plugin order. Core items SHALL be built from the same lists.

#### Scenario: Account menu item
- **WHEN** a plugin contributes `{ href: "/-/billing/plan", label: "Billing" }` to `account.menu` for admins only
- **THEN** admins see "Billing" in the account menu after the core items, and other users do not

#### Scenario: Banner
- **WHEN** a plugin's `layout.banner` contribution returns a notice for a tenant whose trial ends soon
- **THEN** the notice shows above the page content on every page for that tenant, and nothing shows for other tenants

#### Scenario: No plugins
- **WHEN** the open-source app runs without plugins
- **THEN** the header, account menu, admin home, workspace tabs and footer show exactly the items they show today, in the same order

### Requirement: A failing contribution does not break the page
When a slot contribution or plugin page throws, the core SHALL leave that contribution out, or show its generic error page for a plugin page. It SHALL log a `plugin.failed` warning naming the plugin and slot, and the rest of the page SHALL render.

#### Scenario: Throwing nav item
- **WHEN** a plugin's `header.nav` contribution throws
- **THEN** the header renders with the core items, and a `plugin.failed` warning names the plugin and `header.nav`
