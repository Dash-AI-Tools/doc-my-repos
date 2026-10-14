---
title: Architecture
description: How DocMyRepos is built. The system overview, the sync engine that fills Postgres, the data model and the security model for untrusted documents.
---

# Architecture

DocMyRepos is one Next.js application and one Postgres database. A sync engine copies parsed documents from GitHub into Postgres, and every page reads from Postgres only.

- [System overview](./overview.md): components, request flow and trust boundaries.
- [Sync engine](./sync-engine.md): incremental sync, locks, coalescing, the removal rule and the scheduler.
- [Data model](./data-model.md): the tables and the weighted search vector.
- [Security](./security.md): the threat model for documents from third-party repositories.

The reasons behind the main choices are in [Decisions](../decisions/index.md).
