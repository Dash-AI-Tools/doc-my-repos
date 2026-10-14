# Security policy

DocMyRepos renders documentation from third-party repositories and holds GitHub App credentials, so we take security reports seriously.

## Supported versions

DocMyRepos has no tagged releases yet. Until it does, only the latest commit on the `main` branch is supported: please check that a problem still exists there before you report it. Once releases exist, the latest minor release will receive security fixes.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it privately with GitHub's private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem (or go straight to <https://github.com/Dash-AI-Tools/doc-my-repos/security/advisories/new>). Only the maintainers can read the report.

Please include:

- what you found and the impact you expect (what an attacker gains);
- the version or commit, and how you run DocMyRepos (Docker or not, behind which proxy);
- steps or a proof of concept that reproduces it, for example the Markdown document or request that triggers it;
- whether you want to be credited in the advisory.

Never include real credentials, private keys or tokens in a report.

## What to expect

We aim to acknowledge a report within a few working days, to tell you whether we consider it a vulnerability after we have reproduced it, and to keep you informed until a fix is released. We prefer coordinated disclosure: we publish a GitHub security advisory with the fix and credit you if you wish. Please give us reasonable time to fix a problem before you disclose it. These are goals of a small open-source project, not a service-level agreement.

## Scope

In scope:

- Script injection or sanitizer bypass through Markdown, frontmatter, MDX files, Mermaid diagrams, SVG or images from a synced repository (XSS).
- A bypass or weakening of the Content-Security-Policy or the other security headers set by the app.
- Reading content that should be hidden: a bypass of the visibility filter (repositories excluded by the config, removed or unsynced repositories) in pages, search, facets or the image proxy.
- Path traversal, server-side request forgery, or serving non-image content through `/api/asset`.
- A forged or replayed webhook that is accepted, or a manual sync that works without `SYNC_SECRET`.
- Leaking the GitHub App private key, installation tokens, webhook or sync secrets, or the database credentials to the browser, the logs or error messages.
- SQL injection, or building search queries from user input.
- Container image or compose findings that weaken the documented hardening (for example a secret baked into the image or running as root).

Out of scope:

- **The absence of a login.** The MVP is single-tenant: anyone who can reach the app can read what it has synced. This is documented; put authentication in front of the app if private repositories are synced.
- Findings that need a malicious operator or write access to the server, the database or the GitHub App.
- Denial of service by volume (many requests, very large organizations). Rate limiting belongs to the reverse proxy, and the sync has documented caps (`limits` in the config).
- Missing security headers on a deployment where your own proxy removes or overrides them, and clickjacking of pages that are not framable anyway.
- Vulnerabilities in a dependency without a demonstrated impact on DocMyRepos (report those upstream; Dependabot tracks updates here).
- Reports from automated scanners without a working proof of concept.

## Hardening your deployment

- Install the GitHub App read-only (Contents and Metadata) and only on the repositories you want shown. Rotate its private key, the webhook secret and `SYNC_SECRET` as described in the [setup guide](docs/github-app-setup.md#rotating).
- Terminate TLS at a reverse proxy that overwrites `X-Forwarded-Proto`, rate-limits `/api/search`, `/api/sync` and `/api/status`, does not cache HTML and does not add its own security headers. See the README's [Reverse proxy](README.md#reverse-proxy) section.
- Do not publish the database port in production. Use strong, unique database credentials and, if you can, a private network between the app and the database.
- Keep `LOG_LEVEL` at `info` or above, and never set `E2E_FIXTURES`.
- Keep the image and its base image up to date.
