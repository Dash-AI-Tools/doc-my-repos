# github-sync Specification

## Purpose

Defines how DocMyRepos retrieves documentation, README, and CODEOWNERS data from GitHub and keeps its stored copy correct and current without refetching unchanged content.

## Requirements

### Requirement: Collect docs, README, and code owners
The system SHALL, for each configured repository, collect the Markdown files (`.md`, `.mdx`) under its docs folder, the root README, and the CODEOWNERS file, read from the repository's default branch.

#### Scenario: Full first sync
- **WHEN** a repository is synced for the first time
- **THEN** all Markdown files under the docs folder, the root README, and the CODEOWNERS rules are stored and the repo is marked as synced with a timestamp

#### Scenario: CODEOWNERS location precedence
- **WHEN** a repository has CODEOWNERS files in both `.github/` and the root
- **THEN** the `.github/CODEOWNERS` file is used, following GitHub's precedence

#### Scenario: Oversized or irrelevant files
- **WHEN** a Markdown file exceeds the configured size limit or lives under `node_modules`
- **THEN** it is skipped and the skip is recorded in the sync run

### Requirement: Incremental sync
The system SHALL skip repositories whose default-branch tree is unchanged and SHALL refetch only files whose content identifier changed.

#### Scenario: Nothing changed
- **WHEN** a repository is synced again and its tree identifier is unchanged
- **THEN** no file contents are fetched and the sync run reports zero changes

#### Scenario: One file changed
- **WHEN** one docs file is modified upstream
- **THEN** only that file is refetched and its stored document and search data are updated

### Requirement: Removals and renames
The system SHALL delete stored documents whose source files no longer exist and SHALL handle repository renames and deletions.

#### Scenario: File deleted upstream
- **WHEN** a docs file is removed from the repository
- **THEN** the next sync removes its document and it no longer appears in the table of contents or search

#### Scenario: Repository deleted or removed from config
- **WHEN** a repository is deleted on GitHub or removed from the config
- **THEN** it and its documents are no longer shown

### Requirement: Document metadata extraction
The system SHALL derive a title for each document from frontmatter `title`, else the first level-1 heading, else the file name, and SHALL extract description, headings, tags, and the full frontmatter.

#### Scenario: Title fallbacks
- **WHEN** a document has no frontmatter title and starts with `# Getting Started`
- **THEN** its title is "Getting Started"

#### Scenario: Malformed frontmatter
- **WHEN** a document's frontmatter is not valid YAML
- **THEN** the document is still synced, treated as having no metadata, and a warning is recorded

### Requirement: Resilience to GitHub limits and errors
The system SHALL respect GitHub rate limits by backing off and retrying, SHALL keep previously stored content when a sync fails, and SHALL record per-repository status and error.

#### Scenario: Rate limited
- **WHEN** GitHub responds that the rate limit is exhausted
- **THEN** the sync waits until the reset time or stops and records a retryable error, without deleting stored content

#### Scenario: Inaccessible repository
- **WHEN** the GitHub App installation cannot access a configured repository
- **THEN** that repository is marked as errored with a readable message and other repositories still sync

### Requirement: GitHub App authentication
The system SHALL authenticate to GitHub as a GitHub App installation, SHALL obtain short-lived installation tokens from the App's credentials, SHALL reuse a token until shortly before it expires, and SHALL NOT require a personal access token.

#### Scenario: Token reuse and refresh
- **WHEN** several requests are made within one sync and the installation token is near expiry
- **THEN** one fresh token is obtained and used for subsequent requests without failing any request

#### Scenario: Rejected token
- **WHEN** GitHub rejects an installation token as expired or revoked
- **THEN** the system obtains a new token and retries the request once

#### Scenario: App uninstalled or suspended
- **WHEN** the installation no longer exists or is suspended
- **THEN** syncs fail with a readable "GitHub App installation unavailable" error, and previously stored content is kept

### Requirement: Installation repository discovery
The system SHALL list the repositories the installation can access and use that list to determine which repositories are synced, applying the config narrowing.

#### Scenario: Repository added to the installation
- **WHEN** a repository is added to the installation and a sync runs
- **THEN** the repository is discovered and synced

#### Scenario: Repository removed from the installation
- **WHEN** a repository is no longer accessible to the installation
- **THEN** it is removed from the app together with its documents

### Requirement: Repository visibility
The system SHALL record whether each repository is public or private from GitHub on every sync, and SHALL keep that value current when it changes.

#### Scenario: Visibility recorded
- **WHEN** a private repository is synced
- **THEN** it is stored with visibility "private"

#### Scenario: Visibility changes upstream
- **WHEN** a repository changes from private to public and a sync or `repository` event arrives
- **THEN** its stored visibility is updated
