# docs-reader-layout Specification

## Purpose
Defines how the document page and the repository page arrange the docs structure, the main content and its heading outline across screen sizes, how the layout uses the viewport width, and how the two navigation panels behave when they cannot be columns.

## Requirements

### Requirement: Three-column reading layout on large screens
On a viewport of 1280px or wider, the document page SHALL show three columns side by side: the docs structure and filters on the left, the document in the centre, and the document's headings on the right. The left and right columns SHALL stay in view while the document scrolls and SHALL scroll on their own when they are taller than the viewport.

#### Scenario: Three columns
- **WHEN** a visitor opens a document on a 1440px-wide viewport
- **THEN** the docs structure is left of the document and the headings are right of it, with no hamburger button and no headings dropdown shown

#### Scenario: Columns stay in view
- **WHEN** the visitor scrolls a long document on a 1440px-wide viewport
- **THEN** the docs structure and the headings remain visible beside it

#### Scenario: Tall structure scrolls alone
- **WHEN** the docs structure is taller than the viewport
- **THEN** it scrolls inside its own column and the page and the document do not move

### Requirement: Full viewport width
On a viewport of 1024px or wider, the reading layout SHALL use the full width of the viewport instead of a centred page of limited width. The site header and footer SHALL span the same width, so their edges line up with the columns. The content column SHALL keep a readable line length and sit centred between the side columns.

#### Scenario: Wide monitor
- **WHEN** a visitor opens a document on a 2560px-wide viewport
- **THEN** the docs structure sits at the left edge and the headings at the right edge, with the same side padding as the header, and the document stays about 60rem wide and centred between them

#### Scenario: Other pages keep their width
- **WHEN** a visitor opens the home page or the search page on a 2560px-wide viewport
- **THEN** their content keeps the limited page width it has today

### Requirement: Repository page reading layout
The repository page SHALL use the same layout as the document page with the README as its main content: the docs structure and filters on the left, the README in the centre, and the README's headings on the right (a column from 1280px, a dropdown below). The repository header (breadcrumb, name and details) SHALL sit at the top of the content column and the code owners SHALL follow the README.

#### Scenario: Three columns
- **WHEN** a visitor opens `/<owner>/<repo>` on a 1440px-wide viewport
- **THEN** the docs structure is on the left, the README in the centre and the README headings on the right, with the code owners below the README

#### Scenario: Phone
- **WHEN** a visitor opens `/<owner>/<repo>` on a 375px-wide viewport
- **THEN** a bar above the repository header holds the hamburger button and the README headings dropdown, and the docs structure opens in the slide-in panel

### Requirement: Repository page without a README or headings
A repository page whose README is missing, shown as plain text, or has no h2 to h4 headings SHALL show no headings column and no headings dropdown, and SHALL keep the docs structure and the code owners.

#### Scenario: No README
- **WHEN** the repository has no README
- **THEN** the page says so, shows the docs structure and the code owners, and shows no headings column or dropdown

### Requirement: Docs structure column
The left column SHALL list the repository's documentation folders and documents in the same hierarchy as in the repository, mark the current document, and open the folders that contain it. For an OKF repository it SHALL show the navigation view selector first, and in the OKF view it SHALL show the type, tag and status filters above the structure, and selecting a filter SHALL narrow the structure as it does today. A repository that is not OKF SHALL show no selector and no filters.

#### Scenario: Hierarchy and current document
- **WHEN** a visitor opens `guides/advanced/tuning`
- **THEN** the `guides` and `advanced` folders are open and `Tuning` is marked as the current document

#### Scenario: OKF type filter
- **WHEN** a visitor selects the `Concept` type in an OKF repository
- **THEN** only the documents with that type remain in the structure and the selection is kept in the page address

#### Scenario: Not an OKF repository
- **WHEN** the repository has no OKF documents
- **THEN** the left column shows the structure and no selector or filter controls

### Requirement: Navigation view selector
For an OKF repository, the docs structure SHALL start with a selector offering two views, "OKF" and "Tree". The selector SHALL show which view is active and SHALL be operable by keyboard. The OKF view SHALL be the existing structure with its filters. The selector SHALL be present on both the repository page and the document page.

#### Scenario: Selector placement
- **WHEN** a visitor opens an OKF repository's page on a large screen
- **THEN** the selector is the first control in the left column, above the "Documentation" label, the filters and the structure, with "OKF" marked as active

#### Scenario: Switch to Tree
- **WHEN** the visitor chooses "Tree"
- **THEN** the structure is replaced by the Tree view, the filters disappear, "Tree" is marked as active, and the document being read stays open

#### Scenario: Switch back to OKF
- **WHEN** the visitor in the Tree view chooses "OKF"
- **THEN** the OKF structure and its filters return

#### Scenario: Without JavaScript
- **WHEN** the visitor chooses "Tree" with JavaScript disabled
- **THEN** the page reloads showing the Tree view

### Requirement: Tree view mirrors repository paths
The Tree view SHALL list the synced documents under the docs folder in their repository folders, labeled by file or folder name exactly as stored, with the `.md` or `.mdx` extension removed from file names. In each folder, subfolders SHALL come first and then files, each sorted by name. `index.md` and `log.md` SHALL be listed as ordinary files, and folders SHALL only open and close.

#### Scenario: Names and order
- **WHEN** the docs folder holds `log.md`, `index.md`, `guides/setup.md`, `guides/index.md` and `guides/advanced/tuning.md`
- **THEN** the Tree view lists `guides` (containing `advanced` with `tuning`, then `index`, then `setup`), then `index`, then `log`

#### Scenario: Title differs from file name
- **WHEN** `guides/setup.md` has the title "Getting started"
- **THEN** the Tree view shows it as `setup`

#### Scenario: No OKF labels
- **WHEN** the Tree view lists an OKF repository's `log.md` and typed documents
- **THEN** no "Change log" label, type badge or filter control is shown

#### Scenario: Filters in the address
- **WHEN** a page address carries a type filter and the visitor's view is Tree
- **THEN** the Tree view lists every document and ignores the filter

### Requirement: Remembered navigation view
The chosen view SHALL be remembered in the visitor's browser and applied to every OKF repository page and document page, and the server SHALL render the remembered view in the first response so no other view is shown first. Without a stored choice, or with an unrecognized stored value, the OKF view SHALL be shown.

#### Scenario: Choice persists across pages
- **WHEN** a visitor chooses "Tree" and then opens a document in another OKF repository
- **THEN** that page shows the Tree view

#### Scenario: Default
- **WHEN** a visitor with no stored choice opens an OKF repository
- **THEN** the OKF view is shown

#### Scenario: Unrecognized stored value
- **WHEN** the stored choice holds an unknown value
- **THEN** the OKF view is shown and the page works normally

### Requirement: Selector in the docs structure panel
Below 1024px, the selector SHALL appear at the top of the docs structure panel, under its close button. Switching view SHALL keep the panel open, and focus SHALL remain inside the panel.

#### Scenario: Switch inside the panel
- **WHEN** the visitor opens the panel on a phone and chooses "Tree"
- **THEN** the panel stays open showing the Tree view and focus stays in the panel

### Requirement: Headings column
The right column SHALL list the document's h2 to h4 headings as links to their sections, nested by level, and SHALL mark the section being read as the visitor scrolls. A document with no such headings SHALL show no headings column and no headings dropdown.

#### Scenario: Current section follows scrolling
- **WHEN** the visitor scrolls into the section "Environment"
- **THEN** that heading is marked as current in the headings list

#### Scenario: No headings
- **WHEN** a document has no h2 to h4 headings
- **THEN** no headings list or dropdown is shown and the document uses the width that remains

### Requirement: Two columns on medium screens
On a viewport from 1024px to 1279px wide, the document page SHALL show the docs structure and filters in a left column and the document beside it, and SHALL show the headings as a dropdown at the top of the document instead of a column.

#### Scenario: Medium layout
- **WHEN** a visitor opens a document on a 1100px-wide viewport
- **THEN** the docs structure is a left column, the headings are a dropdown above the document title, and there is no hamburger button

### Requirement: Single column on small screens
On a viewport narrower than 1024px, the document page SHALL show only the document in the page flow, with a bar above it that holds a hamburger button for the docs structure and a dropdown for the headings. The page SHALL NOT scroll sideways. The bar SHALL stay visible under the site header while the document scrolls.

#### Scenario: Phone layout
- **WHEN** a visitor opens a document on a 375px-wide viewport
- **THEN** the document fills the width, the bar shows the hamburger button and the headings dropdown, and the docs structure is not shown until the button is used

#### Scenario: Bar stays reachable
- **WHEN** the visitor scrolls halfway down a long document on a phone
- **THEN** the bar is still visible under the site header

#### Scenario: No sideways scroll
- **WHEN** a document with a wide table or code block is open on a phone
- **THEN** the page itself does not scroll horizontally

### Requirement: Docs structure panel
On a viewport narrower than 1024px, the hamburger button SHALL open the docs structure and filters in a panel that slides in from the left over the page, with a backdrop. The button SHALL state whether the panel is open. Esc, the backdrop and a close button SHALL close it, focus SHALL stay inside the panel while it is open and return to the button when it closes, and the page behind SHALL NOT scroll.

#### Scenario: Open and close
- **WHEN** the visitor presses the hamburger button and then Esc
- **THEN** the panel opens with focus inside it, then closes and focus returns to the button

#### Scenario: Choose a document
- **WHEN** the visitor chooses a document in the panel
- **THEN** the panel closes and that document opens

#### Scenario: Use a filter
- **WHEN** the visitor selects an OKF type filter in the panel
- **THEN** the structure narrows and the panel stays open

#### Scenario: Keyboard containment
- **WHEN** the panel is open and the visitor presses Tab past its last control
- **THEN** focus moves to its first control and does not reach the page behind

### Requirement: Headings dropdown
On a viewport narrower than 1280px, the headings dropdown SHALL open a list of the document's headings under its button, state whether it is open, and mark the current section. Choosing a heading SHALL jump to that section with the heading clear of the site header and the bar, and close the dropdown. Esc, a press outside it and a second press of the button SHALL close it.

#### Scenario: Jump to a section
- **WHEN** the visitor opens the dropdown and chooses "Architecture"
- **THEN** the dropdown closes, the page scrolls to that heading, and the heading is fully visible

#### Scenario: Close without choosing
- **WHEN** the dropdown is open and the visitor presses Esc
- **THEN** it closes and focus returns to its button

#### Scenario: Long list
- **WHEN** a document has more headings than fit the viewport
- **THEN** the dropdown list scrolls inside itself

### Requirement: Works without JavaScript
Before scripts run, or when they do not, the document SHALL come first in the page, and the docs structure and the headings SHALL be reachable as plain lists of links without needing the hamburger button or the dropdown to open.

#### Scenario: No script
- **WHEN** a document page is loaded with JavaScript disabled on a phone-width viewport
- **THEN** the document is shown and the docs structure and the headings are available below it as lists of links
