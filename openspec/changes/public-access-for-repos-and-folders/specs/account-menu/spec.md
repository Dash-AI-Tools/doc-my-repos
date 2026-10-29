# Spec Delta

## MODIFIED Requirements

### Requirement: Account menu in the site header
The system SHALL show the signed-in user's email in the site header as a button that opens an account menu, at every screen width. A long email SHALL be truncated visually while the full address stays available to assistive technology. The header SHALL NOT show an account menu when nobody is signed in; on a page an anonymous visitor can read it SHALL show a Sign in link to `/login` instead, and on the login page it SHALL show neither.

#### Scenario: Email opens the menu
- **WHEN** a signed-in user activates their email in the header
- **THEN** the account menu opens beneath it and the button reports that it is expanded

#### Scenario: Visible on small screens
- **WHEN** a signed-in user views the header on a phone-width screen
- **THEN** the email button is shown (truncated if needed) and opens the same menu

#### Scenario: No menu when signed out
- **WHEN** nobody is signed in (the login page)
- **THEN** the header shows no email button, no account menu and no Sign in link

#### Scenario: Sign in link on a public page
- **WHEN** an anonymous visitor views a public page
- **THEN** the header shows a Sign in link to `/login` in the place of the email button, and no account menu
