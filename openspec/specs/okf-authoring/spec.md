# okf-authoring Specification

## Purpose

Helps developers and their AI agents write documentation that follows the Open Knowledge Format: it finds or drafts the repository's OKF guidelines file and checks draft documents against OKF and against the repository's own conventions.

## Requirements

### Requirement: Find the repository's OKF guidelines
The system SHALL provide a `get_okf_guidelines` tool that, for a given repository, looks in the repository's synced docs for a guidelines file named `okf-guidelines.md` (case-insensitive) in the docs folder root, or else in its `guides` folder, and, when found, returns its path, title, content and portal link with `found` true. Content SHALL be labelled as untrusted repository content.

#### Scenario: Guidelines present
- **WHEN** the repository's docs contain `docs/okf-guidelines.md`
- **THEN** the tool returns `found` true with that file's path and content

#### Scenario: Name matching
- **WHEN** the file is named `OKF-Guidelines.md` or sits in `docs/guides/`
- **THEN** it is still found

#### Scenario: Hidden repository
- **WHEN** the repository is blocked or unknown
- **THEN** the tool returns a not-found error

### Requirement: Generate a draft when there are none
The system SHALL, when no guidelines file exists, return `found` false together with a generated draft of `okf-guidelines.md`, the suggested path (`<docs folder>/okf-guidelines.md`) and instructions to save it in the repository and have the developer review and commit it. The draft SHALL be generated deterministically from OKF and from the repository's own data, without calling any model or external service. It SHALL contain: the required `type` key and that its value is free-form; the known keys and their value shapes; the date formats; the reserved `index.md` and `log.md` and what they are for; how to link between documents; and the repository's own vocabulary (the types, tags and statuses already in use with counts, its docs folder layout, whether it declares `okf_version`), presented as conventions to follow before inventing new ones. It SHALL start with valid OKF frontmatter of its own.

#### Scenario: No guidelines, draft returned
- **WHEN** an agent asks for guidelines of a repository that has none
- **THEN** it receives `found` false, a draft, the suggested path and the save instructions

#### Scenario: Draft reflects the repository
- **WHEN** the repository's documents use the types "Runbook" and "ADR"
- **THEN** the draft lists those types as existing conventions with their counts

#### Scenario: Draft is valid OKF
- **WHEN** the draft is passed to the validation tool
- **THEN** it reports no errors

#### Scenario: Generic draft
- **WHEN** a repository has no documents yet, or none is named
- **THEN** a generic draft with the OKF rules and an empty vocabulary section is returned

#### Scenario: Nothing is written
- **WHEN** the draft is returned
- **THEN** nothing is stored in the portal or written to GitHub

### Requirement: Validate a draft document
The system SHALL provide a `validate_okf_document` tool that takes Markdown content (at most 256 KB), an optional document path and an optional repository, parses it with the same frontmatter rules the sync uses, and returns `valid` (true when there are no errors) and a list of findings, each with a fixed code, a severity (error, warning or info), a message, and a line where one applies. It SHALL report as errors: missing, unclosed or unparsable frontmatter, a missing or non-text or blank `type`, and a `sources`, `tags` or `status` of an unusable shape. It SHALL report as warnings: invalid dates in `generated`, `verified` and `stale_after`, a `stale_after` already in the past, an over-long title or description, a missing description, no level-1 heading or more than one, and, when a repository is given, relative links to documents that do not exist in its synced docs. It SHALL report as info: a `type`, tag or status not used elsewhere in the repository (with the existing ones listed), a `draft` or `deprecated` status, and `type` on a reserved `index.md` or `log.md`.

#### Scenario: Valid document
- **WHEN** a document has `type: Runbook`, a description and valid dates
- **THEN** `valid` is true and there are no errors

#### Scenario: Missing type
- **WHEN** the frontmatter has no `type`
- **THEN** an error with the missing-type code is returned and `valid` is false

#### Scenario: No frontmatter
- **WHEN** the content has no frontmatter block
- **THEN** a missing-frontmatter error is returned with a suggested block

#### Scenario: Bad date
- **WHEN** `verified` is `2026-02-29`
- **THEN** a warning with the invalid-date code names the key

#### Scenario: Broken relative link
- **WHEN** a repository is given and the document links to `./missing.md` that is not in its synced docs
- **THEN** a warning names the link and its line

#### Scenario: New vocabulary
- **WHEN** the type is not used anywhere else in the repository
- **THEN** an info finding says so and lists the types in use, and `valid` stays true

#### Scenario: Oversized content
- **WHEN** the content exceeds 256 KB
- **THEN** the tool returns an error and validates nothing

### Requirement: Validation is safe and agrees with the portal
The system SHALL run validation without storing the content, without executing or rendering it, and with the same limits as sync (frontmatter size, depth and node caps), so that a document it reports as having no errors is one the portal syncs and shows as an OKF document. Findings SHALL use only fixed messages with the offending key or line, not echoed free text beyond a short clipped excerpt cleaned of control characters.

#### Scenario: Agreement with sync
- **WHEN** a document validates with no errors
- **THEN** syncing the same file yields a document with that `type` shown as OKF

#### Scenario: Hostile frontmatter
- **WHEN** the frontmatter is huge, deeply nested, or contains an alias bomb
- **THEN** the tool returns an error finding promptly and does not exhaust memory

#### Scenario: Not stored
- **WHEN** validation finishes
- **THEN** the content is not kept or logged anywhere
