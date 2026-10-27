# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: newcomers and cross-team readers inside a GitHub organization. People onboarding, or from another team, who browse repository spaces to understand what exists, how it works, and who owns it, and who search the whole org's docs rather than guess which repo holds an answer.

Secondary (confirmed by the repo, not by the interview): the operator who registers the GitHub App, picks which repositories are visible, manages users under Admin, and watches sync status.

## Product Purpose

DocMyRepos is an open-source, self-hostable web app that syncs the `docs/` folders of a GitHub organization's repositories into Postgres and serves them as one searchable documentation portal. Every repository gets its own space (README, code owners from `CODEOWNERS`, docs tree); the whole org gets one search box with a Ctrl/Cmd+K palette. Success: a reader finds the right document, or the right owner, without knowing which repo to look in.

## Positioning

Docs stay in the repos. No migration, no separate authoring tool, no static-site build step: authors keep writing Markdown in each repo's docs folder and the portal appears on top. Access is a read-only GitHub App installation, never a personal access token, and pages read only from Postgres. First-class support for Open Knowledge Format (OKF) is a bonus for repos that use it, not the core pitch.

## Operating Context

- Content is plain Markdown (GFM, code, Mermaid diagrams) written by many authors across many repos, so quality and structure vary. Docs are untrusted third-party input: output is sanitized and `.mdx` is never executed.
- Content freshness comes from GitHub webhooks plus a scheduled full sync; syncs are incremental and a failed sync keeps previous content.
- The portal sits behind a login (admin-created users). Admins choose which repositories are visible.
- Self-hosted via Docker/Compose with Postgres; screenshots in the README are generated from seeded demo data (`pnpm screenshots`).

## Capabilities and Constraints

- Home grid of repos; per-repo page with README, code owners panel, docs tree; document page with outline, pager, breadcrumbs, change log.
- Markdown rendering: GFM, Shiki highlighting, Mermaid (client-side, strict), heading anchors, link/image rewriting, image proxy.
- Full-text search (Postgres FTS) with highlighted snippets, facets, and a command palette.
- OKF-aware UI (type, tags, status, metadata card, notices) appears only for repos detected as OKF. `type` is a free-form string: never hardcode or normalize types. Non-OKF repos show no OKF UI.
- Admin screens: users, repository access, sync status.
- Stack is fixed: Next.js App Router, React, TypeScript strict, Tailwind v4, `next-themes`.
- Open decision: no visual identity (logo, palette, type) has been confirmed as binding.

## Brand Commitments

Name: DocMyRepos. No logo, color, or voice commitments recorded; none to be assumed.

## Evidence on Hand

- Real screenshots of the current UI in `docs-assets/screenshots/` (light and dark), generated from seeded demo data.
- README, `docs/`, and the OpenSpec specs in `openspec/specs/` describe behavior.
- No customer logos, testimonials, benchmarks, or usage numbers exist; do not fabricate them.

## Product Principles

1. Reading comes first. The product exists so people understand someone else's documentation; every screen serves comprehension and orientation over decoration.
2. Findable before browsable. Search and the palette are the fastest path from question to answer, and repo spaces answer "what exists and who owns it".
3. The repo is the source of truth. The portal presents and never edits; it should make provenance (repo, path, owner, freshness) legible.
4. Untrusted, uneven content. Design for messy, broken, or missing docs and metadata without breaking; tolerate unknown frontmatter and missing fields.
5. Quiet for non-OKF, rich where OKF exists. Extra structure appears only when the data supports it.

## Accessibility & Inclusion

Light, dark, and system themes must all work, including code blocks and Mermaid diagrams, with no flash on load. No further formal standard was confirmed.
