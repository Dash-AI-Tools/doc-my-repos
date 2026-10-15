---
type: Decision
title: Postgres full-text search with the simple configuration
description: Search uses a generated weighted tsvector in Postgres with the language-neutral simple text search configuration. Words match in every language, at the cost of no stemming.
tags: [decisions, search, database]
status: accepted
sources:
  - openspec/changes/archive/2026-10-14-docmyrepos-mvp/design.md
  - src/server/db/schema.ts
  - src/server/queries/search.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Postgres full-text search with the simple configuration

## Context

Documents come from many repositories, in any language, and the search requirements make no promise about language or stemming. The project already needs Postgres for everything else, and a search service of its own would be one more thing to run for a portal-sized corpus.

## Decision

Search uses a generated, stored `tsvector` column with weights (title A, headings B, description and tags C, body D) and a GIN index. Queries use `websearch_to_tsquery` with the user's text as a bound parameter, and `ts_headline` for snippets.

The text search configuration is `simple`. It is fixed in the migration and exported as `SEARCH_TEXT_CONFIG`, and every query passes the same configuration. It is not an environment option: the vector is computed at write time, so a runtime switch would silently compare queries against lexemes made with another configuration.

## Consequences

- A word matches in every language, with no list of stop words to maintain.
- There is no stemming. `deploy` does not match `deployment`, and `webhook` does not match `webhooks`. The [search guide](../guides/search.md) tells users to search the form the documents use.
- Changing the configuration later is a new migration that recomputes the column. That rewrites the table and rebuilds the index, which is cheap at this scale.
- No separate service to deploy, back up or keep in sync with the database.

## Alternatives considered

- **An English configuration.** Stemming helps English prose but silently degrades every other language, and drops English stop words from phrase queries.
- **SQLite FTS5.** Simpler to self-host, but the project chose Postgres for everything else.
- **An external engine such as Meilisearch.** An extra service and a second copy of the data, not needed at this scale.

See also the [data model](../architecture/data-model.md#search-vector) for the vector's definition.
