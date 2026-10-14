---
title: Decisions
description: Short records of the design choices that shape DocMyRepos. Search configuration, synchronization without a queue, what is stored, and where diagrams are drawn.
---

# Decisions

Each record states the context, the decision, what follows from it and what was rejected. The full design lives in the OpenSpec change under `openspec/changes/docmyrepos-mvp/`; these pages keep the choices a newcomer is most likely to question.

- [Postgres full-text search with the simple configuration](./0001-postgres-fts-simple.md)
- [Serialize syncs with advisory locks, no job queue](./0002-advisory-locks-no-queue.md)
- [Store parsed documents, not rendered HTML](./0003-store-parsed-documents.md)
- [Render Mermaid diagrams in the browser](./0004-mermaid-client-side.md)

A new decision goes in a new file with the next number, `type: Decision` and `status: accepted`. When a decision is replaced, mark the old one `status: deprecated` and link to the new one.
