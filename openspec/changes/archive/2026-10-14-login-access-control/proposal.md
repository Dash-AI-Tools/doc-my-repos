# Proposal: Login & Access Control

## Why

DocMyRepos MVP has no viewer login: anyone who can reach the app sees every synced repo. Operators need an admin login to manage which repos are shown and who can see them, plus regular user accounts for viewers.

## What Changes

- Email + password login with two roles: `admin` and `user` (viewer). First user is bootstrapped as admin via env (`ADMIN_EMAIL`/`ADMIN_PASSWORD`); further users are created by admins in the UI.
- All pages except `/login` require a session; unauthenticated visitors are redirected to login.
- Admins can: list/add users (set role, disable, reset password), toggle per-repo allow/block, and view GitHub sync config status (App installation, config scope).
- Users (viewers) can browse/search only allowed repos; blocked repos disappear everywhere (grid, search, TOC, assets) via the existing visibility chokepoint.
- Sessions are signed HTTP-only cookies (HMAC, stdlib `node:crypto`); passwords hashed with `scrypt` (stdlib). No new runtime dependencies.

## Capabilities

### New Capabilities
- `access-control`: login/logout/session, roles, admin user management, per-repo allow/block enforcement.

### Modified Capabilities
- None (visibility chokepoint in `src/server/queries/visibility.ts` gains an allowed-only condition, which is an implementation change owned by the new spec, not a requirement change to an existing capability — there are no main specs yet; MVP specs live in the change).

## Impact

- New: `users` table, `repos.is_allowed` column + migration, `src/server/auth/*`, `/login` page, `/admin/*` pages, session cookie handling in `proxy.ts`/layout.
- Modified: `activeRepoVisibility` becomes allowed-only; header shows user + logout.
- Env: adds `SESSION_SECRET` (required), `ADMIN_EMAIL` + `ADMIN_PASSWORD` (bootstrap only).
- No new npm dependencies.
