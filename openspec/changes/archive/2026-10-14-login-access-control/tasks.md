## 1. Auth foundation

- [x] 1.1 Add `users` table + `repos.is_allowed` (default true) migration via Drizzle, and verify `pnpm db:generate` emits it and migrates cleanly from empty
- [x] 1.2 Implement `src/server/auth/password.ts` (scrypt hash/verify, stdlib only) with unit tests for valid, wrong, and malformed hashes
- [x] 1.3 Implement `src/server/auth/session.ts` (HMAC sign/verify cookie `{uid, role, exp, pwv}`, `getSession`, `requireUser`, `requireAdmin`) with unit tests for valid, tampered, expired, and version-mismatch
- [x] 1.4 Add `SESSION_SECRET` + `ADMIN_EMAIL`/`ADMIN_PASSWORD` env validation (fail fast, no secret leakage) with tests

## 2. Login flow

- [x] 2.1 Build `/login` page + login/logout routes (generic 401 message, redirect home on success, clear cookie on logout) with route tests
- [x] 2.2 Gate all pages except `/login` (redirect unauthenticated to login; 403 for `user` on `/admin/*`) with tests

## 3. Admin: users + repos + config

- [x] 3.1 Build admin users UI + APIs (list, add with role, disable, reset password; 409 on duplicate) with tests
- [x] 3.2 Build admin repo allow/block toggle API + UI, and switch `activeRepoVisibility` to allowed-only; verify blocked repos vanish from grid, search, facets, docs, and assets (integration tests)
- [x] 3.3 Build admin GitHub config panel (read-only App/installation status + config scope + sync state; secrets never shown) with tests
- [x] 3.4 Update header (user email, logout, admin link) and run full `pnpm lint/typecheck/test` green
