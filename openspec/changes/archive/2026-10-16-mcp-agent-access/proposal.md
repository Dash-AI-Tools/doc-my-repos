# Proposal

## Why

The documentation DocMyRepos collects is most useful at the moment a developer is working, and increasingly that developer is working with an AI agent (Claude Code, Cursor and similar) that cannot see the portal. Agents guess, or read stale copies. Agents are also now writing documentation, and without the OKF rules in front of them they produce files that are not valid OKF (no `type`, wrong dates, broken links, new vocabulary instead of the repo's own). The portal already holds the synced docs, the search index and the OKF knowledge. It should expose them to agents through the Model Context Protocol (MCP), and help agents write documentation that follows OKF.

## What Changes

- **An MCP server** inside the app, reachable by AI agents over HTTP (MCP Streamable HTTP, stateless) at `/api/mcp`. It is read-only, and everything it returns comes from Postgres through the same visibility filter as the website. It offers these tools:
  - `list_repositories`, `get_repository`: what is synced, which repositories are OKF, where their docs live, and the types, tags and statuses their docs already use.
  - `search_documents`: **gather documents based on a query**, with the website's full-text search and the same filters (repository, type, tag, status), returning titles, paths, types, snippets and links.
  - `get_document`: a document's Markdown, frontmatter, headings and links back to the portal and to GitHub.
  - `get_okf_guidelines`: **find the repository's OKF guidelines file** (`okf-guidelines.md` in its docs) and return it, or, when there is none, return a **generated draft** written from OKF and from the repository's own vocabulary, with instructions to save it in the repo.
  - `validate_okf_document`: check a draft document (and, when a repository is given, its links and vocabulary) against OKF and report errors, warnings and suggestions with fixed codes, so an agent can fix a file before committing it.
  - A prompt, `write-okf-doc`, that walks an agent through: find the guidelines, look for related docs, write, validate.
- **Access by personal API token.** A signed-in user creates tokens on a new **AI agent access** page (name and expiry, shown once, stored only as a hash), sees the connection snippets for common agents, and revokes tokens. A token acts as its user: it sees exactly the repositories that user sees, stops working when the user is disabled or has their password reset, and can do nothing but call the MCP endpoint. Admins can list and revoke all tokens.
- **Agents write docs in the developer's repo, not in the portal.** The portal's GitHub App is read-only and stays that way. The tools return guidance, a draft guidelines file and validation; the agent saves files in the developer's own checkout and the developer commits them, after which the next sync makes them visible.
- **Untrusted content is treated as untrusted.** Documents come from third-party repositories and may contain text aimed at agents. Tool results label document content as data, and no tool acts on it.
- A setting (`mcp.enabled`, default true) lets an operator turn the endpoint off.
- Not changed: the website, search ranking, sync, roles, repository access rules, the GitHub App permissions, and the document format. Not included: write tools that commit to GitHub, OAuth sign-in for agents, MCP resources and subscriptions, a stdio/local variant, and per-token repository scoping.

## Assumptions

- "Gather based on a query" is read as query-driven retrieval of docs, i.e. search. If something else was meant, it changes `search_documents` only.
- The guidelines file is found by a fixed name in the docs folder; no configuration key is added for it.

## Capabilities

### New Capabilities

- `agent-tokens`: personal API tokens for the MCP endpoint, how they are created, shown, listed, expired, revoked and checked, and what they can and cannot do.
- `mcp-server`: the MCP endpoint, its transport, the read tools and prompt, result safety and limits, and the on/off setting.
- `okf-authoring`: the OKF guidelines lookup and generated draft, and the OKF validation of a draft document.

### Modified Capabilities

- None. The related behavior (search, OKF parsing and detection, access control, visibility) is specified in the main specs under `openspec/specs/`. These capabilities reuse it and add new entry points; they do not rewrite those requirements.

## Impact

- Data: new `api_tokens` table (user, name, token hash, prefix, expiry, revoked and last-used times) and a Drizzle migration.
- Dependency: the official `@modelcontextprotocol/sdk` (pinned, at least two weeks old, audited). It is the first dependency added since the stack was fixed in `CLAUDE.md`, so the choice and the alternative (hand-written JSON-RPC) are in `design.md`.
- Server: new `src/server/mcp/` (tools, auth, limits), pure OKF helpers in `src/lib/okf-authoring/` (validation rules, draft generation, guidelines lookup names) reusing the existing frontmatter parser and `okf-meta` limits, and a route `src/app/api/mcp/route.ts`. New reads (guidelines lookup, vocabulary) go through `src/server/queries/` and are registered in `QUERY_FUNCTIONS`; no other code reads the tables.
- Auth and headers: `src/proxy.ts` lets exactly `/api/mcp` past the session gate (the route authenticates the bearer token itself); the route rejects requests carrying a foreign `Origin`.
- Settings: `mcp.enabled` is a workspace setting (default true) in the settings schema next to `comments.enabled`, stored in the database and edited with a checkbox beside "Allow comments" on Workspace configuration. It applies without a restart.
- UI: `/account/agent-access` (create, list, revoke, connection snippets), an admin token list with revoke, and a link to the page in the account menu.
- Tests: unit tests for validation and draft generation, query and enforcement tests, route tests for auth, origin, limits and each tool, token lifecycle tests, a test using the SDK client against the route, component tests, and e2e.
- Docs: `README.md` (connecting an agent, the tools, the token model, what the server will not do) and `docs/` pages for the tools and the OKF authoring flow, which the app's own docs already publish.
