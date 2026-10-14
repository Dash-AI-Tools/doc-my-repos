## Purpose

Gets the installer a working, read-only GitHub App and its installation on the organization, either by creating one for the user through GitHub's manifest flow or by validating an App the user already has.

## ADDED Requirements

### Requirement: Create the App from a manifest
The system SHALL offer to create the GitHub App for the user. It SHALL open the user's browser to GitHub's App creation page for the chosen organization with a manifest that requests only read access to repository contents and metadata, the `push` and `repository` events, a private (not public) App, and the portal's address, and it SHALL receive the result on a temporary page served only on the loopback interface. It SHALL then exchange the one-time code with GitHub for the App id, private key and webhook secret, and keep them only in memory until the files are written.

#### Scenario: App created
- **WHEN** the user confirms the App on GitHub
- **THEN** the wizard receives the code, exchanges it, and holds the App id, private key and webhook secret

#### Scenario: Read-only manifest
- **WHEN** the manifest that is sent is inspected
- **THEN** its permissions are only `contents: read` and `metadata: read`, no other permission, and the App is not public

#### Scenario: Browser cannot be opened
- **WHEN** the browser cannot be launched automatically
- **THEN** the wizard prints the address to open by hand and continues waiting

### Requirement: The local callback is safe
The system SHALL bind the temporary callback page to the loopback address on a random port, SHALL accept exactly one callback whose `state` value matches the random value it generated for this run, SHALL reject any other request or repeated callback, SHALL stop listening as soon as it has the result or after 10 minutes, and SHALL never put the code, key or secrets in a page it serves or in output.

#### Scenario: Wrong state
- **WHEN** a request arrives with a `state` that does not match
- **THEN** it is rejected, nothing is exchanged, and the wizard keeps waiting for the real callback

#### Scenario: Single use
- **WHEN** the callback has been handled once
- **THEN** the listener is closed and later requests get no answer

#### Scenario: Timeout
- **WHEN** no callback arrives within 10 minutes
- **THEN** the listener closes and the wizard offers to retry or to enter an existing App

#### Scenario: Not exposed
- **WHEN** the listener is inspected while waiting
- **THEN** it accepts connections only on the loopback interface

### Requirement: Webhook follows the address
The system SHALL configure the App's webhook to the portal's `/api/webhooks/github` address only when the portal's address is a public `https` address, and SHALL otherwise create the App with the webhook inactive and tell the user that syncing then relies on the scheduled sync until a public address exists.

#### Scenario: Public address
- **WHEN** the address is `https://docs.example.com`
- **THEN** the manifest's webhook is active and points to `https://docs.example.com/api/webhooks/github`

#### Scenario: Local address
- **WHEN** the address is `http://localhost:3000`
- **THEN** the webhook is inactive and the wizard says how to enable it later

### Requirement: Use an existing App
The system SHALL let the user supply an existing App's id, private key file and webhook secret instead, SHALL check the private key is a usable unencrypted RSA key, SHALL authenticate to GitHub as the App to confirm the id and key belong together, and SHALL warn clearly when the App has any permission beyond read access to contents and metadata. A key or id that does not work SHALL be explained and asked for again.

#### Scenario: Valid existing App
- **WHEN** the user supplies a correct id and key
- **THEN** the wizard confirms the App's name and continues

#### Scenario: Wrong key
- **WHEN** the key does not match the App id
- **THEN** GitHub's rejection is explained without printing the key and the user is asked again

#### Scenario: Write permission present
- **WHEN** the App has write access to repository contents
- **THEN** the wizard warns that DocMyRepos needs only read access and asks to confirm

### Requirement: Install on the organization and find the installation
The system SHALL guide the user to install the App on the organization (opening the install page), SHALL wait for the installation by asking GitHub, authenticated as the App, which installations exist, and SHALL take the installation id for the chosen organization from the answer, without asking the user to copy it. It SHALL stop waiting after a bounded time or on request, and SHALL allow the user to enter the installation id by hand.

#### Scenario: Installation found
- **WHEN** the user installs the App on the organization
- **THEN** the wizard detects it and records its installation id

#### Scenario: Not installed yet
- **WHEN** the App is not installed within the waiting time
- **THEN** the wizard offers to keep waiting, open the page again, or enter the id by hand

#### Scenario: Wrong account
- **WHEN** the App is installed only on an account other than the chosen organization
- **THEN** the wizard says which account it found and asks to install it on the right one

### Requirement: Choose repositories
The system SHALL, once installed, list the repositories the installation can access and let the user keep all of them or pick some, and SHALL write the pick to the configuration as a `repos` list. When there are none it SHALL say so and explain how to grant access. Names SHALL be validated before being written.

#### Scenario: All repositories
- **WHEN** the user keeps all repositories
- **THEN** the written configuration has no `repos` or `exclude` list

#### Scenario: Picked subset
- **WHEN** the user picks three repositories
- **THEN** the configuration lists exactly those three bare names

#### Scenario: Nothing accessible
- **WHEN** the installation can access no repository
- **THEN** the wizard explains how to add repositories to the installation and continues

### Requirement: Failures from GitHub are explained
The system SHALL translate GitHub failures (unreachable network, rate limit, 401, 403, 404, a rejected manifest) into plain messages naming the step and the next action, SHALL include the GitHub error text only when it contains no credential, and SHALL never print a token or key. A rejected manifest SHALL fall back to guiding the user through the manual registration and entering the values.

#### Scenario: Offline
- **WHEN** GitHub cannot be reached
- **THEN** the wizard says so, names the step, and exits or offers to retry

#### Scenario: Manifest rejected
- **WHEN** GitHub refuses the manifest
- **THEN** the wizard explains it and continues through the manual route
