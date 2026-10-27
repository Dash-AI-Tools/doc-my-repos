---
type: Guide
title: Writing OKF documents with an agent
description: How an AI agent connected to DocMyRepos finds or drafts a repository's OKF guidelines, looks at related documents, writes a document in the developer's checkout, validates it and hands it back for review. What the tools do, and what they never do.
tags: [guides, okf, ai, mcp]
status: stable
sources:
  - packages/server/src/docs/okf-validate.ts
  - packages/core/src/okf-authoring/guidelines.ts
  - packages/core/src/okf-authoring/names.ts
  - packages/server/src/queries/documents.ts
generated: 2026-10-16
verified: 2026-10-16
stale_after: 2999-01-01
---

# Writing OKF documents with an agent

An AI agent that can read DocMyRepos can also help write documentation that follows [Open Knowledge Format](./okf-support.md) (OKF) and the conventions of the repository it is writing for. It does this with a small set of read-only tools. The agent writes the file in the developer's own checkout, and the developer commits it. DocMyRepos never writes to GitHub: its GitHub App is read-only.

To connect an agent and create a token, see [AI agent access](../../README.md#ai-agent-access). Every tool, its arguments and its limits are in the [MCP server reference](../reference/mcp.md).

## The flow

An MCP prompt named `write-okf-doc` walks an agent through these steps, and a developer can follow the same ones by hand.

1. **Find the guidelines.** The agent calls `get_okf_guidelines` for the repository. If the repository has an `okf-guidelines.md`, the tool returns it. If not, it returns a generated draft, the path to save it at, and instructions.
2. **Look at related documents.** It calls `search_documents` with a query for the topic, and `get_repository` for the document outline and the types, tags and statuses already in use. It reads the closest documents with `get_document` and reuses their vocabulary.
3. **Write the document** in the checkout, following the guidelines: frontmatter first, a `type`, a description, one level-1 heading, relative links to other documents.
4. **Validate it.** It calls `validate_okf_document` with the file's content, its repository-relative path and the repository, and fixes every error and, where it makes sense, every warning.
5. **Hand it back.** The developer reviews the file and commits it. It shows up in the portal after the next sync, so the agent must not say it is published before then.

## The guidelines file

A repository keeps its guidelines in a file named `okf-guidelines.md` in the docs folder, or else in the docs folder's `guides` folder. The name is matched without regard to case, and no setting is needed. `get_okf_guidelines` returns the file with its path and a link to the page in the portal.

When there is no such file, the tool returns `found: false` with a **draft**, built without any model or outside service from the OKF rules and from the repository's own documents:

- the rules: `type` is the only required key and is free-form; the known keys and their value shapes; the date formats; the reserved `index.md` and `log.md`; how to link between documents; headings;
- the repository's own vocabulary, as conventions to follow before inventing new ones: the types, tags and statuses in use with how many documents use each (the thirty most used of each), its docs folder layout, and whether it already declares an OKF version.

The draft is a normal OKF document with its own frontmatter (`type: Guidelines`, `status: draft`, a `generated` date). The agent saves it at the suggested path, usually `docs/okf-guidelines.md`, in the developer's checkout; the developer reviews it, sets `verified` and commits it. Until then nothing is stored in the portal or written to GitHub, and each request returns a fresh draft.

## Validation

`validate_okf_document` checks a draft with the same rules the sync uses, so a document it accepts is one the portal stores with its `type` and shows as an OKF document. It returns `valid` (true when there are no errors) and a list of findings, each with a fixed code, a severity (error, warning or info), a message and, where one applies, a line.

- **Errors** are what the portal cannot use: missing, unclosed or unreadable frontmatter, a missing or non-text `type`, a `tags`, `status` or `sources` of the wrong shape, content over 256 KB.
- **Warnings** are likely mistakes: a date that is not a date, a `stale_after` already in the past, a missing description or level-1 heading, a second level-1 heading, a relative link to a document that is not in the repository.
- **Info** says what is worth knowing: a type, tag or status the repository does not use yet (with the ones it does), a draft or deprecated status.

Every code, with how to fix it, is in [OKF validation codes](../reference/okf-validation.md). The tool does not store or log the content it is given, and it never follows links or runs anything in it.

## What the tools never do

- They do not write to GitHub or to the portal. Everything they return is read from the synced documents or computed from the text they are given.
- They show only what the token's user can see: a repository an administrator has blocked is absent from every result.
- They treat repository text as data. Document text in a result is labelled as coming from a repository and is never an instruction, and the generated draft contains only cleaned labels from the repository, never its prose.
