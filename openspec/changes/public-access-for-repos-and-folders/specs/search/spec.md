# Spec Delta

## MODIFIED Requirements

### Requirement: Global search access
The system SHALL offer search to signed-in users from every page via a search bar and a keyboard shortcut (`⌘K` / `Ctrl+K`) that opens a command palette with live results, and to anonymous visitors in the same way only when public search is on (see `public-access`).

#### Scenario: Keyboard shortcut
- **WHEN** the visitor presses the shortcut on any page
- **THEN** the palette opens with the input focused and arrow keys plus Enter navigate results

#### Scenario: Anonymous visitor with public search off
- **WHEN** an anonymous visitor views a public page while public search is off
- **THEN** there is no search bar and the shortcut opens nothing
