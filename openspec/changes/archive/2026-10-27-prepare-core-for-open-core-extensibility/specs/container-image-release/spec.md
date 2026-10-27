# Spec Delta

## MODIFIED Requirements

### Requirement: Installer and image versions match
Each installer release SHALL install the image with the same version, unless an image reference is given explicitly. A check SHALL fail the release when any of these differ: the version in the installer, the repository's package version, the version of each published npm package (`@docmyrepos/core`, `@docmyrepos/server`, `@docmyrepos/ui`) and the tag. The image SHALL be built from the open-source app composed from those packages at that version.

#### Scenario: Installer at a release tag
- **WHEN** the installer fetched from tag `v1.2.3` runs with no image override
- **THEN** it pulls the image tagged `1.2.3`

#### Scenario: Version mismatch
- **WHEN** the tag, the installer's version, the package version and the npm package versions are not all equal
- **THEN** the release run fails before publishing

#### Scenario: Image matches the packages
- **WHEN** image `1.2.3` is inspected
- **THEN** its server was built from `@docmyrepos/server` and `@docmyrepos/ui` 1.2.3 sources in the tagged commit
