# Proposal

## Why

Every page of the portal sits behind the login, so DocMyRepos cannot serve documentation that is meant for everyone, such as an open-source project's guides or a customer-facing handbook. An admin who wants to publish some docs and keep the rest internal has to choose between two portals. The portal should let an admin mark repositories and repository folders as public, let anonymous visitors read them, and keep everything else behind the login exactly as it is.

## What Changes

- **Public repositories and folders.** An admin can mark a repository as public, or a repository folder as public (every repository in it becomes public). Nothing is public by default, and a self-hoster who never uses the feature sees no change at all.
- **Anonymous visitors.** A visitor with no session can read the public repositories: the home page, repository pages, documents, the API reference page and the images of those documents. Everything else still redirects to `/login`, and APIs still answer 401.
- **Sign-in button.** When the portal has public content, the home page is shown to a signed-out visitor instead of redirecting to the login, and the site header shows a **Sign in** button where the account menu would be. When nothing is public, `/` redirects to `/login` as it does today.
- **Configurable public Search and Ask.** Two admin settings decide whether anonymous visitors may use search and Ask. Search is on by default once something is public; Ask is off by default. Anonymous Ask is limited by shared caps (a daily total and a ten-minute total for all anonymous visitors together, plus the existing cap on simultaneous answers); no client address or question is stored.
- **One enforcement point.** The shared visibility filter learns a second reader: an anonymous reader sees only allowed repositories that are public, through the same filter every read already uses. Signed-in users keep seeing every allowed repository.
- **Admin controls.** A Public switch on each row of the Repository access list and on each folder, and a **Public access** section in workspace settings with the Search and Ask switches and the Ask caps.
- **Not changed.** Comments, starring, the status page, the admin pages, tokens and the MCP endpoint stay signed-in only. Anonymous visitors see no comments section. `authorize`, `authenticate` and the other extension hooks keep their contracts.

## Capabilities

### New Capabilities

- `public-access`: which repositories and folders are public, who counts as an anonymous visitor, what an anonymous visitor may and may not reach (pages, APIs, assets, search, Ask), the admin controls, and the rule that nothing leaks beyond the public set.

### Modified Capabilities

- `access-control`: the session gate lets anonymous visitors through to public content and still redirects or answers 401 for everything else; "blocked repos stay hidden for every viewer" stays true, and a repository must be both allowed and public for an anonymous reader.
- `repo-space`: the single visibility filter has two readers (signed in, anonymous); the home page lists only public repositories for an anonymous visitor.
- `repo-folders`: a folder can be public, and the Repository access list and Folders tab show and change it.
- `search`: anonymous visitors may search when the admin allows it, over public repositories only, with the search bar and palette shown only then.
- `ask-docs`: anonymous visitors may ask when the admin allows it, retrieval is limited to public repositories, and anonymous use has its own shared limits.
- `account-menu`: a signed-out visitor on a public page sees a Sign in button instead of nothing.
- `workspace-settings`: a Public access section, saved, validated and audited like the other settings.
- `extension-hooks`: the event catalogue gains `repo.public_changed` and `folder.public_changed`, emitted when an admin changes a Public switch (ids and the new state only, no content).

## Impact

- **Data:** one additive migration: an `is_public` flag on repositories and on repository folders (default false), a marker on Ask usage rows for anonymous questions, and a small settings table; no data moves. Rolling back to the previous image keeps working because older code ignores them.
- **Server (`@docmyrepos/server`):** the visibility filter and every query caller gain a reader; the request context exposes it; the proxy lets anonymous requests reach pages and read APIs and leaves the decision to the routes; the page and route guards (`pageContext`, the route binder) decide per request; Ask gets an anonymous path and shared limits; new admin routes or fields for the flags.
- **UI (`@docmyrepos/ui`):** header Sign in button, hiding of signed-in-only controls (comments, stars, Ask and search entry points) for anonymous visitors, admin switches, a Public access settings section.
- **Public API surface:** `RequestContext` and the exported types change additively, so the package API reports and a changeset (minor) are updated. The `authorize` action set does not change.
- **Security:** this is the first time the portal serves content without a session, so the change carries a leak-proof test matrix (every page, API and asset, anonymous, against one public and one private repository) and keeps the existing rules: sanitized rendering, strict Mermaid, the `/api/asset` path checks, no GitHub call at request time.
- **Docs and specs:** README, `docs/guides/configuration.md`, `docs/architecture/security.md`, `docs/reference/api.md`, and the specs listed above.
- **Out of scope:** public comments, anonymous starring, public documentation sub-folders inside a repository, per-visitor Ask limits or client-address tracking, public MCP, SEO files (sitemap, robots), and any change to the `authorize` hook.
