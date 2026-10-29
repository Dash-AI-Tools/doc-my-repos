# Spec Delta

## Purpose

Lets an admin publish chosen repositories and repository folders to visitors who are not signed in, with optional anonymous search and Ask, while everything else stays behind the login. It defines what is public, what an anonymous visitor may reach, and the rule that nothing outside the public set is ever shown.

## ADDED Requirements

### Requirement: Public repositories and folders
The system SHALL let an admin mark a repository as public and a repository folder as public. A repository SHALL be public for anonymous visitors when it is allowed (not blocked) and either it or its folder is marked public. Nothing SHALL be public by default, and marking never changes what signed-in users can see.

#### Scenario: Nothing public by default
- **WHEN** a workspace has never marked anything public
- **THEN** every page and API behaves exactly as before, and a visitor without a session is sent to sign in

#### Scenario: Public repository
- **WHEN** an admin marks `acme/handbook` as public
- **THEN** an anonymous visitor can read `acme/handbook` and no other repository

#### Scenario: Public folder
- **WHEN** an admin marks the folder "Open source" as public
- **THEN** every repository in that folder is public, including ones added to it later, and a repository moved out of it stops being public unless it is marked itself

#### Scenario: Blocked repository
- **WHEN** a repository marked public is blocked by an admin
- **THEN** it is hidden from everyone, anonymous visitors included, and is public again when allowed again

### Requirement: Admin controls for public access
The system SHALL give admins a Public switch on each row of the Repository access list and on each folder, saved like the other admin actions, audited without values, effective on the next request, and refused with 403 for a non-admin with nothing changed. Making public a repository that is private on GitHub, or a folder that holds one, SHALL need an explicit confirmation that names how many such repositories are affected; without it the request SHALL be refused with 409.

#### Scenario: Switch a repository
- **WHEN** an admin turns Public on for a repository and reloads the page as an anonymous visitor
- **THEN** the repository is readable without signing in

#### Scenario: Non-admin
- **WHEN** a signed-in non-admin tries to change a Public switch
- **THEN** the request answers 403 and nothing changes

#### Scenario: GitHub-private repository needs confirmation
- **WHEN** an admin turns Public on for a repository that is private on GitHub
- **THEN** the page asks them to confirm that its documents will be readable by anyone, and without the confirmation the repository stays non-public

#### Scenario: Folder holding a private repository
- **WHEN** an admin turns Public on for a folder that holds two GitHub-private repositories
- **THEN** the confirmation says two private repositories will become public

#### Scenario: Labelled for keyboard and screen readers
- **WHEN** a keyboard or screen-reader user reaches a Public switch
- **THEN** it is named after its repository or folder and reports whether it is on

### Requirement: What an anonymous visitor can read
The system SHALL let a visitor without a valid session read, for public repositories only: the home page, repository pages, document pages, the API reference page and the images those documents use. Every other page SHALL redirect to `/login` and every other API SHALL answer 401, exactly as for a signed-out visitor today.

#### Scenario: Public document
- **WHEN** an anonymous visitor opens a document of a public repository
- **THEN** the page renders with its outline, navigation and rendered images, and the header offers Sign in

#### Scenario: Non-public repository
- **WHEN** an anonymous visitor opens a repository or document that is not public
- **THEN** they are redirected to `/login`

#### Scenario: Indistinguishable from missing
- **WHEN** an anonymous visitor opens a path of a non-public repository and a path of a repository that does not exist
- **THEN** both answer the same redirect to `/login`, so nothing reveals which repositories exist

#### Scenario: Signed-in only pages
- **WHEN** an anonymous visitor opens `/status`, `/admin/users`, the starred or token pages
- **THEN** they are redirected to `/login`

#### Scenario: Signed-in only APIs
- **WHEN** an anonymous client calls the comments, status, admin, token, sync-trigger or MCP APIs
- **THEN** each answers as it does today (401, or its own token or secret check), regardless of what is public

### Requirement: Anonymous visitors see no signed-in features
The system SHALL show anonymous visitors none of the signed-in-only features: no comments section or comment counts, no starring controls, no account menu, no admin or status links, and no Ask or search entry point unless the admin allowed it. Repository and document content SHALL be identical to what a signed-in user sees for the same repository.

#### Scenario: No comments for anonymous visitors
- **WHEN** an anonymous visitor opens a public document
- **THEN** the page has no comments section, no comment count and no author names or emails from comments

#### Scenario: Same content
- **WHEN** an anonymous visitor and a signed-in user open the same public document
- **THEN** the rendered document body, outline and navigation are the same

### Requirement: Home page with public content
The system SHALL show the home page to an anonymous visitor, listing only the public repositories and the folders that hold them, when at least one repository is public. When nothing is public, `/` SHALL redirect an anonymous visitor to `/login` as before. A signed-in user SHALL see every allowed repository as before.

#### Scenario: Public home
- **WHEN** an anonymous visitor opens `/` and one folder and one other repository are public
- **THEN** the home page lists that folder and that repository, with the search bar only if public search is on, and no other repository appears

#### Scenario: Nothing public
- **WHEN** an anonymous visitor opens `/` and nothing is public
- **THEN** they are redirected to `/login`

#### Scenario: Signed-in user unchanged
- **WHEN** a signed-in user opens `/` while some repositories are public
- **THEN** they see every allowed repository, public or not

### Requirement: Sign in from public pages
The system SHALL show a Sign in button in the site header of every page an anonymous visitor can read, linking to `/login`, in the place the account menu takes for a signed-in user. After a successful sign-in the user SHALL land on the home page as today.

#### Scenario: Button in the header
- **WHEN** an anonymous visitor views a public page
- **THEN** the header shows a Sign in link to `/login` and no account menu

#### Scenario: Signed in
- **WHEN** a signed-in user views the same page
- **THEN** the header shows the account menu and no Sign in link

#### Scenario: Keyboard and small screens
- **WHEN** a keyboard user or a phone-width visitor reaches the header
- **THEN** the Sign in link is reachable, named, and large enough to tap

### Requirement: Public search setting
The system SHALL let an admin choose whether anonymous visitors may search, on by default once something is public. When on, the search bar, the palette, the search page and the search API SHALL work for anonymous visitors over public repositories only, with results, facet counts and filters limited to them. When off, none of these SHALL be offered, `/search` SHALL redirect to `/login` and the search API SHALL answer 401.

#### Scenario: Public search on
- **WHEN** public search is on and an anonymous visitor searches for a term that appears in a public and a non-public repository
- **THEN** only the public repository's documents are returned, and facet counts count only them

#### Scenario: Public search off
- **WHEN** public search is off and an anonymous visitor opens `/search?q=deploy`
- **THEN** they are redirected to `/login`, and no search bar or palette is shown to them

#### Scenario: Signed-in search unchanged
- **WHEN** a signed-in user searches
- **THEN** results cover every allowed repository whatever the public settings

### Requirement: Public Ask setting
The system SHALL let an admin choose whether anonymous visitors may use Ask, off by default. When on, and Ask itself is enabled with a configured provider, anonymous visitors SHALL be able to ask questions answered only from public repositories, with the same grounding, references, safety and streaming rules as for signed-in users. When off, Ask SHALL not be offered to them, `/ask` SHALL redirect to `/login` and the Ask API SHALL answer 401.

#### Scenario: Anonymous question
- **WHEN** public Ask is on and an anonymous visitor asks about a topic documented only in a non-public repository
- **THEN** the answer says the documentation does not cover it, and no excerpt or reference from that repository reaches the model or the page

#### Scenario: Ask itself off
- **WHEN** Ask is off or has no provider
- **THEN** public Ask offers nothing, whatever its own setting says

#### Scenario: Public Ask off
- **WHEN** public Ask is off and an anonymous visitor opens `/ask`
- **THEN** they are redirected to `/login`

#### Scenario: Same-origin required
- **WHEN** an anonymous client posts a question from another origin
- **THEN** the request is refused as for a signed-in user, and nothing is sent to the model

### Requirement: Anonymous Ask has shared limits
The system SHALL limit anonymous Ask with admin-set shared caps: a number of questions per day and per ten minutes counted across all anonymous visitors together, and the existing cap on simultaneous answers. A question over a cap SHALL be refused with 429, a `Retry-After` header and a short fixed message. The system SHALL NOT store the question, the answer, or any address or identifier of the visitor, and SHALL count anonymous questions only as totals.

#### Scenario: Cap reached
- **WHEN** the shared ten-minute cap is used up and another anonymous visitor asks
- **THEN** they get 429 with when to retry, signed-in users' own limits are unaffected, and no model call is made

#### Scenario: Nothing identifying is kept
- **WHEN** an anonymous question is answered
- **THEN** the database and the logs hold no question text, no answer text and no visitor address, only a count and an outcome

#### Scenario: Defaults
- **WHEN** an admin turns public Ask on without changing the caps
- **THEN** the caps have documented, conservative default values

### Requirement: No shared caching across viewers
The system SHALL answer pages and APIs that can differ between an anonymous visitor and a signed-in user with headers that forbid storing them in a shared cache, so a response rendered for one viewer is never served to another.

#### Scenario: Cache headers
- **WHEN** a public page is requested with and without a session
- **THEN** both responses forbid shared caching, and the signed-in response never reaches an anonymous visitor through a proxy

### Requirement: Nothing outside the public set is reachable
The system SHALL decide anonymous reads through the same single visibility check as every other read, so that no page, API, search result, facet count, image or Ask excerpt shows a repository that is not public to an anonymous visitor. Anonymous requests SHALL reach GitHub only through the image proxy, for an image of a public repository, with the same checks, limits and caching as today; every page reads Postgres only. The existing rules for sanitized rendering, strict diagrams and image path checks SHALL apply unchanged.

#### Scenario: Leak matrix
- **WHEN** an anonymous visitor requests every page, read API and image URL of a workspace with one public and one non-public repository
- **THEN** each answer shows only the public repository's data, or redirects or answers 401, and none contains the non-public repository's name, documents, counts or images

#### Scenario: Image of a non-public repository
- **WHEN** an anonymous visitor requests an image path of a non-public repository
- **THEN** the answer is the same as for a repository that does not exist, and nothing is fetched from GitHub

#### Scenario: Revoked
- **WHEN** an admin turns Public off for a repository
- **THEN** the next anonymous request for it redirects to `/login`, including requests for its documents and images

#### Scenario: Pages never call GitHub
- **WHEN** an anonymous visitor opens the home page, a repository, a document or the API reference of a public repository
- **THEN** the page is built from stored data with no request to GitHub, and only an image request goes to the image proxy
