# theming Specification

## Purpose

Defines light, dark, and system color themes applied consistently across the interface, code blocks, and diagrams.

## Requirements

### Requirement: Light, dark, and system themes
The system SHALL support light, dark, and system-follow themes, defaulting to system, with a toggle available on every page.

#### Scenario: System preference
- **WHEN** a first-time visitor's OS prefers dark mode
- **THEN** the dark theme is applied

#### Scenario: Manual choice persists
- **WHEN** the visitor chooses light and reloads
- **THEN** light remains active

### Requirement: No flash of wrong theme
The system SHALL apply the visitor's theme before first paint.

#### Scenario: Dark preference on load
- **WHEN** a visitor with a stored dark preference loads any page
- **THEN** the page never visibly renders in light first

### Requirement: Consistent theming of content
The system SHALL apply the active theme to rendered Markdown, code blocks, metadata cards, and Mermaid diagrams, and SHALL maintain readable text contrast in both themes.

#### Scenario: Theme change updates content
- **WHEN** the theme changes while a document with a code block and a diagram is open
- **THEN** both update to the new theme without a reload

#### Scenario: Contrast
- **WHEN** body text, links, and badges are measured in both themes
- **THEN** they meet WCAG AA contrast
