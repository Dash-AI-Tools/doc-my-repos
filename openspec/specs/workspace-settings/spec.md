# workspace-settings Specification

## Purpose

Lets administrators manage the workspace's GitHub connection, model provider and sync scope from an admin interface, with secrets encrypted at rest and changes applied without a restart.

## Requirements

### Requirement: Administrators manage workspace settings
The system SHALL provide an admin interface where an administrator can view and change the GitHub App settings, the model provider settings, and the repository narrowing and sync settings, SHALL store them in the database, and SHALL let only administrators read or change them. Non-administrators and signed-out visitors SHALL get no access to the interface or its API.

#### Scenario: Administrator saves a change
- **WHEN** an administrator changes a setting and saves
- **THEN** the new value is stored and shown after reload

#### Scenario: Not an administrator
- **WHEN** a signed-in non-administrator or a signed-out visitor opens the interface or calls its API
- **THEN** access is refused and nothing is revealed

#### Scenario: Invalid value
- **WHEN** an administrator saves a value that fails validation
- **THEN** the save is refused with a message naming the field, and the stored values are unchanged

### Requirement: Secrets are encrypted at rest
The system SHALL encrypt the GitHub App private key, the GitHub webhook secret and every model provider key with a server-held encryption key before storing them, SHALL bind each encrypted value to its setting so it cannot be swapped with another, and SHALL never write a secret in clear text to the database, logs, errors or backups made by the application.

#### Scenario: Database holds no clear text
- **WHEN** the settings table is read directly after a secret is saved
- **THEN** the secret value does not appear and the stored form cannot be decrypted without the encryption key

#### Scenario: Value moved to another setting
- **WHEN** an encrypted value is copied into a different setting's row
- **THEN** decryption fails and the setting is treated as unreadable

### Requirement: Secrets are write-only
The system SHALL accept a new value for a secret setting but SHALL never return its value, any part of it, or its length in an interface, API response, log or error. The interface SHALL show only whether the secret is set and when it was last changed, and SHALL leave a stored secret unchanged when the field is submitted empty.

#### Scenario: Secret already stored
- **WHEN** an administrator opens the page after saving a private key
- **THEN** the page shows that a key is set and when it changed, and no key text

#### Scenario: Save without retyping
- **WHEN** an administrator changes another field and leaves the secret field empty
- **THEN** the stored secret is kept

#### Scenario: Replace a secret
- **WHEN** an administrator enters a new value for a secret and saves
- **THEN** later requests use the new value and the old one is no longer kept

### Requirement: Encryption key comes from the environment
The system SHALL read the encryption key only from the operator's environment, SHALL validate it at startup (present, decodes to at least 32 bytes) and report problems by variable name only, and SHALL treat an unusable key as "settings unreadable": secret settings are unavailable and the rest of the portal keeps serving stored content.

#### Scenario: Key missing
- **WHEN** the encryption key variable is not set
- **THEN** startup reports the variable by name, secret settings cannot be read or saved, and pages, search and stored documents still work

#### Scenario: Wrong key
- **WHEN** the key differs from the one used to encrypt the stored secrets
- **THEN** the affected settings are reported as unreadable on the status page without values, and the rest of the portal works

### Requirement: Changes apply without a restart
The system SHALL use a saved change on the next operation that depends on it (sync, webhook delivery, image proxy request, Ask question), without a restart or redeploy, SHALL let a sync, webhook handling or answer already in progress finish with the values it started with, SHALL read the background sync schedule (interval and run-on-startup) when the server starts, and SHALL keep the previous working values in use when a saved change fails validation.

#### Scenario: New private key
- **WHEN** an administrator replaces the GitHub App private key
- **THEN** the next GitHub request mints a token with the new key

#### Scenario: New repository list
- **WHEN** an administrator changes the repository list
- **THEN** the next sync follows the new list

#### Scenario: Background schedule
- **WHEN** an administrator changes the sync interval or the run-on-startup setting
- **THEN** the change is stored at once and the background schedule follows it after the next restart, while every other use of the settings follows it at once

#### Scenario: Run in progress
- **WHEN** a sync is running while the settings change
- **THEN** that sync finishes with its original settings and the next one uses the new ones

### Requirement: Check the GitHub connection
The system SHALL let an administrator test the GitHub App settings before or after saving by making one fixed read-only request, SHALL report only a fixed result (`ok`, `rejected`, `not found`, `unavailable`, `timed out`) without GitHub error text, URLs or credentials, SHALL NOT change the saved settings, and SHALL limit testing in rate.

#### Scenario: Working
- **WHEN** an administrator tests valid GitHub App settings
- **THEN** the page reports success and how many repositories the installation can access

#### Scenario: Bad key or ids
- **WHEN** GitHub rejects the credentials or does not find the installation
- **THEN** the page reports `rejected` or `not found` with no GitHub text and the log records an error kind without credentials

#### Scenario: Test spam
- **WHEN** a test is requested more than five times in a minute
- **THEN** it is refused with 429

### Requirement: Unconfigured workspace is safe and visible
The system SHALL start and serve stored content when GitHub or provider settings are not yet configured, SHALL report each missing or invalid setting by name on the admin page and the status page, SHALL refuse sync, webhooks and image proxy requests that need GitHub with a clear "not configured" outcome and without leaking details, and SHALL keep Ask off.

#### Scenario: Fresh install
- **WHEN** the portal starts with no GitHub settings saved
- **THEN** an administrator can sign in with the bootstrap account, the status page names what is missing, and no GitHub request is attempted

#### Scenario: Webhook before setup
- **WHEN** a webhook arrives while no webhook secret is stored
- **THEN** it is refused as unauthorized and nothing is synced

### Requirement: Changes are audited without values
The system SHALL record each settings change with who made it and when, naming the changed fields and never their values, and SHALL log the same event with fixed names and ids only.

#### Scenario: Secret replaced
- **WHEN** an administrator replaces the webhook secret
- **THEN** the log and the audit record name the setting, the user and the time, and contain no secret

#### Scenario: Value never logged
- **WHEN** a save is refused for being invalid
- **THEN** the log line names the field and reason and does not include the submitted value

### Requirement: Settings are grouped in tabs on one page
The system SHALL present the workspace settings on a single admin page, grouped into tabs for GitHub and sync settings and for Ask (model provider) settings, SHALL open the tab named in the page address, SHALL keep unsaved edits when switching tabs, and SHALL let the tabs be used with the keyboard. Older addresses for the GitHub and Ask settings pages SHALL lead to the matching tab.

#### Scenario: Ask settings in a tab
- **WHEN** an administrator opens the Ask tab
- **THEN** the Ask switch, provider, model and provider credentials are shown on the same page as the GitHub settings

#### Scenario: Unsaved edits kept
- **WHEN** an administrator edits a field, switches to another tab and back
- **THEN** the edit is still there

#### Scenario: Old address
- **WHEN** an administrator opens the former Ask settings address
- **THEN** the workspace settings page opens on the Ask tab

### Requirement: Setup banner guides administrators
The system SHALL show administrators, and only administrators, an info banner on the home page and the admin home while the GitHub App settings are incomplete. Activating the banner SHALL open the workspace settings page with the GitHub setup instructions displayed, covering the steps to take on GitHub and the values to enter. The instructions SHALL also be reopenable from the page at any time, and no visit SHALL be redirected because of them.

#### Scenario: Unconfigured workspace
- **WHEN** an administrator opens the home page before the GitHub App is configured
- **THEN** the page loads with the banner, and activating it opens the settings page with the instructions shown

#### Scenario: Readers and configured workspaces
- **WHEN** a non-administrator opens the home page, or the GitHub App is fully configured
- **THEN** no banner is shown

#### Scenario: Settings cannot be read
- **WHEN** the settings or the session cannot be read
- **THEN** no banner is shown and the page still loads
