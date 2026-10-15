## Purpose

Lets every user pick the size of the portal's text from the top bar, so readers who need larger (or smaller) text get it everywhere without browser zoom, and the layout keeps working at every size.

## ADDED Requirements

### Requirement: Text size control in the top bar
The system SHALL show a text size button (labelled "Aa", named "Text size and reading options" for assistive technology) in the top bar of every page, including the sign-in page. Activating it SHALL open a panel offering five sizes: Small (87.5%), Default (100%), Large (112.5%), Larger (125%) and Largest (150%), with the current one marked. Choosing a size SHALL apply it at once. The panel SHALL be operable by keyboard, close with Escape (returning focus to the button), close when the reader clicks elsewhere or moves focus out, and SHALL NOT trap focus.

#### Scenario: Open and choose
- **WHEN** a reader opens the panel and chooses Large
- **THEN** the interface text becomes 112.5% of the browser's default size at once and Large is marked as current

#### Scenario: Keyboard
- **WHEN** a reader opens the panel with the keyboard, moves between sizes with the arrow keys and selects one
- **THEN** the size applies and focus stays inside the panel until it is closed

#### Scenario: Escape closes
- **WHEN** the panel is open and the reader presses Escape
- **THEN** the panel closes, the size is unchanged, and focus returns to the "Aa" button

#### Scenario: Shown everywhere
- **WHEN** a signed-out visitor opens the sign-in page
- **THEN** the text size button is in the top bar and works

### Requirement: Size applies to the whole interface
The system SHALL apply the chosen size to all text and to the spacing and controls that scale with it across every page, relative to the size the reader's browser is set to, so a browser default larger than 16px is respected. Default SHALL equal the current appearance. Code, tables, headings, the top bar, the footer, the docs structure and the admin pages SHALL all follow the chosen size.

#### Scenario: Whole interface scales
- **WHEN** a reader chooses Largest
- **THEN** document text, headings, code, navigation, the top bar and the footer are all larger than at Default

#### Scenario: Browser default respected
- **WHEN** a reader whose browser default text size is 20px keeps Default
- **THEN** text is shown at 20px as the browser setting dictates

#### Scenario: Default unchanged
- **WHEN** no size was ever chosen
- **THEN** the portal looks as it did before this feature

### Requirement: Layout keeps working at every size
The system SHALL keep every page usable at every size: no horizontal page scroll at a 320 CSS pixel wide viewport at Largest (except inside code blocks and wide tables, which scroll on their own), no overlapping or clipped text in the top bar, document page columns that never become unreadably narrow (the docs structure and headings columns keep their width instead of growing with the text), and controls that stay at least 24 by 24 CSS pixels. Colors and contrast SHALL be unaffected by the size.

#### Scenario: Phone at Largest
- **WHEN** a reader at 320 CSS pixels wide chooses Largest and opens a document
- **THEN** the page has no horizontal scroll and every top bar control is reachable

#### Scenario: Three columns stay readable
- **WHEN** a reader on a wide screen chooses Largest on a document page
- **THEN** the document column is still wide enough for comfortable reading and the side columns do not push it narrower than that

#### Scenario: Header wraps
- **WHEN** the top bar content does not fit in one row at a large size
- **THEN** it wraps onto another row without overlapping or hiding anything

### Requirement: Choice is remembered
The system SHALL remember the chosen size in the reader's browser, SHALL apply it on the first paint of every page with no flash of the default size, and SHALL need no sign-in. A missing or unrecognized stored value SHALL mean Default. Choosing Default SHALL clear the stored value. The stored value SHALL contain only the size name, and the system SHALL set no cookie for readers who never change a setting.

#### Scenario: Persists across pages and visits
- **WHEN** a reader chooses Larger and later opens other pages or returns another day in the same browser
- **THEN** every page is shown at Larger from the first paint

#### Scenario: No flash
- **WHEN** a page is loaded with Larger remembered
- **THEN** the server-rendered page is already at Larger, with no visible change after scripts load

#### Scenario: Garbage ignored
- **WHEN** the stored value is not one of the five size names
- **THEN** the page is shown at Default and the control marks Default

#### Scenario: Nothing stored by default
- **WHEN** a reader has never used the control
- **THEN** no preference is stored

#### Scenario: Back to Default
- **WHEN** a reader chooses Default after choosing a larger size
- **THEN** the stored value is removed

### Requirement: Size control is part of the reading panel
The system SHALL show, in the same panel as the sizes, the control for turning the R key shortcut off and on, so the top bar has one place for reading preferences.

#### Scenario: Shortcut checkbox in the panel
- **WHEN** a reader opens the text size panel
- **THEN** it also contains the checkbox for the R key shortcut, and using it does not change the text size
