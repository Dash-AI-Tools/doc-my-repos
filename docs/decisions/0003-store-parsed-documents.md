---
type: Decision
title: Store parsed documents, not rendered HTML
description: The sync stores each document's Markdown body, frontmatter, headings and derived fields. HTML is produced when a page is requested, so renderer fixes need no re-sync.
tags: [decisions, sync, markdown]
status: accepted
sources:
  - openspec/changes/archive/2026-10-14-docmyrepos-mvp/design.md
  - src/server/sync/document-record.ts
  - src/server/markdown/pipeline.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Store parsed documents, not rendered HTML

## Context

Documents are untrusted Markdown. The portal rewrites links and images, highlights code and sanitizes the result, and those rules change as the renderer improves. Link rewriting also depends on the full set of documents in a repository: a link is in-app only if its target is synced.

## Decision

The sync stores the parsed document: the Markdown body after the frontmatter, the frontmatter as JSON with every key as authored, the headings with their slugs, and the derived title, description, type, tags and status. The `documents` table never holds HTML. Pages render the body when they are requested, with the link context of that moment, and the sanitizer runs last.

## Consequences

- A renderer or sanitizer fix applies to every document immediately, with no re-sync.
- A link to a document that is added later starts working without touching the document that contains the link.
- Search indexes the same stored fields that the pages show, so the two cannot drift.
- Every page request pays for rendering. The cost is bounded: files are capped at 256 KB at sync time, parsing is chunked so hostile input cannot go quadratic, and a hostile 256 KB document renders in about a second at worst.
- Heading slugs are computed at sync time and again at render time with the same library, and the pipeline's slugs must stay equal to the stored ones, because search results deep-link by stored slug. A parity test between the sync's heading extraction and the pipeline keeps them equal.

## Alternatives considered

- **Store rendered HTML.** Faster reads, but stale whenever the renderer changes, and link rewriting would have to be redone for every document when any document is added or removed.
- **Store the raw GitHub response.** Keeps parsing on the read path and gives search nothing to index.

See the [security model](../architecture/security.md#sanitizer) for why the sanitizer is the last step.
