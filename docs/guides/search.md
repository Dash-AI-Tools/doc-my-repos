---
type: Guide
title: Search
description: How to search across all synced repositories. Query syntax (quotes, or, minus), what ranks first, the type, tag, status and repository filters, and the command palette.
tags: [guides, search]
status: stable
sources:
  - packages/server/src/queries/search.ts
  - packages/core/src/search.ts
  - packages/core/src/search-params.ts
  - packages/core/src/palette.ts
  - packages/server/src/search-api.ts
  - packages/server/src/search-page.ts
  - packages/server/src/public-access/reader.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Search

Search covers the titles, headings, descriptions, tags and body text of every synced document in every repository. It is built on Postgres full-text search, so there is no separate search service. Use it from the `/search` page, from the search box on the home page, or from the command palette on any page.

## Query syntax

The query is plain text, read by Postgres `websearch_to_tsquery`. It follows the rules people know from web search engines.

| You type              | It means                                                         |
| --------------------- | ---------------------------------------------------------------- |
| `sync engine`         | Documents that contain both words, anywhere in the indexed text. |
| `"removal rule"`      | The words next to each other, in that order.                     |
| `webhook or schedule` | Documents that contain either word.                              |
| `sync -scheduler`     | Documents that contain `sync` and do not contain `scheduler`.    |

Matching is case-insensitive. Punctuation and unknown syntax are ignored instead of failing: a query such as `"unclosed & | ! (` returns results or an empty state, never an error, because the text reaches Postgres only as a bound parameter and no query string is ever assembled by hand. A query that is only negated terms (`-draft`) matches nothing rather than everything. Queries are cut to 256 characters.

Words are matched as written. There is no stemming, so `deploy` does not find `deployment` and `webhook` does not find `webhooks`.[^simple] Search for the form the documents use, or combine forms with `or`.

## What ranks first

Each field has a weight, and a match in a heavier field outranks any number of matches in a lighter one:

1. title
2. headings
3. description and tags
4. body

So a document called "Deployment" ranks above one that mentions deployment once in its body. Ranking does not normalize for document length, because that would let a short body-only match beat a long document whose title matches. Equal ranks are ordered by repository, then by path, so pages are stable.

## Reading a result

Each result shows the document title, its repository and path, and a snippet with the matched words highlighted. A snippet is plain text: the Markdown and HTML of the source are stripped, so it never contains markup. When the best matching heading is not the document's title, the result shows it as a section and links straight to it with an `#anchor`. Documents from OKF repositories also show their type and status.

`index.md` and `log.md` are reserved files. They are found by their text, but they never count as a type, tag or status, because they are not concepts.

## Filters

On `/search`, the filter panel lets you narrow results by repository and, where documents have them, by OKF type, tag and status. Each value shows how many results it would give.

- Values of one kind are OR-ed (`type=Concept&type=Guide`), and different kinds are AND-ed.
- Type, tag and status are exact and case-sensitive. `Guide` and `guide` are two values.
- Counts are disjunctive: selecting a type still shows the counts of the other types, so you can widen the choice.
- The query and filters live in the URL, so a search is shareable:

```text
/search?q=sync&repo=acme%2Fdoc-my-repos&type=Concept&tag=architecture
```

The accepted parameters are `q`, `repo` (`owner/name`, ignoring case), `type`, `tag`, `status`, `page` (1-based) and `limit` (1 to 100, default 20). Paging stops at about the 1000th result, so narrow the query instead of paging deeper.

## Command palette

Press `Ctrl+K` or `⌘K` on any page to open the palette. It shows live results as you type.

- The arrow keys move through the results, `Enter` opens the active one, and `Ctrl+Enter` or `⌘+Enter` opens it in a new tab.
- `Enter` with no active result opens the full results page for the query.
- `Esc` closes the palette and returns focus to where it was.

The palette asks `GET /api/search` for 8 results (the API allows at most 10). See the [HTTP API reference](../reference/api.md#get-apisearch).

## Who can search

Signed-in users search every repository an admin has not blocked. When an admin marks repositories or folders public (see [Public access](configuration.md#public-access)), visitors who are not signed in can search too, unless the admin turns that off with **Allow search** on the Repository access tab. They get the same search bar, quick search, results page and `GET /api/search`, but over the public repositories only: results, snippets, filters and the counts next to them never include anything else. With **Allow search** off, or with nothing public, the search bar is not shown to them and `/search` and `/api/search` send them to sign in (`401` for the API).

## Under the hood

The ranking weights and the stored vector are described in the [data model](../architecture/data-model.md#search-vector). The reasoning for the `simple` configuration is in [Decision: Postgres full-text search with the simple configuration](../decisions/0001-postgres-fts-simple.md).

[^simple]: The text search configuration is `simple`. It lower-cases and splits text but applies no stemming and no stop words, so documents in any language match. The cost is the exact-form matching described here.
