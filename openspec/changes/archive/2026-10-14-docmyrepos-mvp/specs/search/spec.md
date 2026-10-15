## Purpose

Defines full-text search across all synced documentation so readers can find a document quickly from any page.

## ADDED Requirements

### Requirement: Full-text search across repositories
The system SHALL provide search over document titles, headings, descriptions, tags, and body text across all synced repositories, ranking title and heading matches above body matches.

#### Scenario: Match in body
- **WHEN** a visitor searches "rate limit"
- **THEN** documents containing those words are listed, ordered by relevance

#### Scenario: Title outranks body
- **WHEN** one document has "Deployment" in its title and another mentions it once in the body
- **THEN** the titled document ranks first

#### Scenario: No results
- **WHEN** nothing matches
- **THEN** an empty state is shown with the query echoed back

### Requirement: Result presentation
The system SHALL show each result with its title, repository, path, and a snippet with matched terms highlighted, linking to the document.

#### Scenario: Snippet highlighting
- **WHEN** results are displayed
- **THEN** matched terms in the snippet are visibly highlighted and the snippet contains no raw Markdown or HTML markup from the source

### Requirement: Scoped and faceted search
The system SHALL let the visitor limit results to a repository and, where available, to an OKF type, tag, or status, and SHALL show counts per facet value.

#### Scenario: Repository filter
- **WHEN** the visitor selects repository `api-service`
- **THEN** only its documents are returned

#### Scenario: Shareable URL
- **WHEN** a search with filters is performed
- **THEN** the query and filters are reflected in the URL so the result is shareable

### Requirement: Global search access
The system SHALL offer search from every page via a search bar and a keyboard shortcut (`⌘K` / `Ctrl+K`) that opens a command palette with live results.

#### Scenario: Keyboard shortcut
- **WHEN** the visitor presses the shortcut on any page
- **THEN** the palette opens with the input focused and arrow keys plus Enter navigate results

### Requirement: Query safety
The system MUST treat search input as plain text so that special characters or malformed query syntax never cause an error or injection.

#### Scenario: Special characters
- **WHEN** the query is `"unclosed & | ! ( `
- **THEN** the request succeeds and returns results or an empty state
