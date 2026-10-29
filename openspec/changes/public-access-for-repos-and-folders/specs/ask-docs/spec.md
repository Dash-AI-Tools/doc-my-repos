# Spec Delta

## MODIFIED Requirements

### Requirement: Ask page and entry points
The system SHALL provide an Ask page at `/ask` with a question field, the conversation so far, and a send control. The page SHALL be reachable from the site header, from the search page when a query is present, and from a repository page (scoped to that repository). It SHALL be shown to signed-in users, and to anonymous visitors only when public Ask is on (see `public-access`), and only when Ask is enabled and a provider is configured; otherwise the entry points SHALL not appear and `/ask` SHALL answer 404.

#### Scenario: Header link
- **WHEN** a signed-in user views any page while Ask is enabled
- **THEN** the header has an Ask link to `/ask`

#### Scenario: From search
- **WHEN** a user has searched "rotate signing keys"
- **THEN** the search page offers to ask that question, opening `/ask` with it filled in but not sent

#### Scenario: Not enabled
- **WHEN** Ask is not enabled or no provider is configured
- **THEN** no Ask link is shown anywhere and `/ask` answers 404

#### Scenario: Signed out
- **WHEN** a signed-out visitor opens `/ask` while public Ask is off
- **THEN** they are sent to sign in

#### Scenario: Anonymous visitor with public Ask on
- **WHEN** an anonymous visitor opens `/ask` while Ask and public Ask are on
- **THEN** the page works, is scoped to public repositories, and the header offers Sign in
