## Purpose

Defines how an operator declares which GitHub organization and repositories DocMyRepos documents, and which secrets it needs, so the app can run without user login.

## ADDED Requirements

### Requirement: Config file narrows the repositories shown
The system SHALL read a `docmyrepos.config.yml` file that optionally narrows the repositories the GitHub App installation can access, using either an explicit list of repositories or an exclusion list. When the file omits both, every repository the installation can access SHALL be synced and shown.

#### Scenario: Default is every accessible repository
- **WHEN** the config declares neither a repository list nor exclusions
- **THEN** every non-archived repository the GitHub App installation can access is synced and shown

#### Scenario: Explicit repository list
- **WHEN** the config lists repositories `api-service` and `web-app`
- **THEN** only those two repositories are synced and shown, provided the installation can access them

#### Scenario: Exclusions
- **WHEN** the config excludes `sandbox`
- **THEN** every accessible repository except `sandbox` is synced; archived repositories are skipped

#### Scenario: Listed repository not accessible
- **WHEN** the config lists a repository that the installation cannot access
- **THEN** startup and sync report "not accessible by the GitHub App" for it, and the other repositories are unaffected

### Requirement: Configurable docs folder
The system SHALL look for a docs folder in each repository using an ordered list of candidate names (default: `docs`, `doc`, `documentation`, matched case-insensitively), and SHALL allow a per-repository override.

#### Scenario: Default discovery
- **WHEN** a repository has a `Docs/` folder and no override
- **THEN** `Docs/` is used as that repository's docs folder

#### Scenario: Per-repo override
- **WHEN** the config sets `docsPath: handbook` for a repository
- **THEN** only `handbook/` is used, even if a `docs/` folder also exists

#### Scenario: No docs folder
- **WHEN** a repository has none of the candidate folders
- **THEN** the repository is still listed with its README and code owners and shows an empty-docs state

### Requirement: Configuration validation
The system SHALL validate the config file and required environment variables (database URL, GitHub App id, GitHub App private key given inline or as a file path, GitHub App installation id, webhook secret, sync secret) at startup and fail with a message naming each invalid or missing item.

#### Scenario: Missing App credential
- **WHEN** the GitHub App id, private key, or installation id is not set
- **THEN** startup fails with an error that names the missing variable and does not print any secret value

#### Scenario: Weak shared secret
- **WHEN** the webhook secret or the sync secret is shorter than 16 characters after trimming whitespace
- **THEN** startup fails with an error that names the variable and does not print the value

#### Scenario: Unreadable private key
- **WHEN** the private key is not a valid PEM key or the key file path cannot be read
- **THEN** startup fails with an error that identifies the variable and never prints the key

#### Scenario: Invalid config
- **WHEN** the config file contains a field of the wrong type or an unknown field
- **THEN** startup fails with an error that identifies the field and file

#### Scenario: Conflicting narrowing
- **WHEN** the config declares both a repository list and an exclusion list
- **THEN** startup fails with an error that identifies the `exclude` field and says only one of `repos` or `exclude` may be set

#### Scenario: Empty list
- **WHEN** the config declares `repos` or `exclude` as an empty list, or leaves the key with no value
- **THEN** startup fails with an error that identifies the field, so an empty list is never read as "show nothing" or "no narrowing"

#### Scenario: Config file location
- **WHEN** the `CONFIG_PATH` environment variable is set
- **THEN** the system reads the config file from that path, and startup fails with an error naming `CONFIG_PATH` if the file cannot be read

#### Scenario: No config file
- **WHEN** `CONFIG_PATH` is not set and `docmyrepos.config.yml` does not exist in the working directory
- **THEN** the system behaves as if the file declared neither a repository list nor exclusions, so every accessible repository is shown
