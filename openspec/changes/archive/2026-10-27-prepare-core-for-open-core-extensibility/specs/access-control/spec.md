# Spec Delta

## MODIFIED Requirements

### Requirement: 1. Login and session

- **SHALL** redirect unauthenticated visitors on any page except `/login` to `/login`.
- **SHALL** set a signed HTTP-only session cookie on valid login and redirect home.
- **SHALL** return generic 401 on invalid credentials with no session set.
- **SHALL** clear the session cookie on logout.
- **SHALL NOT** apply the session gate to the machine endpoints `POST /api/sync` and `POST /api/webhooks/github`. They have their own authentication (`SYNC_SECRET` bearer token, webhook HMAC signature) and callers (GitHub, cron) have no session cookie.
- **SHALL** confirm the session's user in the database (exists, enabled, same password version and role) on every page and API behind the session gate before reading content, not only check the cookie signature.
- **SHALL** accept a session only for the tenant it was issued for; a cookie that names no tenant is valid only for the built-in tenant.
- **SHALL NOT** apply the session gate to plugin paths under a `public/` segment (`/-/<id>/public/…`, `/api/plugins/<id>/public/…`) or to extra public paths a host app configures; every other plugin path is gated like a core page or API.

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

#### Scenario: Disabled user's cookie stops working on content pages
- **WHEN** an admin disables a user and that user, with an unexpired cookie, opens the home page or a document
- **THEN** they are redirected to `/login`, and an API call answers 401.

#### Scenario: Cookie from another tenant
- **WHEN** a valid cookie issued for tenant `a` is sent with a request resolved to tenant `b`
- **THEN** the request is treated as unauthenticated.

#### Scenario: Plugin public path
- **WHEN** an unauthenticated request reaches `/-/billing/public/pricing`
- **THEN** the proxy passes it through, and the plugin dispatcher serves it only if the plugin declared that page public.
