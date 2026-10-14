## Purpose

Shows a repository's OpenAPI (Swagger) description, when it has one, as a read-only API reference in the portal.

## ADDED Requirements

### Requirement: Detecting API specs
The system SHALL, for each synced repository, look on the default branch for OpenAPI 3.0, OpenAPI 3.1 and Swagger 2.0 description files in YAML or JSON. By default a candidate is a file named `openapi` or `swagger` (case-insensitive) with the extension `.yaml`, `.yml` or `.json`, located at the repository root or anywhere under the docs folder. When a repository's configuration lists API spec paths, the system SHALL use exactly those paths instead of the default search. A candidate SHALL be accepted only if it parses and declares an `openapi` (3.x) or `swagger` (2.0) version and has an `info` object and a `paths` object or, for 3.1, `components` or `webhooks`.

#### Scenario: Spec at the repository root
- **WHEN** a repository has `openapi.yaml` at its root
- **THEN** the next sync stores it as an API spec of that repository

#### Scenario: Spec under the docs folder
- **WHEN** a repository has `docs/api/swagger.json`
- **THEN** it is detected and stored

#### Scenario: Configured paths replace the search
- **WHEN** a repository's configuration lists `api/v2/spec.yaml`
- **THEN** only that file is considered, and a root `openapi.yaml` is ignored

#### Scenario: Not an API description
- **WHEN** a candidate file is not valid YAML or JSON, or has no OpenAPI or Swagger version
- **THEN** it is skipped, a warning with its path and a fixed reason is recorded for the sync, and the sync still succeeds

#### Scenario: Repository without a spec
- **WHEN** a repository has no candidate files
- **THEN** nothing is stored and the portal shows no API reference for it

### Requirement: Spec limits
The system SHALL skip a candidate larger than the API spec size limit (default 2 MB, configurable only downwards), SHALL store at most 10 specs per repository (the rest, in path order, are skipped with a warning), and SHALL refuse input that expands unreasonably (nesting, anchors and aliases, number of operations or schemas) by skipping it with a warning. A skipped spec SHALL NOT fail the sync or affect Markdown documents.

#### Scenario: Oversized spec
- **WHEN** a candidate exceeds the size limit
- **THEN** it is skipped with a warning and the rest of the sync proceeds

#### Scenario: Too many specs
- **WHEN** a repository has more than 10 candidates
- **THEN** the first 10 in path order are stored and a warning reports how many were left out

#### Scenario: Hostile structure
- **WHEN** a YAML file uses deeply nested or self-referencing aliases to expand far beyond its size
- **THEN** it is skipped with a warning and the sync does not stall or exhaust memory

### Requirement: Spec sync lifecycle
The system SHALL keep stored specs consistent with the repository like it does documents: a spec SHALL be re-fetched only when its content identifier changed, SHALL be updated when it changes, SHALL be removed when its file is deleted, renamed away or no longer valid, and SHALL be kept unchanged when a sync fails. Specs SHALL follow the repository's visibility: a blocked repository's specs are hidden everywhere and return when the repository is re-allowed.

#### Scenario: Unchanged spec is not re-fetched
- **WHEN** a repository is synced again and a spec's content identifier is the same
- **THEN** its content is not fetched again

#### Scenario: Spec edited upstream
- **WHEN** a spec file changes in the repository
- **THEN** the next sync updates the stored spec and the reference shows the new content

#### Scenario: Spec deleted upstream
- **WHEN** a spec file is removed from the repository
- **THEN** the next sync removes it and its reference page answers not found

#### Scenario: Spec becomes invalid
- **WHEN** a stored spec is edited upstream so that it no longer parses
- **THEN** the stored copy is removed, a warning is recorded, and the sync succeeds

#### Scenario: Failed sync keeps specs
- **WHEN** a sync fails
- **THEN** previously stored specs are still served

#### Scenario: Blocked repository
- **WHEN** an admin blocks a repository that has specs
- **THEN** its API reference pages answer not found, and they return when it is re-allowed without a new sync

### Requirement: API reference entry on the repository page
The system SHALL show an **API reference** section on the repository page only when the repository has at least one stored spec, listing each spec with its title, API version, spec format and version (for example "OpenAPI 3.1"), and a link to its reference page. A repository without specs SHALL show no such section.

#### Scenario: Repository with one spec
- **WHEN** a visitor opens a repository that has a stored spec
- **THEN** the page lists it with title, version and format, linking to the reference

#### Scenario: Repository with several specs
- **WHEN** a repository has several specs
- **THEN** each is listed, ordered by path

#### Scenario: No specs
- **WHEN** a repository has no stored spec
- **THEN** the repository page shows no API reference section

### Requirement: API reference page
The system SHALL serve a reference page for each stored spec at `/<owner>/<repo>/api-reference/<path of the spec file>`, rendered with the open-source Swagger UI widget from the stored spec. The page SHALL show the spec's title and version, servers, security schemes, operations grouped by tag with their parameters, request bodies, responses and examples, and the component schemas, and SHALL link to the spec file on GitHub. Each operation SHALL have a link target so that an address with its anchor opens the page at that operation. The page SHALL work in both themes and at phone width. Where scripts are unavailable it SHALL show a notice and the link to the source file instead of the widget. An unknown, hidden or malformed address SHALL answer 404.

#### Scenario: Reference shown
- **WHEN** a visitor opens the reference of a stored OpenAPI 3.x spec
- **THEN** the widget lists its operations grouped by tag, each expandable to its parameters, request body, responses and examples, and its schemas

#### Scenario: Swagger 2.0
- **WHEN** a visitor opens the reference of a Swagger 2.0 spec
- **THEN** it is displayed with the same information

#### Scenario: Deep link
- **WHEN** a visitor opens the page with an operation's anchor in the address
- **THEN** that operation is opened and scrolled into view

#### Scenario: Link to the source
- **WHEN** a visitor reads a reference page
- **THEN** a link to the spec file on GitHub is available

#### Scenario: Both themes and phone width
- **WHEN** the page is viewed in light or dark theme, or on a phone-width screen
- **THEN** the text is readable, controls have visible focus, and the page does not scroll horizontally

#### Scenario: Scripts unavailable
- **WHEN** scripts do not run
- **THEN** the page shows a notice that the reference needs scripts, with the link to the spec file on GitHub

#### Scenario: Unknown spec
- **WHEN** the address names a path that is not a stored spec of a visible repository
- **THEN** the response is 404

### Requirement: Read-only, offline reference
The reference SHALL be read-only and SHALL NOT make network requests: it SHALL NOT offer "Try it out" or any other way to send a request to the API the spec describes, SHALL NOT fetch external or relative `$ref`s, SHALL NOT load a spec or configuration from the address (query parameters such as `url` or `configUrl` are ignored), and SHALL NOT change the site's Content Security Policy for any other page. Only `$ref`s inside the same spec SHALL be resolved.

#### Scenario: No way to execute requests
- **WHEN** a visitor views any operation
- **THEN** there is no control that sends a request to the described API

#### Scenario: Address parameters ignored
- **WHEN** a visitor opens a reference page with `?url=https://example.com/other.json` or `?configUrl=…` in the address
- **THEN** the stored spec is still the one displayed and no request is made to the given address

#### Scenario: External reference
- **WHEN** a spec contains a `$ref` to a URL or another file
- **THEN** nothing is fetched, and the page shows that the reference could not be resolved without failing as a whole

#### Scenario: Policy unchanged elsewhere
- **WHEN** any page other than an API reference page is served
- **THEN** its Content Security Policy is the same as before this change

### Requirement: Safe presentation of untrusted specs
The system SHALL treat every value in a spec as untrusted. Descriptions that are Markdown SHALL be rendered through a sanitizer so that no script, event handler or unsafe URL scheme reaches the page; links SHALL be limited to `http` and `https`; and a spec SHALL NOT be able to run script, load remote content or change the page outside the widget. The size of what the widget receives SHALL be bounded by the spec size limit.

#### Scenario: Script in a description
- **WHEN** a spec's description contains a script tag, an image with an `onerror` handler or similar
- **THEN** nothing is executed and no handler is emitted

#### Scenario: Unsafe link
- **WHEN** a spec's external documentation link or a Markdown link uses a `javascript:` URL
- **THEN** it is not rendered as a working link

#### Scenario: Remote image in a description
- **WHEN** a description embeds an image from another host
- **THEN** it is subject to the site's image policy and no other remote content is loaded

### Requirement: Spec data stays behind the visibility filter
The system SHALL read stored specs only through the shared query layer and its single visibility filter, like repositories and documents, so that hiding a repository hides its specs everywhere.

#### Scenario: Visibility flipped
- **WHEN** the visibility filter hides a repository
- **THEN** none of its specs are returned by any read
