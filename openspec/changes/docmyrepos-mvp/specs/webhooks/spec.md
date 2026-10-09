## Purpose

Defines how DocMyRepos is notified of GitHub changes and how syncs can be triggered manually, so content updates promptly and safely.

## ADDED Requirements

### Requirement: Verified webhook endpoint
The system SHALL expose a single GitHub App webhook endpoint that accepts only requests with a valid signature computed with the configured webhook secret.

#### Scenario: Valid signature
- **WHEN** GitHub sends a correctly signed `push` event
- **THEN** the endpoint responds with success and schedules a sync

#### Scenario: Invalid or missing signature
- **WHEN** a request has a missing or incorrect signature
- **THEN** the endpoint responds with an authorization error and performs no sync

### Requirement: Event handling
The system SHALL re-sync only the affected repository for `push` events on its default branch, SHALL handle `repository` rename, delete, archive, and visibility events, SHALL handle `installation_repositories` events by adding or removing repositories, SHALL handle `installation` events, and SHALL ignore events for repositories outside the configured selection and for other branches.

#### Scenario: Push to default branch
- **WHEN** a push to the default branch of a configured repository arrives
- **THEN** that repository is re-synced and the change is visible in the app shortly after

#### Scenario: Push to a feature branch
- **WHEN** a push to a non-default branch arrives
- **THEN** no sync is performed

#### Scenario: Unknown repository
- **WHEN** an event arrives for a repository outside the configured selection
- **THEN** it is acknowledged and ignored

#### Scenario: Repositories added to the installation
- **WHEN** an `installation_repositories` event reports an added repository within the configured selection
- **THEN** the repository appears in the app after its first sync

#### Scenario: Repositories removed from the installation
- **WHEN** an `installation_repositories` event reports a removed repository
- **THEN** the repository and its documents are removed from the app

#### Scenario: Installation deleted or suspended
- **WHEN** an `installation` event reports deletion or suspension
- **THEN** stored content is kept, all repositories show an error state, and the reason is recorded

### Requirement: Idempotent processing
The system SHALL process repeated or concurrent deliveries for the same repository without corrupting data or running overlapping syncs.

#### Scenario: Duplicate delivery
- **WHEN** the same webhook delivery is received twice
- **THEN** the stored result is identical to processing it once

#### Scenario: Concurrent syncs
- **WHEN** a sync is already running for a repository and another is requested
- **THEN** the second is coalesced or queued rather than running in parallel

### Requirement: Protected manual sync
The system SHALL expose a sync endpoint, authorized by the configured sync secret, that syncs all repositories or a named one, and SHALL record each run's trigger, timing, and outcome.

#### Scenario: Authorized manual sync
- **WHEN** a request carries the correct sync secret
- **THEN** the sync runs and the response summarizes per-repository results

#### Scenario: Unauthorized manual sync
- **WHEN** the secret is missing or wrong
- **THEN** the request is rejected and nothing is synced
