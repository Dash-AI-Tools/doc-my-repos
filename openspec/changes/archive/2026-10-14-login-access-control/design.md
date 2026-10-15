# Design: Login & Access Control

## Decisions

1. **No new dependencies.** Password hashing via `node:crypto` `scrypt`, session cookie HMAC-SHA256 via `node:crypto`. Rationale: two small pure functions; NextAuth/iron-session add weight the MVP deliberately avoided.
2. **Stateless session cookie.** Payload `{uid, role, exp}` (7-day expiry, sliding refresh) base64url + HMAC. No session table; disable takes effect because every request re-reads `users` row (disabled flag + password version). Stateless = no new table, instant revoke via version bump.
3. **Enforcement points.** `proxy.ts` stays crypto-light (no DB): it only checks cookie presence/signature shape for redirect of pages; real authorization happens server-side in layouts/route handlers via `requireUser()`/`requireAdmin()` reading the DB. Queries keep working unchanged — `activeRepoVisibility` becomes `is_allowed = true` ANDed in, so every existing read (repos, docs, search, facets, assets) hides blocked repos with zero caller changes.
4. **Schema.** `users(id, email unique, password_hash, role admin|user, disabled bool default false, pw_version int default 0, timestamps)`. `repos.is_allowed bool default true` + index. Cookie carries `pw_version`; mismatch = re-login (covers reset/disable).
5. **Bootstrap.** If `users` is empty and `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set, first login with those credentials creates the admin user (then env creds are ignored). No seed scripts.
6. **GitHub config panel.** Read-only display of parsed `docmyrepos.config.yml` scope + installation/sync status (reuse status queries); the only mutation is the allow/block toggle (updates `repos.is_allowed`). App secrets never touch the UI.

## Alternatives rejected

- NextAuth/Auth.js: full OAuth support we don't need yet; GitHub OAuth login is a follow-up, this change is local accounts.
- Session table: extra migration + cleanup job for no benefit at this scale.
- Per-user per-repo grants: requested behavior is satisfiable with a global allow/block; per-user matrix deferred (schema supports it later via a grants table).

## Risks

- `SESSION_SECRET` missing = auth refuses to start (fail fast at boot, named env error, existing env-validation pattern).
- Cookie size trivial (<200B). CSRF: mutations are same-origin POSTs with SameSite=Lax; no cross-site flows.
