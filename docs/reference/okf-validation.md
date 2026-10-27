---
type: Reference
title: OKF validation codes
description: Every finding the OKF validator can report, with its severity, what it means and how to fix it, the limits it applies, how the repository's vocabulary and relative links are checked, and how it agrees with the sync.
tags: [reference, okf, validation, mcp]
status: stable
sources:
  - packages/server/src/docs/okf-validate.ts
  - packages/server/src/docs/okf-validate.agreement.test.ts
  - packages/server/src/sync/document-record.ts
generated: 2026-10-16
verified: 2026-10-16
stale_after: 2999-01-01
---

# OKF validation codes

The `validate_okf_document` tool checks Markdown against Open Knowledge Format (OKF) and the portal's own rules. It returns `valid` and a list of findings. `valid` is true when no finding is an error. Warnings and info never make a document invalid. The workflow around it is described in [Writing OKF documents with an agent](../guides/okf-authoring.md).

## What a finding contains

| Field        | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `code`       | A fixed code from the tables below.                                                           |
| `severity`   | `error`, `warning` or `info`.                                                                 |
| `message`    | A fixed sentence for the code. It never quotes the document.                                  |
| `key`        | The frontmatter key the finding is about, when it is about one.                               |
| `line`       | The 1-based line in the content that was checked, when one applies.                           |
| `excerpt`    | A short excerpt of the offending value: cleaned of control characters, at most 80 characters. |
| `suggestion` | What to do, or the repository's existing values for a new type, tag or status.                |

## Errors

| Code                   | Meaning and fix                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontmatter-missing`  | The file has no frontmatter block. Start it with `---`, a `type`, and a closing `---`. The finding carries a suggested block. Not raised for `index.md` and `log.md`. |
| `frontmatter-unclosed` | The block opens with `---` but is never closed with a `---` line. The portal ignores it.                                                                              |
| `frontmatter-invalid`  | The block is not a YAML mapping, or is too large or too deeply nested. A file with CR-only line endings gets a hint to use LF or CRLF.                                |
| `type-missing`         | There is no `type`, or it is empty or blank. Every concept document needs one. Not raised for `index.md` and `log.md`.                                                |
| `type-not-text`        | The `type` is a number, a list, a mapping or a boolean. Write it as text, for example `type: Runbook`.                                                                |
| `type-too-long`        | The `type` is longer than 256 characters, so the portal does not use it.                                                                                              |
| `field-shape`          | `tags`, `status` or `sources` has a shape the portal drops. The finding names the key (below).                                                                        |
| `content-too-large`    | The content is over 256 KB, the same limit the sync applies, so nothing was validated.                                                                                |

The shapes behind `field-shape`:

- `tags`: a list of text values, or one text value. At most 100 entries, each at most 256 characters.
- `status`: one text value of at most 256 characters.
- `sources`: text, a mapping such as `{title: Spec, url: https://example.com}`, or a list of those.

## Warnings

| Code                  | Meaning and fix                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `date-invalid`        | `generated`, `verified` or `stale_after` is not a date. Use `YYYY-MM-DD` or an ISO date with a time. A date that does not exist is invalid.   |
| `stale-past`          | `stale_after` has passed, so the portal shows the document as stale. A date alone is stale from the start of the next UTC day.                |
| `title-long`          | The title, or the first heading when there is no `title`, is longer than 300 characters. The portal cuts it.                                  |
| `description-long`    | The description is longer than 1000 characters. The portal cuts it.                                                                           |
| `description-missing` | There is no description. One or two sentences help search and the agents that read it.                                                        |
| `h1-missing`          | The document has no level-1 heading.                                                                                                          |
| `h1-multiple`         | The document has more than one level-1 heading. The finding gives the line of the second.                                                     |
| `link-broken`         | A relative link points to a document that is not among the repository's synced documents. The finding gives the line and the link as written. |

## Info

| Code                | Meaning                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `type-new`          | No other document of the repository has this `type`. The `suggestion` lists the types in use.                     |
| `tag-new`           | No other document has this tag. One finding per new tag, at most ten. The `suggestion` lists the tags in use.     |
| `status-new`        | No other document has this status. The `suggestion` lists the statuses in use.                                    |
| `status-draft`      | The status is `draft` (any case). The portal marks the document as a draft.                                       |
| `status-deprecated` | The status is `deprecated` (any case). The portal marks the document as deprecated.                               |
| `reserved-typed`    | `index.md` or `log.md` declares a `type`. They are reserved files and not concepts, so they should not carry one. |

Values are compared exactly, so `runbook` is new in a repository that uses `Runbook`. Nothing is compared when the repository has no documents with that kind of value, and no `-new` finding is raised without a repository.

## Relative links

When a repository is given, relative links are resolved from the document's own path and looked up among the repository's synced documents. The check never fetches anything.

- `./other.md`, `../folder/page.md`, `other` (no extension, so `other.md`, `other.mdx` and `other/index.md` are tried) and `folder/` are checked, with any `#anchor` or `?query` ignored.
- Not checked: absolute URLs, `mailto:`, anchors alone, images, links to files that are not documents (such as a `.yaml` file), paths that start with `/`, and links that leave the docs folder. A link to the repository's `README.md` or to any file outside the docs folder becomes a GitHub link in the portal, which cannot be judged from the synced documents.
- Links inside code spans and fenced code blocks, and footnote definitions, are not links.
- At most 25 broken links are reported.

## Limits and safety

- Content over 256 KB is not validated. The frontmatter block is limited as the sync limits it: 64 KiB, 32 levels of nesting, 10,000 values and 20 aliases. A document over a limit gets `frontmatter-invalid`, and the check returns promptly.
- Nothing is stored, logged, rendered or executed. The content is parsed as text.
- Messages are fixed. The only text taken from the document is an excerpt of at most 80 characters and, for a new type, tag or status, the repository's own existing values.

## Agreement with the sync

A document with no error is one the sync stores with a `type` and shows as an OKF concept. A document with an error is one the sync would not treat as a concept, with one exception: for `field-shape` the portal keeps the document and its type and drops only the unusable field, and the validator reports an error so the field is fixed rather than lost silently. The reserved `index.md` and `log.md` are stored as reserved files and never as concepts. A test checks all of this on a set of fixtures and on every document of these docs.
