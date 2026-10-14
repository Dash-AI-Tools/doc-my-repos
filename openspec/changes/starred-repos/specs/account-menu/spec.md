## Purpose

Puts the administration links and sign-out behind the signed-in user's email in the site header, so the top bar carries no admin navigation of its own.

## ADDED Requirements

### Requirement: Account menu in the site header
The system SHALL show the signed-in user's email in the site header as a button that opens an account menu, at every screen width. A long email SHALL be truncated visually while the full address stays available to assistive technology. The header SHALL NOT show a signed-out state button or menu when nobody is signed in.

#### Scenario: Email opens the menu
- **WHEN** a signed-in user activates their email in the header
- **THEN** the account menu opens beneath it and the button reports that it is expanded

#### Scenario: Visible on small screens
- **WHEN** a signed-in user views the header on a phone-width screen
- **THEN** the email button is shown (truncated if needed) and opens the same menu

#### Scenario: No menu when signed out
- **WHEN** nobody is signed in (the login page)
- **THEN** the header shows no email button and no account menu

### Requirement: Administration links live in the account menu
The system SHALL offer the administration pages (Administration overview, Users, Repository access, GitHub configuration) only inside the account menu, and only to admins. The header's main navigation SHALL NOT contain an Admin link or any administration link for any user. Non-admin users SHALL see no administration links anywhere in the header. Hiding the links is a convenience and not access control: the admin pages and APIs stay protected as the access-control rules define.

#### Scenario: Admin sees admin links in the menu
- **WHEN** an admin opens the account menu
- **THEN** it lists Administration, Users, Repository access and GitHub configuration, each linking to its page

#### Scenario: Top bar has no admin link
- **WHEN** an admin views any page
- **THEN** the main navigation in the header shows no Admin link and no other administration link until the account menu is opened

#### Scenario: Viewer sees no admin links
- **WHEN** a user with the `user` role opens the account menu
- **THEN** it contains no administration links

#### Scenario: Current admin page is marked
- **WHEN** an admin opens the menu while on an administration page
- **THEN** the link to that page is marked as the current page

### Requirement: Sign out from the account menu
The system SHALL offer Sign out as the last item of the account menu, for every signed-in user, separated from the links, and SHALL remove the separate Sign out button from the header bar. Activating it SHALL behave as signing out does today: the session ends and the user lands on the login page.

#### Scenario: Sign out
- **WHEN** a signed-in user opens the account menu and activates Sign out
- **THEN** the session is cleared and the user is taken to `/login`

#### Scenario: No separate sign-out button
- **WHEN** a signed-in user views the header with the menu closed
- **THEN** no Sign out button is visible in the bar

### Requirement: Account menu behaviour and accessibility
The account menu SHALL close when the user presses Escape (returning focus to the email button), clicks or taps outside it, activates a link in it, or navigates to another page. It SHALL be fully usable by keyboard (the email button and every item reachable with Tab, activated with Enter or Space) and by touch, SHALL name its trigger and state to assistive technology, SHALL show a visible focus indicator, and SHALL be readable in both themes. Opening it SHALL NOT shift the page layout, and it SHALL stay within the viewport at phone width.

#### Scenario: Escape closes and returns focus
- **WHEN** the menu is open and the user presses Escape
- **THEN** it closes and focus is on the email button

#### Scenario: Outside click closes
- **WHEN** the menu is open and the user clicks or taps elsewhere on the page
- **THEN** it closes

#### Scenario: Choosing a link closes the menu
- **WHEN** the user activates a link in the menu
- **THEN** the page navigates there and the menu is closed

#### Scenario: Keyboard use
- **WHEN** a keyboard user focuses the email button, opens the menu with Enter or Space, and presses Tab
- **THEN** focus moves through each menu item in order and each can be activated with Enter

#### Scenario: Fits a phone screen
- **WHEN** the menu is open on a phone-width screen
- **THEN** it is fully inside the viewport and does not cause horizontal scrolling
