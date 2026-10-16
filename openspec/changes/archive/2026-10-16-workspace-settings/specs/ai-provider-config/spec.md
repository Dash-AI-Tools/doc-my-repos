# Spec Delta

## MODIFIED Requirements

### Requirement: Endpoints must be secure
The system SHALL require an `https` endpoint except for `http` loopback addresses, where a key MAY be omitted, and SHALL refuse to save any other endpoint. The admin page SHALL show, for each provider, whether its credentials are configured, never their values.

#### Scenario: Provider not available
- **WHEN** no Anthropic key has been saved
- **THEN** the admin page shows `anthropic` as not configured, and it cannot be turned on

#### Scenario: Local model
- **WHEN** an administrator saves the OpenAI-compatible base URL `http://127.0.0.1:11434/v1` with no key
- **THEN** `openai-compatible` is shown as configured and works without a key

#### Scenario: Insecure remote address
- **WHEN** an administrator saves the base URL `http://models.example.com`
- **THEN** the save is refused with the reason and the previous endpoint is kept

### Requirement: Check the connection
The system SHALL let an administrator test a provider and model from the admin page before or after saving, sending one fixed short request with the stored credentials, and SHALL report only a fixed result (`ok`, `rejected`, `not found`, `unavailable`, `timed out`) without provider error text, URLs or keys. Testing SHALL be limited in rate and SHALL NOT change the saved choice.

#### Scenario: Working
- **WHEN** an administrator tests a valid provider and model
- **THEN** the page reports success

#### Scenario: Wrong model name
- **WHEN** the provider answers that the model does not exist
- **THEN** the page reports `not found` with no provider text

#### Scenario: Bad key
- **WHEN** the provider rejects the key
- **THEN** the page reports `rejected` and the log records an error kind without the key

#### Scenario: Test spam
- **WHEN** a test is requested more than five times in a minute
- **THEN** it is refused with 429

### Requirement: Off until set up
The system SHALL keep Ask off until an administrator has turned it on with a provider and model whose credentials are configured (default off). A saved choice whose credentials are later removed or become unreadable SHALL make Ask unavailable and hidden, SHALL be reported on the admin page and the status page by setting name only, and SHALL leave the rest of the portal working.

#### Scenario: Default
- **WHEN** an administrator has never saved an Ask choice
- **THEN** Ask is off and nothing about it is visible to users

#### Scenario: Credentials removed
- **WHEN** Ask is on and an administrator clears the provider key
- **THEN** Ask is hidden at once, `/ask` answers 404, the admin page and status page name the missing setting, and pages, search and sync work as before

#### Scenario: Turned off
- **WHEN** an administrator turns Ask off
- **THEN** the entry points disappear and `/ask` answers 404, and the saved provider and model are kept for later

## ADDED Requirements

### Requirement: Provider credentials are entered by administrators
The system SHALL let an administrator enter and replace provider credentials and endpoints on the admin page (Anthropic key; OpenAI-compatible base URL and optional key), SHALL store keys encrypted and never return them, and SHALL NOT read provider credentials from environment variables.

#### Scenario: Enter a key
- **WHEN** an administrator saves an Anthropic key
- **THEN** the page shows the provider as configured with no key text, and the next question uses the key

#### Scenario: Variable ignored
- **WHEN** `AI_ANTHROPIC_API_KEY` is set in the environment and no key is saved
- **THEN** `anthropic` is shown as not configured

## REMOVED Requirements

### Requirement: Credentials and endpoints stay in the environment
**Reason**: Administrators now manage provider credentials from the admin interface, stored encrypted in the database (see workspace-settings).
**Migration**: Enter the Anthropic key, or the OpenAI-compatible base URL and key, on the Ask admin page, then remove the `AI_*` variables from the environment.
