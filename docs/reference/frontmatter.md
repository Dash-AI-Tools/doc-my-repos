---
type: Reference
title: Frontmatter
description: The frontmatter keys DocMyRepos reads, what each is used for, how documents without frontmatter are handled, and what happens to malformed blocks.
tags: [reference, okf, frontmatter]
status: stable
sources:
  - packages/server/src/docs/frontmatter.ts
  - packages/server/src/docs/extract.ts
  - packages/server/src/sync/document-record.ts
  - packages/core/src/okf-meta.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Frontmatter

Frontmatter is a YAML block at the top of a Markdown file, between two `---` lines. It is optional: a plain document with no frontmatter is synced and shown, with its title taken from its first heading. For the OKF behavior these keys add, see [OKF support](../guides/okf-support.md).

```yaml
---
type: Guide
title: Getting started
description: Run it with Docker, then sync.
tags: [guides, setup]
status: stable
resource: https://example.com/runbook
sources:
  - title: Design notes
    url: https://example.com/design
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2027-10-10
owner_team: platform
---
```

## Known keys

| Key           | Value                          | What it does                                                                                                                                                  |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | string                         | The OKF concept type. Free-form, case kept. Makes a repository OKF. A facet in the filters and in search.                                                     |
| `title`       | string                         | The page title. Without it, the first level-1 heading, then the file name. At most 300 characters.                                                            |
| `description` | string                         | A one-line summary. Shown in the card, used as the search snippet fallback, and used as a folder's summary when it is in `index.md`. At most 1000 characters. |
| `tags`        | list of strings, or one string | A facet. Blank entries and exact duplicates are dropped. At most 100 tags of 256 characters. Indexed for search.                                              |
| `status`      | string                         | A facet. `draft` and `deprecated` (any case) raise a notice above the content.                                                                                |
| `resource`    | string, object or list         | Where the described thing lives. Absolute `http` and `https` URLs become links, anything else is shown as text.                                               |
| `sources`     | string, object or list         | Where the content comes from. Same handling as `resource`. An object may use `url`, `href` or `link` and `title`, `name` or `label`.                          |
| `generated`   | date                           | When the content was produced. Shown in the card.                                                                                                             |
| `verified`    | date                           | When someone last checked it. Shown in the card.                                                                                                              |
| `stale_after` | date                           | After this date a stale warning appears. A future date raises nothing.                                                                                        |
| `okf_version` | string or number               | In the docs-root `index.md` only: declares an OKF bundle and sets the version shown in the badge.                                                             |

Dates are `YYYY-MM-DD` or ISO 8601 with a time (`T` or a space, optional seconds, fraction and `Z` or `+hh:mm`; no offset means UTC). A date alone is valid through the end of that UTC day. Anything else, including an impossible date such as `2026-02-29`, is shown as written with a hint, and never raises a warning. Quote values that YAML would read as another type: `okf_version: "0.2"` is a string, while an unquoted `0.2` is a number (it is still reported as `0.2`).

Every other key is kept exactly as authored and listed in the metadata card, so producer-defined keys such as `owner_team` are never lost. Their order is the order Postgres returns JSONB keys (shorter keys first), not the order in the file. At most 50 unknown keys are shown, nested data is cut after four levels, and long values are shortened.

## Reserved files

`index.md` and `log.md`, at any depth and in any case, are reserved. They keep their frontmatter, but `type`, `tags` and `status` in them are ignored as facets: they are not concepts. Only the `.md` extension is reserved; `index.mdx` is an ordinary document.

## How a block is read

- The block must open with `---` on the first line (a byte order mark is allowed) and close with `---` or `...` on a line of its own.
- It is parsed as YAML 1.2 with the core schema: no timestamps, merge keys or custom tags. Duplicate keys are tolerated and the last one wins.
- A block that cannot be used does not lose the document. If it is not valid YAML, is not a key and value mapping, has no closing fence, or is over a limit (64 KiB, 32 levels of nesting, 10,000 values, 20 aliases), the document is synced as having no metadata, the whole text stays in the body, and a warning goes into the sync run's results.
- A `type` that is not a string is kept in the frontmatter but not used as a facet. A `type` longer than 256 characters is not used either.
- NUL characters are removed and lone surrogates replaced, because Postgres rejects both.

## Title and headings

The title is `title`, else the first level-1 heading, else the file name without its extension. For `index` and `README` the enclosing folder names the page instead. A level-1 heading that repeats the title is hidden on the page, so the title is not shown twice. Headings get stable anchors from [github-slugger](https://github.com/Flet/github-slugger), the same slugs GitHub uses, and appear in the "on this page" list.
