## Purpose

Gives readers a distraction-free view of a document that can be turned on and off from the reading options panel in the top bar or with the R key, without losing their place, and keeps the single-key shortcut safe and switchable.

## ADDED Requirements

### Requirement: Read mode toggle
The system SHALL let a reader turn read mode on and off on a document page with a "Read mode" button in the reading options panel (opened by the reading options icon button in the top bar) and with the R key. Both SHALL act on the same state, and the button SHALL show whether read mode is on. The button SHALL have an accessible name and a visible icon (an open book), and SHALL close the panel when activated. The reading options button SHALL expose the shortcut to assistive technology only while the shortcut is enabled.

#### Scenario: Button turns it on
- **WHEN** a reader opens the reading options panel on a document page and activates Read mode
- **THEN** the page switches to read mode, the panel closes, and the button is shown as pressed the next time the panel is opened

#### Scenario: R key turns it on and off
- **WHEN** a reader presses R on a document page with focus on the page, and again later
- **THEN** read mode turns on and then off

#### Scenario: Escape leaves read mode
- **WHEN** read mode is on and the reader presses Escape with nothing else open
- **THEN** read mode turns off

#### Scenario: Reading controls stay in reach
- **WHEN** read mode is on
- **THEN** the floating controls offer the same reading options panel (size, theme) beside the exit control

#### Scenario: Floating exit control
- **WHEN** read mode is on
- **THEN** a visible control named "Exit read mode" is on screen and turns read mode off

### Requirement: What read mode shows
The system SHALL, in read mode, show the document's title, description, notices, body and previous/next links in one centered column with a line length suited to reading and generous line spacing, and SHALL hide the top bar, footer, docs structure, headings column, document bar, breadcrumbs, source and sync row and OKF metadata card. Hidden parts SHALL be unreachable by keyboard and assistive technology while hidden. Code blocks, tables and diagrams SHALL remain usable (scrolling or enlarging as before). Read mode SHALL work in both themes.

#### Scenario: Only the document remains
- **WHEN** read mode is on for a document
- **THEN** the title and body are shown in one centered column and the top bar, footer, docs tree and headings column are not shown

#### Scenario: Hidden parts are not focusable
- **WHEN** read mode is on and the reader tabs through the page
- **THEN** focus never lands on a hidden part, only on the document's own links and the floating controls

#### Scenario: Wide content still works
- **WHEN** a document with a wide table or code block is read in read mode
- **THEN** the block scrolls sideways inside the column and the page itself does not scroll sideways

#### Scenario: Both themes
- **WHEN** read mode is on in the light theme and in the dark theme
- **THEN** all text and controls meet the portal's contrast minimums in both

### Requirement: Paper and serif
The system SHALL, in read mode, show the page on a warm beige background with dark brown text and set the document's text (title, description, body and previous/next links) in a serif typeface, while code keeps its monospace face. In the dark theme the background SHALL be a warm dark sepia with light cream text rather than beige, so read mode stays comfortable in the dark. The floating controls, code blocks and tables SHALL take the same paper colors. Text, links and code SHALL meet the portal's contrast minimums in both. Leaving read mode SHALL restore the normal colors and typeface exactly.

#### Scenario: Beige and serif
- **WHEN** read mode is on in the light theme
- **THEN** the page background is beige, the document text is serif and code is still monospace

#### Scenario: Dark sepia
- **WHEN** read mode is on in the dark theme
- **THEN** the page background is a warm dark and the text is light cream, with no beige

#### Scenario: Exit restores
- **WHEN** read mode turns off
- **THEN** the page returns to its normal colors and typeface

### Requirement: Where read mode is available
The system SHALL offer read mode only on pages that show a document. On other pages (home, search, repository, admin, sign-in) the Read mode button SHALL NOT be in the panel and the R key SHALL do nothing. Read mode SHALL stay on while the reader moves from one document to another, SHALL turn off when the reader reaches a page that is not a document, and SHALL be off on every fresh page load.

#### Scenario: No button elsewhere
- **WHEN** a reader is on the home page
- **THEN** the reading options panel has no Read mode button and pressing R changes nothing

#### Scenario: Stays on between documents
- **WHEN** read mode is on and the reader follows a link to another document
- **THEN** the new document opens in read mode

#### Scenario: Leaves a non-document page
- **WHEN** read mode is on and the reader follows a link to a page that is not a document
- **THEN** that page shows its normal layout and the next document page starts with read mode off

#### Scenario: Reload resets
- **WHEN** read mode is on and the reader reloads the page
- **THEN** the page loads in its normal layout

### Requirement: The R key is safe
The system SHALL treat R as the read mode shortcut only when the key press cannot be meant for something else. It SHALL be ignored while the reader is typing in a text field, text area, select or editable region, while Ctrl, Cmd or Alt is held (so the browser's reload shortcuts are untouched), while a dialog, the search palette or an open menu has the reader's attention, while an input method is composing text, and for held-down key repeats. A single press SHALL toggle exactly once.

#### Scenario: Typing is not interrupted
- **WHEN** the reader types the letter r into the search field
- **THEN** the letter is entered and read mode does not change

#### Scenario: Browser reload untouched
- **WHEN** the reader presses Ctrl+R or Cmd+R
- **THEN** the browser reloads as usual and read mode does not change

#### Scenario: Dialog open
- **WHEN** the search palette or the docs panel is open and the reader presses R
- **THEN** read mode does not change

#### Scenario: Held key
- **WHEN** the reader holds R down
- **THEN** read mode toggles once, not repeatedly

### Requirement: The shortcut can be turned off
The system SHALL let the reader turn the R key shortcut off and on again from the reading options panel in the top bar, with a checkbox named for the shortcut that is on by default. The choice SHALL be remembered in the same browser, SHALL apply on every page, and SHALL NOT disable the button or Escape.

#### Scenario: Turned off
- **WHEN** the reader unchecks the shortcut and then presses R on a document page
- **THEN** read mode does not change, and the button still toggles it

#### Scenario: Remembered
- **WHEN** the reader turned the shortcut off and later opens another page or returns another day
- **THEN** the shortcut is still off and the checkbox is unchecked

#### Scenario: Turned back on
- **WHEN** the reader checks the box again
- **THEN** pressing R toggles read mode again

### Requirement: Focus, announcements and place
The system SHALL, when read mode turns on, move keyboard focus to the start of the document content, and when it turns off, return focus to the reading options button in the top bar (the control that holds the Read mode button). It SHALL announce the change to screen readers ("Read mode on. Press R or Escape to exit." and "Read mode off.", the shortcut named only while enabled). It SHALL keep the reader's place: the part of the document that was in view stays in view after the layout changes.

#### Scenario: Focus into the content
- **WHEN** read mode turns on
- **THEN** keyboard focus is at the start of the document content and not on a hidden control

#### Scenario: Focus back
- **WHEN** read mode turns off
- **THEN** keyboard focus is on the reading options button in the top bar

#### Scenario: Announcement
- **WHEN** read mode turns on or off
- **THEN** a polite status message announces the new state

#### Scenario: Place kept
- **WHEN** a reader halfway through a long document turns read mode on
- **THEN** the heading or paragraph they were reading is still in view and the page does not jump to the top

### Requirement: Without script
The system SHALL leave a page without script fully readable: when scripts have not run or are disabled, no reading options button or Read mode button is shown (only an inert placeholder) and the document keeps its normal layout.

#### Scenario: No button without script
- **WHEN** a document page is loaded with scripts disabled
- **THEN** no reading options or Read mode button is present and the document, docs structure and headings lists are shown as usual
