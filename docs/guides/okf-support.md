---
type: Guide
title: OKF support
description: What Open Knowledge Format is, how DocMyRepos decides a repository is OKF, and what an OKF repository gets. A metadata card, notices, type filters and the reserved index and log files.
tags: [guides, okf]
status: stable
resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
sources:
  - src/server/docs/okf.ts
  - src/server/docs/frontmatter.ts
  - src/lib/okf-meta.ts
  - src/lib/toc-filters.ts
  - src/server/queries/search.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# OKF support

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF) is a convention for writing knowledge as Markdown files with YAML frontmatter. DocMyRepos follows OKF v0.2. The ground rules it relies on:

- Only `type` is required in a document's frontmatter.
- `type` is a free-form string. DocMyRepos never keeps a list of types and never changes their case.
- Unknown frontmatter keys are preserved and shown.
- `index.md` and `log.md` are reserved. They are not concepts.
- Links are ordinary Markdown links, and a broken link must not break the page.

A minimal OKF document:

```markdown
---
type: Metric
tags: [finance, kpi]
status: draft
owner_team: growth
---

# Monthly revenue

Recognized revenue per calendar month.
```

The OKF spec defines no `docs/` folder, so finding the folder is DocMyRepos' own convention: `docs`, `doc` or `documentation`, or the `docsPath` from the [configuration](./configuration.md).

## How a repository is detected

A repository is OKF when its docs folder contains a Markdown file whose frontmatter has a `type` key, or when the docs-root `index.md` declares `okf_version`. Anything else is plain Markdown.

| Situation                                           | OKF?                                |
| --------------------------------------------------- | ----------------------------------- |
| A document has `type: Metric`                       | yes                                 |
| A document has `type:` with no value, or `type: ""` | yes: the key is present             |
| Only `index.md` or `log.md` files have a `type`     | no: reserved files are not concepts |
| `docs/index.md` has `okf_version: "0.2"`            | yes, and the version is shown       |
| `docs/guides/index.md` has `okf_version`            | no: only the docs-root index counts |
| Frontmatter has `title` and `tags` but no `type`    | no                                  |

The test is key presence, so a malformed value still counts. A `type` that is not a string stays in the stored frontmatter but is not used as a filter value. The result is stored as `repos.is_okf` and `repos.okf_version` on every sync. A plain Markdown repository shows no OKF controls at all: no badge, no card, no filters.

## What an OKF repository gets

**Badge.** Repository cards and headers show an OKF badge, with the version when the root index declares one.

**Metadata card.** Each document page shows a card with the type, tags, status, description, resource link, sources, and the `generated` and `verified` dates. Unknown keys are listed too, so producer-defined keys such as `owner_team` are never hidden. Values are cleaned for display, nested data is capped, and only absolute `http` or `https` URLs become links. The full list of keys is in the [frontmatter reference](../reference/frontmatter.md).

**Notices.** A visible notice appears above the content when:

- `status` is `deprecated` (a deprecation notice), or `draft` (a draft notice), ignoring case;
- `stale_after` is in the past (a stale warning with the date).

A date in the future raises nothing, and the card just shows it. A date alone is valid through the end of that UTC day. A value that is not a date is shown as written, with a hint, and never raises a warning.

**Type filters.** The table of contents of an OKF repository shows the distinct `type` values as chips, each with the number of documents. Tags and statuses work the same way. Selecting a chip narrows the tree to the matching documents together with their folders. Chips of one kind are OR-ed and different kinds are AND-ed. The filters live in the page URL as `?type=Guide&tag=search`, so they survive a reload and can be shared. Values are shown exactly as authored: `Metric` and `metric` are two chips, never merged.

**Reserved files.** `index.md` summarizes its folder. The folder entry in the table of contents links to it and shows its `description` as the summary. `log.md` is shown as a change log: a labelled page that keeps its entries in the order written, with a marker on each `##` entry heading, and it sorts last in its folder. Neither file appears in type, tag or status counts, and neither matches a filter.

**Tolerance.** A document with only `type: Note` is shown with its first level-1 heading, or else its file name, as the title, and no errors. Missing optional fields and broken links never fail a page.

## This repository

The `docs/` folder you are reading is an OKF bundle. It uses five types (Concept, Guide, Reference, Runbook, Decision), declares `okf_version: "0.2"` in its root [index](../index.md), and keeps a [change log](../log.md). A test, `src/server/docs/dogfood.test.ts`, syncs this folder into a throwaway database and checks the detection, the type counts, every link and the search results, so the documentation cannot silently drift from what the portal can display.
