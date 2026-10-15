# access-control Specification

## Purpose

Authenticated access to the portal with admin-managed users and per-repo allow/block, enforced at the single visibility chokepoint.

## Requirements

### Requirement: 1. Login and session

- **SHALL** redirect unauthenticated visitors on any page except `/login` to `/login`.
- **SHALL** set a signed HTTP-only session cookie on valid login and redirect home.
- **SHALL** return generic 401 on invalid credentials with no session set.
- **SHALL** clear the session cookie on logout.
- **SHALL NOT** apply the session gate to the machine endpoints `POST /api/sync` and `POST /api/webhooks/github`. They have their own authentication (`SYNC_SECRET` bearer token, webhook HMAC signature) and callers (GitHub, cron) have no session cookie.

#### Scenario: Unauthenticated page visit redirects to login
- **WHEN** an unauthenticated visitor requests `/`
- **THEN** they are redirected to `/login`.

- **SHALL** expose `GET /api/health` without a session for the container healthcheck. It returns only the verdict (`200 {"status":"ok"}` or `503`), never repository names or sync detail; `GET /api/status`, which lists repositories, stays behind the login.

#### Scenario: Health check is public and leaks nothing
- **WHEN** an unauthenticated request reaches `/api/health`
- **THEN** it answers 200 or 503 with no repository data, while an unauthenticated `/api/status` is 401.

#### Scenario: Machine endpoints are not behind the session gate
- **WHEN** a request without a session cookie reaches `/api/sync` or `/api/webhooks/github`
- **THEN** the proxy passes it through, and the route's own secret or signature check decides the answer.

#### Scenario: Valid login creates a session
- **WHEN** valid email + password are posted to the login route
- **THEN** a signed HTTP-only session cookie is set and the user is redirected home.

#### Scenario: Invalid login is generic
- **WHEN** wrong email or password is posted
- **THEN** the response is 401 "Invalid email or password" and no session is set.

#### Scenario: Logout clears the session
- **WHEN** the user visits logout
- **THEN** the session cookie is cleared.

### Requirement: 2. Roles

- **SHALL** return 403 for `user` role on `/admin/*` and admin APIs.
- **SHALL** grant `admin` role access to admin pages/APIs.

#### Scenario: Viewer blocked from admin area
- **WHEN** a `user` requests `/admin/users`
- **THEN** they get 403.

#### Scenario: Admin allowed in admin area
- **WHEN** an `admin` requests `/admin/users`
- **THEN** access is granted.

### Requirement: 3. User management (admin only)

- **SHALL** let admins list/add users with role, disable users, and reset passwords.
- **SHALL** reject duplicate emails with 409.
- **SHALL** invalidate sessions of disabled users and old passwords after reset.

#### Scenario: Admin adds a user
- **WHEN** an admin adds a user with email, password, and role
- **THEN** the user appears in the list and can log in.

#### Scenario: Duplicate email rejected
- **WHEN** an admin adds an existing email
- **THEN** the request fails with 409 without revealing password data.

#### Scenario: Disabled user cannot log in
- **WHEN** an admin disables a user
- **THEN** that user's sessions stop working and login fails.

#### Scenario: Password reset rotates credentials
- **WHEN** an admin resets a user's password
- **THEN** only the new password works.

### Requirement: 4. Repo allow/block (admin only)

- **SHALL** hide blocked repos everywhere for all viewers (grid, repo page, docs, search, facets, assets 404) while keeping content (no re-sync needed to re-allow).
- **SHALL** return 403 for non-admin toggle attempts with no change.

#### Scenario: Blocked repo disappears everywhere
- **WHEN** an admin blocks a repo
- **THEN** it vanishes from the home grid, search results/facets, docs, and its assets return 404.

#### Scenario: Re-allowed repo returns without re-sync
- **WHEN** an admin re-allows a repo
- **THEN** it becomes visible again with stored content intact.

#### Scenario: Non-admin toggle forbidden
- **WHEN** a non-admin attempts to toggle allow/block
- **THEN** they get 403 and nothing changes.

### Requirement: 5. GitHub config visibility (admin only)

- **SHALL** show admins the App installation status, config repo scope, and per-repo sync state.
- **SHALL NOT** display or accept GitHub App secrets in the UI (env-only).

#### Scenario: Admin views GitHub config panel
- **WHEN** an admin opens the GitHub config panel
- **THEN** they see installation status, configured scope from `docmyrepos.config.yml`, and per-repo sync state, with no secrets shown.

### Requirement: 6. Security

- **SHALL** store passwords only as `scrypt` hashes and sign session cookies (HMAC, `SESSION_SECRET`; HTTP-only, SameSite=Lax, Secure in production).
- **SHALL NOT** log passwords, hashes, or raw session tokens.

#### Scenario: Secrets never leak
- **WHEN** auth fails or sync/webhook paths log
- **THEN** messages are generic and logs contain no passwords, hashes, or tokens.
