## Purpose

Defines how Markdown from untrusted repositories is turned into safe, readable pages, including code highlighting, link handling, and Mermaid diagrams.

## ADDED Requirements

### Requirement: GitHub-flavored Markdown rendering
The system SHALL render GitHub-flavored Markdown including tables, task lists, strikethrough, autolinks, footnotes, and heading anchors, and SHALL hide YAML frontmatter from the body.

#### Scenario: Table and task list
- **WHEN** a document contains a table and a task list
- **THEN** both render as structured elements

#### Scenario: Heading anchors
- **WHEN** a document has a heading "Getting Started"
- **THEN** it has a stable anchor that can be linked and appears in the "on this page" list

### Requirement: Safe rendering
The system MUST sanitize rendered content so that scripts, event handlers, and unsafe URL schemes in documents are never executed.

#### Scenario: Embedded script
- **WHEN** a document contains a `<script>` tag or an `onerror` attribute
- **THEN** it is removed or neutralized in the output

#### Scenario: Unsafe link scheme
- **WHEN** a link uses a `javascript:` URL
- **THEN** it is not rendered as an active link

### Requirement: Syntax-highlighted code
The system SHALL highlight fenced code blocks by language, in both light and dark themes, and SHALL provide a copy-to-clipboard control.

#### Scenario: Known language
- **WHEN** a fenced block declares `ts`
- **THEN** it is highlighted and matches the active theme

#### Scenario: Unknown language
- **WHEN** a fenced block declares an unsupported language
- **THEN** it renders as plain preformatted text

### Requirement: Link and image resolution
The system SHALL rewrite relative and bundle-root-absolute links between synced documents to in-app URLs, links to non-synced repository files to the GitHub source URL, and relative images to a proxy that works for private repositories.

#### Scenario: Relative link to another doc
- **WHEN** `guides/setup.md` links to `../concepts/auth.md`
- **THEN** the link navigates to the in-app page for `concepts/auth`

#### Scenario: Bundle-root-absolute link
- **WHEN** a document links to `/tables/orders.md`
- **THEN** it resolves relative to the docs root

#### Scenario: Broken link
- **WHEN** a link points to a file that does not exist
- **THEN** the page still renders and the link is shown as broken without failing

#### Scenario: Private repo image
- **WHEN** a document in a private repository embeds `./img/arch.png`
- **THEN** the image loads through the app without exposing any GitHub credential (installation token or App private key) to the browser

### Requirement: Mermaid diagrams
The system SHALL render fenced `mermaid` code blocks as diagrams, SHALL re-render them when the theme changes, SHALL show the source and an error message when a diagram is invalid, and SHALL let a reader view a diagram enlarged.

#### Scenario: Valid diagram
- **WHEN** a document contains a valid ```mermaid flowchart block
- **THEN** a diagram is displayed instead of the code

#### Scenario: Theme switch
- **WHEN** the reader switches from light to dark theme
- **THEN** diagrams re-render with dark-appropriate colors without a page reload

#### Scenario: Invalid diagram
- **WHEN** the Mermaid source has a syntax error
- **THEN** the block shows the original source and the error, and the rest of the page is unaffected

#### Scenario: Enlarge
- **WHEN** a reader activates a diagram
- **THEN** it opens in an enlarged, pannable view that can be closed with the keyboard
