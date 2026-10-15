# repo-space Specification

## Purpose

Defines the browsing experience: a home page listing repositories and a per-repository space showing the README, code owners, and a table of contents of the docs.

## Requirements

### Requirement: Home page repository grid
The system SHALL show all configured repositories on the home page with name, description, document count, last-synced time, and an OKF badge where applicable, together with a prominent search bar.

#### Scenario: Repositories listed
- **WHEN** a visitor opens the home page after a successful sync
- **THEN** each synced repository appears as a card linking to its space

#### Scenario: Nothing synced yet
- **WHEN** no repository has been synced
- **THEN** the page explains how to configure and run a first sync

#### Scenario: Errored repository
- **WHEN** a repository's last sync failed
- **THEN** its card shows an error state while still showing previously stored content

### Requirement: Private repository indication and visibility-aware queries
The system SHALL show a "private" badge on cards and headers of private repositories, and SHALL route every read of repositories and documents (browsing, search, facets, assets) through a single visibility check so that restricting what a viewer may see later requires no change to those features. In the MVP all synced repositories are visible to every visitor.

#### Scenario: Private badge
- **WHEN** a private repository is listed or opened
- **THEN** a visible "private" badge is shown

#### Scenario: Public and private both visible in MVP
- **WHEN** a visitor opens the home page
- **THEN** both public and private synced repositories are listed

#### Scenario: Single enforcement point
- **WHEN** the visibility rule is changed to hide private repositories
- **THEN** private repositories disappear from the home page, repository pages, document pages, search results, facet counts, and asset URLs together

### Requirement: Repository space page
The system SHALL provide a page per repository at `/<owner>/<repo>` that shows a header with a link to the repository on GitHub, the rendered root README, the code owners, and the docs table of contents.

#### Scenario: Full space
- **WHEN** a visitor opens a synced repository with a README, CODEOWNERS, and docs
- **THEN** all three sections are shown

#### Scenario: Missing README
- **WHEN** a repository has no README
- **THEN** the README section shows an empty state and the rest of the page still renders

#### Scenario: Unknown repository
- **WHEN** a visitor opens a repository that is not configured
- **THEN** a not-found page is shown

### Requirement: Code owners panel
The system SHALL show the repository's code owners grouped by owner (user or team), with the path patterns each owner covers and a link to their GitHub profile or team.

#### Scenario: Owners with patterns
- **WHEN** CODEOWNERS contains `* @alice` and `/docs/ @my-org/docs-team`
- **THEN** the panel lists `@alice` covering `*` and `@my-org/docs-team` covering `/docs/`

#### Scenario: No CODEOWNERS
- **WHEN** the repository has no CODEOWNERS file
- **THEN** the panel states that no code owners are defined

### Requirement: Docs table of contents
The system SHALL show the docs as a collapsible folder tree ordered by folder then title, using document titles, and SHALL link each entry to its document page.

#### Scenario: Nested folders
- **WHEN** docs contain `guides/setup.md` and `guides/advanced/tuning.md`
- **THEN** the tree shows a `guides` folder with `Setup` and a nested `advanced` folder with `Tuning`

#### Scenario: Folder index
- **WHEN** a folder contains `index.md`
- **THEN** the folder entry links to it, and the index's description is not shown in the tree

### Requirement: Document page navigation
The system SHALL render each document at a stable URL under its repository, with an "on this page" heading list, a link to the source on GitHub, and previous/next links within the table of contents. The previous/next links SHALL follow the order of the navigation view being shown (OKF or Tree).

#### Scenario: Open a document
- **WHEN** a visitor opens `/<owner>/<repo>/docs/guides/setup`
- **THEN** the rendered document, its heading outline, and previous/next links are shown

#### Scenario: Missing document
- **WHEN** the path does not match a synced document
- **THEN** a not-found page links back to the repository space

#### Scenario: Previous and next in the Tree view
- **WHEN** a visitor with the Tree view opens `guides/index` in an OKF repository whose `guides` folder holds `advanced/tuning.md`, `index.md` and `setup.md`
- **THEN** the previous link goes to `guides/advanced/tuning` and the next link goes to `guides/setup`
