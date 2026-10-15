# org-branding Specification

## Purpose
Lets an organization make its portal its own (logo, name, tab title, brand colors, colored top bar) while the DocMyRepos project stays credited in the footer.

## Requirements

### Requirement: Admin branding settings
The system SHALL let admins view and change the portal's branding settings (organization name, page title, logo, logo inversion, primary color, accent color, colored top bar) from a Branding page in the admin area. The settings SHALL be one portal-wide set, SHALL persist across restarts, and SHALL take effect on the next page load for every visitor. An unset value SHALL mean the built-in default. An admin SHALL be able to reset all branding to the defaults in one action.

#### Scenario: Admin saves settings
- **WHEN** an admin saves a new organization name
- **THEN** the setting is stored and the next page load for any visitor shows it

#### Scenario: Nothing configured
- **WHEN** no branding has been set
- **THEN** the portal looks and reads as it did before this feature, with the DocMyRepos wordmark and title

#### Scenario: Reset to defaults
- **WHEN** an admin resets branding
- **THEN** every setting and the logo are cleared and the portal returns to the defaults

#### Scenario: Invalid value
- **WHEN** an admin submits an invalid value, such as a malformed color or an over-long name
- **THEN** nothing is saved and the page names the field and the problem

### Requirement: Branding is admin only
The system SHALL reject attempts by non-admin users to read the editable settings or to change, upload, remove or reset any branding with 403, and by unauthenticated callers with 401, and SHALL change nothing in either case.

#### Scenario: Viewer cannot change branding
- **WHEN** a user with the `user` role submits branding changes or a logo
- **THEN** the response is 403 and nothing changes

#### Scenario: Unauthenticated caller
- **WHEN** a request without a session tries to change branding
- **THEN** the response is 401 and nothing changes

### Requirement: Logo
The system SHALL let admins upload one logo (PNG, JPEG, WebP or SVG, at most 512 KB) and remove it. The type SHALL be determined from the file's content, not from its name or declared type; any other content, an empty file or an oversized file SHALL be rejected with no change. The logo SHALL be shown in the top bar on every page, including the sign-in page, so it SHALL be served without a session. It SHALL be served only as an image, in a way that cannot run script even when opened directly. A new upload SHALL replace the old logo and be visible without stale caching.

#### Scenario: Logo shown in the top bar
- **WHEN** an admin uploads a valid logo
- **THEN** it appears in the top bar of every page, left of the organization name

#### Scenario: Logo on the sign-in page
- **WHEN** a signed-out visitor opens the sign-in page after a logo was uploaded
- **THEN** the logo is shown

#### Scenario: Unsupported content
- **WHEN** an admin uploads a file that is not PNG, JPEG, WebP or SVG content, such as an HTML file renamed to `logo.png`
- **THEN** it is rejected and the previous logo, if any, stays

#### Scenario: Oversized logo
- **WHEN** an admin uploads a file over 512 KB
- **THEN** it is rejected and the previous logo stays

#### Scenario: Script in an SVG logo
- **WHEN** an uploaded SVG logo contains script
- **THEN** no script runs, whether the logo is shown in the page or its address is opened directly

#### Scenario: Remove the logo
- **WHEN** an admin removes the logo
- **THEN** the top bar shows no logo and the logo address answers 404

#### Scenario: Replacement is seen
- **WHEN** an admin replaces the logo
- **THEN** visitors see the new logo on their next page load, not the cached old one

### Requirement: Logo on dark surfaces
The system SHALL, by default, show the logo with its colors inverted (transparency kept) wherever it sits on a dark surface: in the dark theme, and on a colored top bar whose text is light. Admins SHALL be able to turn this inversion off for logos that already work on dark surfaces. The inversion SHALL be presentation only: the stored file and the logo address SHALL always serve the original, and the Branding page preview SHALL show the logo as visitors will see it in each theme.

#### Scenario: Inverted in the dark theme
- **WHEN** a visitor uses the dark theme and the inversion is on
- **THEN** the logo in the top bar is shown inverted

#### Scenario: Not inverted in the light theme
- **WHEN** a visitor uses the light theme with the default top bar
- **THEN** the logo is shown as uploaded

#### Scenario: Light text on a colored bar
- **WHEN** the colored top bar is on and the bar's text is light in the current theme
- **THEN** the logo is shown inverted, and when the bar's text is dark it is shown as uploaded

#### Scenario: Inversion turned off
- **WHEN** an admin turns the inversion off
- **THEN** the logo is shown as uploaded in every theme

#### Scenario: Original untouched
- **WHEN** the inversion is on and the logo address is opened directly
- **THEN** the original uploaded image is served

### Requirement: Organization name and page title
The system SHALL show the organization name and the page title in the top bar, as the link to the home page. With a logo the bar SHALL show the logo and the page title and SHALL NOT repeat the organization name; without a logo it SHALL show the organization name and the page title. Whichever are set SHALL be shown once, in that order, separated by a middot, and an unset one SHALL be omitted; with neither set the DocMyRepos wordmark SHALL be shown. The system SHALL use the page title as the browser tab title of the home page and as the suffix of every other page's title (for example "Search · Acme Docs"); when no page title is set it SHALL use the organization name, and when neither is set "DocMyRepos". Names and titles SHALL be plain text of 1 to 60 and 1 to 70 characters, trimmed, without control characters, and SHALL always be shown as text. With a logo and no page title, the logo SHALL link to the home page and be named for assistive technology "Home".

#### Scenario: Logo beside the page title
- **WHEN** a logo and an organization name and a page title are all set
- **THEN** the top bar shows the logo followed by the page title, linking to the home page, and the organization name does not appear in it

#### Scenario: No logo
- **WHEN** no logo is set and an organization name and a page title are set
- **THEN** the top bar shows the organization name followed by the page title, as one link to the home page

#### Scenario: Title suffix
- **WHEN** the page title is "Acme Docs" and a visitor opens the search page
- **THEN** the tab title is "Search · Acme Docs"

#### Scenario: Title fallbacks
- **WHEN** only an organization name is set
- **THEN** it is used as the page title; with neither set the title is "DocMyRepos"

#### Scenario: Markup in a name
- **WHEN** the organization name contains angle brackets or markup
- **THEN** it is shown literally as text and nothing is interpreted

### Requirement: Primary and accent colors
The system SHALL let admins set a primary color and an accent color as `#rrggbb` values. The primary color SHALL drive buttons, links, focus indicators, selection and the colored top bar; the accent color SHALL drive accent surfaces such as tinted badges and highlights. The system SHALL derive the text and focus colors and the dark-theme variants from the two values so that every text pairing meets WCAG AA contrast (4.5:1) and every focus indicator and control boundary meets 3:1, in both light and dark themes, for any valid color. The chosen color SHALL be used unchanged as a fill where readable text can be placed on it; where it cannot be used for text or focus directly, a darker or lighter shade of the same hue SHALL be used for those. When a primary color is set, the dark theme's page surfaces (page background, card, muted, popover, secondary, code and border) SHALL be dark shades of that hue and saturation instead of the neutral default, with the text and focus colors derived to stay AA on them; with no primary color set the dark surfaces SHALL stay the neutral default. Colors SHALL NOT affect code highlighting or diagrams.

#### Scenario: Brand color applied
- **WHEN** an admin sets the primary color to a valid color
- **THEN** primary buttons, links and focus rings use that hue in both themes

#### Scenario: Low-contrast color stays readable
- **WHEN** an admin picks a very light color such as pale yellow as the primary color
- **THEN** link and focus colors on the white page are a darker shade of it and meet the contrast minimums, and button text is chosen to be readable

#### Scenario: Dark theme variants
- **WHEN** a visitor switches to the dark theme
- **THEN** the primary and accent colors are shown as shades that meet the contrast minimums on the dark surfaces

#### Scenario: Dark surfaces follow the primary
- **WHEN** an admin sets a primary color and a visitor uses the dark theme
- **THEN** the page background and the card, muted, popover, secondary and code surfaces are dark shades of that hue rather than the neutral near-black, and every text pairing still meets 4.5:1 and every focus indicator 3:1

#### Scenario: Extremes accepted
- **WHEN** an admin picks black, white or a mid-grey as a color
- **THEN** it is accepted and all text and focus pairings still meet the minimums

#### Scenario: Malformed color
- **WHEN** a color is not exactly `#` followed by six hexadecimal digits
- **THEN** it is rejected with no change

#### Scenario: Preview
- **WHEN** an admin edits a color on the Branding page
- **THEN** a preview shows the top bar and sample controls in light and dark themes before saving

### Requirement: Colored top bar
The system SHALL let admins choose between the default top bar (page background) and a top bar filled with the primary color, in both themes. A colored top bar SHALL show its text, links, icons and controls in a color that meets 4.5:1 against the bar, with a focus indicator that meets 3:1 against the bar. The setting SHALL be off by default.

#### Scenario: Colored bar on
- **WHEN** an admin turns the colored top bar on
- **THEN** the top bar is filled with the primary color and everything in it is readable

#### Scenario: Colored bar in dark theme
- **WHEN** the colored top bar is on and a visitor uses the dark theme
- **THEN** the bar uses a shade that keeps its content readable and distinct from the page

#### Scenario: Off by default
- **WHEN** the setting has never been changed
- **THEN** the top bar uses the page background as before

#### Scenario: Controls follow the bar
- **WHEN** the colored top bar is on
- **THEN** the search button, theme toggle and account controls are readable on the bar and keyboard focus is visible on each

### Requirement: DocMyRepos credit in the footer
The system SHALL show in the footer of every page a "Powered by DocMyRepos" credit linking to the DocMyRepos GitHub repository, together with a small "Star" call to action linking to the same repository. Neither SHALL be removable or editable through the admin interface, and branding settings SHALL NOT hide them. Both links SHALL open the repository without sending a referrer or opener access, and the footer SHALL NOT load any external resource (no remote badge or counter).

#### Scenario: Credit shown with a custom brand
- **WHEN** an organization has set a logo, name and colors
- **THEN** the footer still shows "Powered by DocMyRepos" and the star call to action

#### Scenario: Links go to the project
- **WHEN** a visitor follows the credit or the star link
- **THEN** the DocMyRepos repository on GitHub opens in a new tab

#### Scenario: No external requests
- **WHEN** any page is loaded
- **THEN** the footer causes no request to another host

#### Scenario: Not configurable
- **WHEN** an admin looks for a way to hide the credit on the Branding page
- **THEN** there is none

### Requirement: Branding input is never trusted
The system SHALL validate every branding value when it is written and again when it is rendered, SHALL build the style overrides only from validated colors, and SHALL NOT interpret names, titles or logo content as markup or style. A stored value that fails validation when read SHALL be ignored in favour of the default.

#### Scenario: Style injection attempt
- **WHEN** a color value such as `#fff;} body{display:none` is submitted, or placed in storage directly
- **THEN** it is rejected on write, and ignored on read, and no style is emitted from it

#### Scenario: Corrupt stored value
- **WHEN** a stored color or title fails validation on read
- **THEN** the default is used for it and the page still renders
