## Purpose

Gives every user one reading options button in the top bar: a text size slider, the read mode button and the theme switch. It lets readers pick the size of the portal's text, so readers who need larger (or smaller) text get it everywhere without browser zoom, and the layout keeps working at every size.

## ADDED Requirements

### Requirement: Reading options button in the top bar
The system SHALL show one icon button (a sliders icon, named "Text size and reading options" for assistive technology) in the top bar of every page, including the sign-in page. It SHALL be the only reading control in the top bar: the Read mode button and the theme switch live in the panel it opens. It SHALL show an inert same-size placeholder until the page has hydrated, so nothing shifts when it appears.

#### Scenario: Shown everywhere
- **WHEN** a signed-out visitor opens the sign-in page
- **THEN** the reading options button is in the top bar and works

#### Scenario: One control
- **WHEN** a reader looks at the top bar
- **THEN** there is no separate read mode button, text size button or theme switch beside it

### Requirement: Reading options panel
Activating the reading options button SHALL open a panel with, in order: a text size slider, a Read mode button, the theme buttons (Light, Dark, System) and the "Press R for read mode" checkbox. The slider SHALL have five stops (Small 87.5%, Default 100%, Large 112.5%, Larger 125%, Largest 150%), show the current size in its label, expose it as its value text (for example "Larger, 125%") and apply a choice at once. The Read mode button SHALL be present only on pages that can be read in read mode, SHALL show whether read mode is on, and SHALL close the panel when activated. The theme buttons SHALL behave as the portal's theme switch, with the stored choice selected.

#### Scenario: Open and choose
- **WHEN** a reader opens the panel and moves the slider to Large
- **THEN** the interface text becomes 112.5% of the browser's default size at once and the label reads "Large (112.5%)"

#### Scenario: Guide dots
- **WHEN** a reader opens the panel
- **THEN** five small dots under the slider mark the five stops, the dot for the current size is highlighted, and the dots are hidden from assistive technology

#### Scenario: Keyboard slider
- **WHEN** a reader opens the panel with the keyboard and presses the arrow keys, Home or End on the slider
- **THEN** the size moves one stop (or to an end) and applies at once

#### Scenario: Read mode button
- **WHEN** a reader on a document page activates Read mode in the panel
- **THEN** read mode turns on and the panel closes

#### Scenario: No read mode button elsewhere
- **WHEN** a reader opens the panel on a page that is not a document
- **THEN** the panel has the slider, the theme buttons and the checkbox, and no Read mode button

#### Scenario: Theme from the panel
- **WHEN** a reader chooses Dark in the panel
- **THEN** the portal switches to the dark theme at once and Dark is marked as selected

#### Scenario: Theme readable in the panel
- **WHEN** the panel is open in either theme, with or without a colored top bar
- **THEN** the theme buttons and every other control in the panel meet the portal's contrast minimums

### Requirement: Panel behaviour
The panel SHALL be a disclosure that does not trap focus. It SHALL close with Escape (returning focus to the button), when the reader presses elsewhere on the page, and when keyboard focus moves to something outside it. It SHALL NOT close merely because a click inside it set no focus (some browsers do not focus a clicked button or slider). While it is open, the R key SHALL be ignored.

#### Scenario: Escape closes
- **WHEN** the panel is open and the reader presses Escape
- **THEN** the panel closes, the size is unchanged, and focus returns to the reading options button

#### Scenario: Click outside closes
- **WHEN** the panel is open and the reader presses elsewhere on the page
- **THEN** the panel closes and the chosen size stays

#### Scenario: Tab out closes
- **WHEN** the panel is open and keyboard focus moves to a control outside it
- **THEN** the panel closes

#### Scenario: Clicking inside stays open
- **WHEN** a reader clicks the slider or a theme button in a browser that does not focus it
- **THEN** the panel stays open and the choice applies

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

### Requirement: Shortcut setting is part of the panel
The system SHALL show, in the same panel as the slider, the control for turning the R key shortcut off and on, so the top bar has one place for reading preferences.

#### Scenario: Shortcut checkbox in the panel
- **WHEN** a reader opens the reading options panel
- **THEN** it also contains the checkbox for the R key shortcut, and using it changes neither the text size nor the theme
