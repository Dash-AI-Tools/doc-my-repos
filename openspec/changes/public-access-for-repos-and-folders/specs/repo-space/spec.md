# Spec Delta

## MODIFIED Requirements

### Requirement: Private repository indication and visibility-aware queries
The system SHALL show a "private" badge on cards and headers of private repositories, and SHALL route every read of repositories and documents (browsing, search, facets, assets) through a single visibility check so that restricting what a viewer may see later requires no change to those features. Signed-in users SHALL see every allowed repository; an anonymous visitor SHALL see only the allowed repositories that are public (see `public-access`).

#### Scenario: Private badge
- **WHEN** a repository that is private on GitHub is listed or opened
- **THEN** a visible "private" badge is shown, to signed-in users and to anonymous visitors alike

#### Scenario: Public and private both visible in MVP
- **WHEN** a signed-in user opens the home page
- **THEN** both public and private synced repositories are listed

#### Scenario: Anonymous reader sees the public set only
- **WHEN** an anonymous visitor opens the home page while one repository is public
- **THEN** only that repository is listed, and the same holds for repository pages, document pages, search results, facet counts and asset URLs

#### Scenario: Single enforcement point
- **WHEN** the visibility rule is changed to hide private repositories
- **THEN** private repositories disappear from the home page, repository pages, document pages, search results, facet counts, and asset URLs together
