# deployment-and-oss Specification

## Purpose

Defines how DocMyRepos is packaged, run, tested in CI, and documented so others can self-host and contribute to the open-source project.

## Requirements

### Requirement: One-command local and container run
The system SHALL provide a container image and a compose file that start the app with its Postgres database, applying database migrations automatically.

#### Scenario: Compose up
- **WHEN** a user copies the example environment file, sets the GitHub App credentials, and runs compose up
- **THEN** the app starts, the database schema is created, and the home page responds

### Requirement: GitHub App setup guide
The repository SHALL document, step by step, how to register and install the GitHub App, including the minimum read-only permissions (repository contents and metadata), the subscribed events (`push`, `repository`, `installation_repositories`, `installation`), the webhook URL and secret, and how to obtain the App id, private key, and installation id.

#### Scenario: Operator follows the guide
- **WHEN** an operator follows the guide on a GitHub organization
- **THEN** they end with the three App credentials and a working webhook, with no write permissions granted

### Requirement: Continuous integration
The repository SHALL run lint, type checking, unit tests, end-to-end tests, and a production build on every pull request.

#### Scenario: Failing check blocks merge
- **WHEN** a type error is introduced in a pull request
- **THEN** the CI run fails and reports the error

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
