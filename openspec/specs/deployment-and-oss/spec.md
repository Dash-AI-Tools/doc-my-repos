# deployment-and-oss Specification

## Purpose

Defines how DocMyRepos is packaged, run, tested in CI, and documented so others can self-host and contribute to the open-source project.

## Requirements

### Requirement: One-command local and container run
The system SHALL provide a container image, a compose file and an installer script that start the app with its Postgres database, applying database migrations automatically. The installer SHALL be the first path in the quickstart (downloading `install.sh` from the GitHub Release for the version tag), and the clone-and-compose path SHALL remain documented for both building from source and pulling the published image. The GitHub App credentials, repositories and provider keys SHALL NOT be required before the app starts: an administrator enters them in the app after the first sign-in.

#### Scenario: Compose up from source
- **WHEN** a user copies the example environment file, sets the encryption key and the secrets, and runs compose up with a build
- **THEN** the app starts, the database schema is created, and the home page responds

#### Scenario: Compose up with the published image
- **WHEN** a user copies the example environment file, sets the encryption key and the secrets, and runs compose pull then compose up without a build
- **THEN** the app starts from the published image of the compose default tag, the database schema is created, and the home page responds

#### Scenario: Installer
- **WHEN** a user runs the installer command from the quickstart and answers its questions
- **THEN** the app and its database start from the published image, the health check passes, and the user can sign in as the administrator and reach the workspace configuration page

### Requirement: GitHub App setup guide
The repository SHALL document, step by step, how to register and install the GitHub App, including the minimum read-only permissions (repository contents and metadata), the subscribed events (`push`, `repository`, `installation_repositories`, `installation`), the webhook URL and secret, and how to obtain the App id, private key, and installation id.

#### Scenario: Operator follows the guide
- **WHEN** an operator follows the guide on a GitHub organization
- **THEN** they end with the three App credentials and a working webhook, with no write permissions granted

### Requirement: Continuous integration
The repository SHALL run on every pull request:
- lint, type checking, unit tests, end-to-end tests and a production build;
- the extension contract suite;
- the public API surface check;
- the changelog entry check.

#### Scenario: Failing check blocks merge
- **WHEN** a type error is introduced in a pull request
- **THEN** the CI run fails and reports the error

#### Scenario: Contract failure blocks merge
- **WHEN** a pull request breaks a plugin slot contribution or a hook override
- **THEN** the contract suite fails and the CI run reports it

### Requirement: Open-source project files
The repository SHALL include a license, a README with quickstart and screenshots in both themes, self-hosting and webhook-setup guides, a contributing guide, a code of conduct, issue templates, and an example environment file with no real secrets.

#### Scenario: New contributor
- **WHEN** a contributor reads the README and contributing guide
- **THEN** they can install dependencies, start the database, run migrations, and run the tests with documented commands

### Requirement: Dogfooded documentation
The repository SHALL document itself in a `docs/` folder using OKF so it can be synced into its own DocMyRepos instance.

#### Scenario: Self-sync
- **WHEN** DocMyRepos is configured to include its own repository
- **THEN** its docs appear as an OKF repository with type filters
