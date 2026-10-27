# tenant-context Specification

## Purpose

Carries the tenant of every request and background job through the core, so a host can run many tenants (each with its own database) on one application tier. The single built-in tenant of the open-source app keeps today's behavior.

## Requirements

### Requirement: Tenant context
Every request and job SHALL be handled under exactly one tenant context: a stable tenant id (a lowercase slug of at most 63 characters) plus host-defined attributes. The context SHALL reach every service, query, job, event and slot contribution that runs for it. No core code SHALL decide a tenant any other way.

#### Scenario: Request context
- **WHEN** a request is handled
- **THEN** the page or handler, the services it calls and the events it emits all see the tenant `resolveTenant` returned for that request

#### Scenario: Job context
- **WHEN** a job runs
- **THEN** it uses the tenant id from its payload for its database, workspace, logs and events

### Requirement: Built-in tenant
The default single tenant SHALL have the fixed id `default`. Under it the app SHALL behave as the release before this change. That covers:
- the database, workspace settings, secrets and logo;
- URLs, status codes and session cookies;
- log lines, which carry no tenant field;
- the scheduler timing.

#### Scenario: Upgrade in place
- **WHEN** an installation upgrades to a release with this change and changes no configuration
- **THEN** its users stay signed in, its documents, settings and secrets are served as before, and no migration changes existing rows

### Requirement: Workspace per tenant
Workspace settings, secrets and the GitHub connection SHALL be loaded and cached per tenant, from that tenant's database. A settings save SHALL invalidate only that tenant's cached workspace. A change in one tenant's settings SHALL never be visible to another tenant.

#### Scenario: Two tenants
- **WHEN** an admin of tenant `a` saves a new repository scope
- **THEN** tenant `a`'s next sync uses it, and tenant `b`'s cached workspace and syncs are unaffected

### Requirement: Sessions are bound to their tenant
A session cookie issued for a tenant other than `default` SHALL name that tenant, and SHALL be accepted only for requests resolved to the same tenant. A cookie that names no tenant SHALL be accepted only for the `default` tenant. Cookies issued for `default` SHALL keep their current format.

#### Scenario: Cookie replayed on another tenant
- **WHEN** a valid session cookie issued for tenant `a` is sent with a request resolved to tenant `b`
- **THEN** the request is treated as signed out, even if tenant `b`'s database has a user with the same id

#### Scenario: Existing cookie
- **WHEN** a cookie issued by the previous release is sent to the open-source app after upgrade
- **THEN** the user is still signed in

### Requirement: Authenticated content is confirmed per request
Every page and API behind the session gate SHALL confirm the user through `authenticate` in the tenant's database before it reads content. The same applies to the home page, repository and document pages, search, status, Ask and the asset proxy. The cookie signature alone SHALL no longer be enough.

#### Scenario: Disabled user reads a document
- **WHEN** a user disabled after sign-in opens a document page with their old, unexpired cookie
- **THEN** they are redirected to `/login`

#### Scenario: Asset proxy
- **WHEN** a request carrying a valid cookie of tenant `a` reaches `/api/asset/acme/handbook/img.png` resolved to tenant `b`
- **THEN** it answers 401 and does not call GitHub

### Requirement: In-process state is partitioned by tenant
Caches, rate and concurrency limits, and other in-process state that holds tenant data or tenant ids SHALL be keyed by tenant. This covers the workspace cache, the asset cache, the Ask and MCP per-user and per-token limits, and the scheduler. Process-wide protections that hold no tenant data, such as the GitHub fetch gate and the request concurrency caps, MAY stay shared.

#### Scenario: Same user id in two tenants
- **WHEN** user id 1 of tenant `a` has an Ask answer in progress and user id 1 of tenant `b` asks a question
- **THEN** tenant `b`'s user is not refused as "already answering"

#### Scenario: Same repository in two tenants
- **WHEN** tenants `a` and `b` both show an image from the same GitHub path
- **THEN** each tenant's request is checked against its own repositories, and a cached copy is never served to a tenant whose visibility filter would deny it

### Requirement: Background work runs per tenant
The scheduler SHALL run its start-up sync, periodic full sync and request drain for each tenant from `listTenants()`, each with that tenant's settings and database. It SHALL pick up tenants added or removed within one drain interval. A failure in one tenant SHALL NOT stop the others.

#### Scenario: One tenant failing
- **WHEN** tenant `a`'s database is unreachable during a scheduled run
- **THEN** tenant `b`'s sync still runs, and the failure is logged with tenant `a`'s id

### Requirement: Webhooks are resolved to a tenant before verification
A GitHub webhook SHALL be resolved to a tenant with `resolveTenant`, then verified with that tenant's webhook secret, then dispatched only if its installation is that tenant's installation. A delivery that fails any step SHALL be answered as an unverified or ignored delivery is today.

#### Scenario: Installation mismatch
- **WHEN** a correctly signed delivery for installation 42 is resolved to a tenant whose installation is 7
- **THEN** it is acknowledged and ignored, and no sync runs
