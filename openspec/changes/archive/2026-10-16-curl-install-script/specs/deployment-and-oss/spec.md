# Spec Delta

## MODIFIED Requirements

### Requirement: One-command local and container run
The system SHALL provide a container image, a compose file and an installer script that start the app with its Postgres database, applying database migrations automatically. The installer SHALL be the first path in the quickstart, and the clone-and-compose path SHALL remain documented. The GitHub App credentials, repositories and provider keys SHALL NOT be required before the app starts: an administrator enters them in the app after the first sign-in.

#### Scenario: Compose up
- **WHEN** a user copies the example environment file, sets the encryption key and the secrets, and runs compose up
- **THEN** the app starts, the database schema is created, and the home page responds

#### Scenario: Installer
- **WHEN** a user runs the installer command from the quickstart and answers its questions
- **THEN** the app and its database start from the published image, the health check passes, and the user can sign in as the administrator and reach the workspace configuration page
