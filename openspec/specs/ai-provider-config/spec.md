# ai-provider-config Specification

## Purpose

Lets administrators decide, from the admin page, whether and with which provider and model Ask runs, keeps keys and endpoints with the operator in the environment, tells users where their questions and document excerpts go, and bounds cost and abuse without keeping any conversation content.

## Requirements

### Requirement: Administrators choose the provider and model
The system SHALL let an administrator choose, on an admin page, whether Ask is on, which provider it uses (`anthropic` or `openai-compatible`) and which model name it requests, SHALL store that choice in the database, SHALL apply it to the next question without a restart or redeploy, and SHALL let only administrators read or change it. Non-administrators and signed-out visitors SHALL get no access to the page or its API.

#### Scenario: Choose and save
- **WHEN** an administrator selects `anthropic`, enters a model name and turns Ask on
- **THEN** the choice is saved and the next question from any user is answered through that provider and model

#### Scenario: Change model
- **WHEN** an administrator replaces the model name and saves
- **THEN** later questions use the new model, and a question already being answered finishes with the one it started with

#### Scenario: Not an administrator
- **WHEN** a signed-in non-administrator opens the admin page or calls its API
- **THEN** access is refused and nothing is revealed

#### Scenario: Invalid model name
- **WHEN** an administrator saves an empty model name, one over 100 characters, or one with spaces or control characters
- **THEN** the save is refused with a message naming the field and nothing changes

#### Scenario: Cannot turn on without a usable provider
- **WHEN** an administrator turns Ask on with no provider selected, no model, or a provider whose credentials are not configured in the environment
- **THEN** the save is refused with the reason, and Ask stays off

### Requirement: Credentials and endpoints stay in the environment
The system SHALL read provider credentials and endpoints only from environment variables set by the operator: `AI_ANTHROPIC_API_KEY`, and `AI_OPENAI_BASE_URL` with an optional `AI_OPENAI_API_KEY` for the OpenAI-compatible provider. Keys SHALL be secrets that never appear in logs, errors, responses, the admin page or the database, and the admin page SHALL NOT set or reveal a key or an endpoint address.

#### Scenario: No key reaches the admin
- **WHEN** an administrator opens the page or its API response is inspected
- **THEN** no key, and no endpoint address beyond its host name, appears

### Requirement: Endpoints must be secure
The system SHALL require an `https` endpoint except for `http` loopback addresses, where a key MAY be omitted. The admin page SHALL show, for each provider, whether its credentials are configured and the names of the variables still missing, never their values.

#### Scenario: Provider not available
- **WHEN** `AI_ANTHROPIC_API_KEY` is not set
- **THEN** the admin page shows `anthropic` as not configured and names the variable, and it cannot be turned on

#### Scenario: Local model
- **WHEN** `AI_OPENAI_BASE_URL=http://127.0.0.1:11434/v1` is set with no key
- **THEN** `openai-compatible` is shown as configured and works without a key

#### Scenario: Insecure remote address
- **WHEN** `AI_OPENAI_BASE_URL=http://models.example.com` is set
- **THEN** startup and the status page report the variable by name with the reason, and that provider is unavailable

### Requirement: Check the connection
The system SHALL let an administrator test a provider and model from the admin page before or after saving, sending one fixed short request with the environment credentials, and SHALL report only a fixed result (`ok`, `rejected`, `not found`, `unavailable`, `timed out`) without provider error text, URLs or keys. Testing SHALL be limited in rate and SHALL NOT change the saved choice.

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
The system SHALL keep Ask off until an administrator has turned it on with a provider and model whose credentials are configured (default off). A saved choice whose credentials later disappear, or that was invalidated, SHALL make Ask unavailable and hidden, SHALL be reported on the admin page and the status page by variable name only, and SHALL leave the rest of the portal working.

#### Scenario: Default
- **WHEN** an administrator has never saved an Ask choice
- **THEN** Ask is off and nothing about it is visible to users

#### Scenario: Credentials removed
- **WHEN** Ask is on and the operator removes the key and restarts
- **THEN** Ask is hidden, `/ask` answers 404, the admin page and status page name the missing variable, and pages, search and sync work as before

#### Scenario: Turned off
- **WHEN** an administrator turns Ask off
- **THEN** the entry points disappear and `/ask` answers 404, and the saved provider and model are kept for later

### Requirement: Say what is sent where
The system SHALL tell users on the Ask page, before their first question, which provider receives their question, recent conversation and excerpts of documents, SHALL describe that nothing is stored by the portal, and SHALL send only the question, up to four earlier exchanges, and the selected excerpts, never user identity, email, cookies, other documents or credentials.

#### Scenario: Notice shown
- **WHEN** a user opens the Ask page
- **THEN** a notice names the provider and states what is sent

#### Scenario: Minimal request
- **WHEN** the request sent to the provider is inspected
- **THEN** it contains the fixed instructions, the question and recent turns, and labelled excerpts, and no user identifier or credential

### Requirement: Bounded input and output
The system SHALL limit a question to 2,000 characters, the conversation context to four exchanges, the excerpts to a fixed budget (at most 8 sections and 12,000 characters in total), the answer to a fixed maximum number of output tokens, and each request to a fixed total duration, and SHALL refuse an over-limit question with a message and without calling the provider.

#### Scenario: Long question
- **WHEN** a question exceeds 2,000 characters
- **THEN** it is refused with the reason and nothing is sent to the provider

#### Scenario: Excerpt budget
- **WHEN** many large sections match
- **THEN** only the best sections within the budget are sent

#### Scenario: Slow provider
- **WHEN** the provider does not finish within the time limit
- **THEN** the request is ended, the text received is kept, and a timeout message is shown

### Requirement: Rate and concurrency limits
The system SHALL limit each user to a configurable number of questions per day (default 100) and per ten minutes (default 20), SHALL limit the number of requests being processed at once (default 8 per process, with per-user concurrency of 1), SHALL answer a limit with a clear message and, where it applies, `Retry-After`, and SHALL count a question when it is accepted for the model, not when it is refused or finds no documents.

#### Scenario: Daily limit
- **WHEN** a user has asked their daily maximum
- **THEN** the next question is refused with 429 and the time they can ask again

#### Scenario: One at a time
- **WHEN** a user submits a second question while one is being answered
- **THEN** it is refused with 429 and the first continues

#### Scenario: Busy
- **WHEN** the process already handles the maximum number of requests
- **THEN** a new request gets 503 with `Retry-After`

#### Scenario: Refusals not counted
- **WHEN** a question is refused for being too long or finds no documents
- **THEN** it does not count against the user's limits

### Requirement: Usage records without content
The system SHALL record for each accepted question only the user, the time, the provider, input and output token counts as reported by the provider (or an estimate when unreported), the number of excerpts and the outcome, and SHALL NOT store or log questions, answers, excerpts or the key. Records older than 90 days SHALL be removed.

#### Scenario: Record written
- **WHEN** a question is answered
- **THEN** a usage record with counts and outcome exists and contains no text

#### Scenario: Logs
- **WHEN** a question fails
- **THEN** the log line has a fixed event name, an error kind and ids, and no question, answer, excerpt or secret

#### Scenario: Retention
- **WHEN** a record is older than 90 days
- **THEN** it is removed

### Requirement: Provider failures are contained
The system SHALL map provider errors (network, timeout, 401, 403, 429, 5xx, malformed or truncated streams, content-filter stops) to a small set of fixed user messages, SHALL never show provider error bodies, keys or URLs to users, SHALL stop reading a stream that exceeds the output limit, and SHALL not retry a request that already started producing output.

#### Scenario: Rejected key
- **WHEN** the provider answers 401
- **THEN** the user sees a generic "the assistant is not available" message and the log records an error kind without the key

#### Scenario: Malformed stream
- **WHEN** the provider sends an invalid event
- **THEN** the answer ends with an error message and the server stays healthy

#### Scenario: Oversized output
- **WHEN** the provider streams more than the output limit
- **THEN** reading stops and the answer ends as cut off
