# @docmyrepos/core

## 0.2.0

### Minor Changes

- 6afc552: First release of the packages: `createApp` with hooks (tenant, authentication, authorization, entitlements, events), adapters (database, secrets, blob storage, email, jobs) and plugins (routes, pages, jobs, schedules, migrations and UI slots). The open-source app is built from them and behaves as before.
- Public access: an admin can make repositories, or whole folders of repositories, readable without signing in. A visitor without a session sees the public repositories on the home page, can read their documents, API references and images, and gets a Sign in button in the header; everything else still needs a login. Anonymous search is on by default once something is public, and anonymous Ask is off by default and limited by caps shared by all anonymous visitors. Nothing is public until an admin marks it, so a workspace that never does sees no change.

  Extension surface:

  - Two new domain events, `repo.public_changed` and `folder.public_changed` (ids and the new state only), in `EVENT_NAMES` and `EventPayloads`.
  - `RequestContext` and the hooks are unchanged: an anonymous reader is decided by the core from the workspace's public marks, `authenticate` still returns `null` for a visitor, and `authorize` is not asked about anonymous reads.
  - The database gains `is_public` on repositories and repository folders, an `anonymous` marker on Ask usage rows and a `public_access_settings` table. The migration is additive; the previous release ignores them.

  Behavior note: every image the image proxy serves is now `Cache-Control: private, max-age=300` (images of repositories that are public on GitHub were `public`), so a shared cache never keeps an image that depends on who asked.
