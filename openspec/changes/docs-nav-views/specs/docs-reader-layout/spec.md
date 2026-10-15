# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
