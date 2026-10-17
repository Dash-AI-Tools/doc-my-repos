# agent-tokens Specification

## Purpose

Lets a signed-in user give an AI agent read access to the portal's documentation with a revocable personal token, and keeps that access no wider than the user's own and nothing but the MCP endpoint.

## Requirements

### Requirement: Create a token
The system SHALL let a signed-in user create API tokens on an "AI agent access" page, each with a name (1 to 60 plain-text characters) and an expiry of 30, 90 or 365 days. The full token SHALL be shown exactly once, at creation, and SHALL NOT be retrievable afterwards. A user SHALL have at most 10 active tokens. Creating a token SHALL require the user's session, not another token.

#### Scenario: Token created and shown once
- **WHEN** a user creates a token named "laptop" with a 90 day expiry
- **THEN** the full token is displayed once with a copy control, and later views of the page show only its name, prefix, expiry and last use

#### Scenario: Limit reached
- **WHEN** a user who has 10 active tokens tries to create another
- **THEN** it is refused with a message and nothing is created

#### Scenario: Invalid input
- **WHEN** the name is empty, over 60 characters, or the expiry is not one of the offered values
- **THEN** nothing is created and the page names the problem

#### Scenario: Token cannot create tokens
- **WHEN** a request authenticated only with an API token tries to create or list tokens
- **THEN** it is refused with 401

### Requirement: Tokens are stored safely
The system SHALL generate tokens from at least 256 bits of cryptographic randomness with a recognizable prefix, SHALL store only a one-way hash of the token and a short display prefix, SHALL never log, display again or return the full token, and SHALL compare in a way that does not reveal how much of a token matched.

#### Scenario: Only a hash is kept
- **WHEN** the token store is inspected after a token was created
- **THEN** it holds a hash and a short prefix and not the token

#### Scenario: Not in logs
- **WHEN** a request with a token is handled, successfully or not
- **THEN** no log line or error message contains the token

### Requirement: A token acts as its user and no more
The system SHALL accept a token only at the MCP endpoint. A valid token SHALL see exactly the repositories and documents its user sees on the website. A token SHALL be rejected when it is expired, revoked, unknown or malformed, when its user is disabled, and after its user's password is reset. Tokens SHALL NOT grant administration, even to an admin's token, and SHALL NOT be accepted on any other route.

#### Scenario: Same visibility as the user
- **WHEN** a repository is blocked by an admin
- **THEN** a token's tools no longer return it or its documents

#### Scenario: Disabled user
- **WHEN** a user is disabled
- **THEN** their tokens are rejected at once

#### Scenario: Password reset
- **WHEN** a user's password is reset
- **THEN** all their tokens stop working

#### Scenario: Expired token
- **WHEN** a token's expiry has passed
- **THEN** it is rejected with 401

#### Scenario: Not valid elsewhere
- **WHEN** a token is sent as a bearer credential to the website or any admin API
- **THEN** the request is treated as unauthenticated

### Requirement: Revoke tokens
The system SHALL let a user revoke any of their own tokens, which takes effect on the next request, and SHALL let an admin list all tokens (owner, name, prefix, expiry, last use) and revoke any of them. Revoked and expired tokens SHALL remain listed as such for 30 days, then be removed.

#### Scenario: User revokes
- **WHEN** a user revokes a token
- **THEN** the next request using it is rejected with 401

#### Scenario: Admin revokes
- **WHEN** an admin revokes another user's token
- **THEN** that token stops working and the owner sees it as revoked

#### Scenario: Others' tokens stay private
- **WHEN** a non-admin user lists tokens
- **THEN** they see only their own, and revoking another user's token answers 404

### Requirement: Connection help
The system SHALL show, on the AI agent access page, how to connect common agents to the portal's MCP address (the portal's own origin followed by `/api/mcp`), with a ready-to-copy snippet for each, and SHALL fill the token into a snippet only at the moment it is created.

#### Scenario: Snippets with the address
- **WHEN** a user opens the page
- **THEN** it shows the MCP address and copyable connection snippets for at least a command-line agent and a JSON-configured agent

#### Scenario: Token only at creation
- **WHEN** a user returns to the page later
- **THEN** snippets show a placeholder where the token goes, never a real token

### Requirement: Page access and visibility of the feature
The system SHALL show the AI agent access page only to signed-in users and SHALL answer 404 for it, and for the token APIs, when the MCP endpoint is turned off.

#### Scenario: Signed out
- **WHEN** a signed-out visitor opens the page
- **THEN** they are sent to sign in

#### Scenario: Endpoint off
- **WHEN** the operator has turned the MCP endpoint off
- **THEN** the page and the token APIs answer 404 and no link to them is shown
