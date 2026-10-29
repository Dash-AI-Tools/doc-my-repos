# container-image-release Specification

## Purpose

Publishes a versioned, verifiable container image of DocMyRepos from release tags, so an installation can pull a released version instead of building from a checkout.

## Requirements

### Requirement: Release tags publish a versioned image
The system SHALL build and publish the production container image to GitHub Container Registry when a version tag (`vMAJOR.MINOR.PATCH`) is pushed, for both `linux/amd64` and `linux/arm64`, tagged with that exact version and never with a mutable name other than `latest` for the newest stable release. It SHALL fail rather than overwrite a version that is already published.

#### Scenario: Tag pushed
- **WHEN** the tag `v1.2.3` is pushed on the main repository
- **THEN** an image tagged `1.2.3` for both architectures is published and `latest` points to it

#### Scenario: Version already exists
- **WHEN** a release run finds the version already published
- **THEN** the run fails and the published image is unchanged

### Requirement: Publishing is restricted and attested
Publishing SHALL run only for the project's own repository (never in a fork), SHALL use the minimum token permissions and no long-lived registry secret, SHALL attach build provenance to the image, and SHALL only follow a build and test run of the same commit.

#### Scenario: Fork
- **WHEN** the workflow runs in a fork
- **THEN** it does not publish anything

#### Scenario: Provenance
- **WHEN** a published image is inspected
- **THEN** it carries provenance naming the repository, commit and workflow that built it

### Requirement: Image carries its origin
The image SHALL carry labels for its source repository, version, revision and license, set at build time from the tag, and SHALL contain no secret and no configuration.

#### Scenario: Inspect labels
- **WHEN** the labels of a released image are read
- **THEN** they give the repository URL, the version, the commit and the license

### Requirement: Installer and image versions match
Each installer release SHALL install the image with the same version, unless an image reference is given explicitly. A check SHALL fail the release when any of these differ: the version in the installer, the repository's package version, the version of each published npm package (`@docmyrepos/core`, `@docmyrepos/server`, `@docmyrepos/ui`), the default image tag in the compose file, a `CHANGELOG.md` section for that version, and the tag. The image SHALL be built from the open-source app composed from those packages at that version.

#### Scenario: Installer at a release tag
- **WHEN** the installer fetched from the GitHub Release asset for tag `v1.2.3` runs with no image override
- **THEN** it pulls the image tagged `1.2.3`

#### Scenario: Version mismatch
- **WHEN** the tag, the installer's version, the package version, the compose default image tag, the CHANGELOG section and the npm package versions are not all equal
- **THEN** the release run fails before publishing

#### Scenario: Image matches the packages
- **WHEN** image `1.2.3` is inspected
- **THEN** its server was built from `@docmyrepos/server` and `@docmyrepos/ui` 1.2.3 sources in the tagged commit

### Requirement: Release tags create a GitHub Release with the installer
When a version tag is pushed, after the image for that version is published, the system SHALL create a GitHub Release for the tag whose body is the matching section of `CHANGELOG.md` and whose assets include `install.sh`, so the documented one-liner download URL (`…/releases/download/vMAJOR.MINOR.PATCH/install.sh`) serves that file.

#### Scenario: Tag pushed
- **WHEN** the tag `v1.2.3` is pushed and the image job has published `1.2.3`
- **THEN** a GitHub Release named for that tag exists, its notes come from the `1.2.3` CHANGELOG section, and `install.sh` is attached as a release asset

#### Scenario: Image not published
- **WHEN** the image job has not succeeded
- **THEN** the GitHub Release is not created
