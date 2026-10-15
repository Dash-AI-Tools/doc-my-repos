# Spec Delta

## MODIFIED Requirements

### Requirement: Document page navigation
The system SHALL render each document at a stable URL under its repository, with an "on this page" heading list, a link to the source on GitHub, and previous/next links within the table of contents. The previous/next links SHALL follow the order of the navigation view being shown (OKF or Tree).

#### Scenario: Open a document
- **WHEN** a visitor opens `/<owner>/<repo>/docs/guides/setup`
- **THEN** the rendered document, its heading outline, and previous/next links are shown

#### Scenario: Missing document
- **WHEN** the path does not match a synced document
- **THEN** a not-found page links back to the repository space

#### Scenario: Previous and next in the Tree view
- **WHEN** a visitor with the Tree view opens `guides/index` in an OKF repository whose `guides` folder holds `advanced/tuning.md`, `index.md` and `setup.md`
- **THEN** the previous link goes to `guides/advanced/tuning` and the next link goes to `guides/setup`
