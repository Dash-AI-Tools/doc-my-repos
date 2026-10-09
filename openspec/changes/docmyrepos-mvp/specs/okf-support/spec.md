## Purpose

Defines support for Open Knowledge Format (OKF) bundles: detecting them, showing their metadata, and filtering by concept type, tags, and status.

## ADDED Requirements

### Requirement: OKF detection
The system SHALL treat a repository as OKF when its docs contain Markdown files whose frontmatter has a `type` key, or when the docs root `index.md` declares `okf_version`, and SHALL treat other repositories as plain Markdown.

#### Scenario: Frontmatter type present
- **WHEN** a docs folder has files with `type: Metric` frontmatter
- **THEN** the repository is marked as OKF

#### Scenario: Declared version
- **WHEN** the docs root `index.md` declares `okf_version: "0.2"`
- **THEN** the repository is marked as OKF and the version is shown

#### Scenario: Plain Markdown repository
- **WHEN** no document has a `type` key
- **THEN** the repository is not marked as OKF and no OKF controls appear

### Requirement: Tolerant parsing
The system SHALL accept any `type` string, SHALL preserve and display unknown frontmatter keys, and SHALL NOT reject documents with missing optional fields or broken links.

#### Scenario: Only the required key
- **WHEN** a document has only `type: Note`
- **THEN** it is shown with its file name as the title and no errors

#### Scenario: Unknown extension keys
- **WHEN** a document has a producer-defined key `owner_team`
- **THEN** it is listed in the document's metadata view

#### Scenario: Reserved files
- **WHEN** `index.md` and `log.md` exist
- **THEN** `index.md` acts as a folder summary and `log.md` is shown as a change log, not as a typed concept

### Requirement: Metadata card
The system SHALL show on each OKF document its type, tags, status, description, resource link, sources, and trust information (generated/verified) when present, and SHALL flag documents whose `stale_after` date has passed and documents with status `draft` or `deprecated`.

#### Scenario: Deprecated document
- **WHEN** a document has `status: deprecated`
- **THEN** a visible deprecation notice appears above the content

#### Scenario: Stale document
- **WHEN** `stale_after` is in the past
- **THEN** a stale warning is shown with the date

### Requirement: Filter by type
The system SHALL, for OKF repositories, show the distinct `type` values with counts as selectable filters on the table of contents, SHALL narrow the tree to matching documents when selected, and SHALL support combining with tag and status filters.

#### Scenario: Select a type
- **WHEN** the visitor selects type "Metric" (3 documents)
- **THEN** the table of contents shows only those 3 documents with their folders

#### Scenario: Multiple filters
- **WHEN** the visitor selects a type and the tag `finance`
- **THEN** only documents matching both are shown

#### Scenario: Persisted in URL
- **WHEN** a filter is applied
- **THEN** it is reflected in the URL and restored on reload

#### Scenario: Case and spacing variants
- **WHEN** documents use `Metric` and `metric`
- **THEN** they are listed as separate values exactly as authored, without silent merging
