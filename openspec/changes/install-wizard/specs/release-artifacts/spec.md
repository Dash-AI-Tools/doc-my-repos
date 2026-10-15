## Purpose

Publishes the container image and the installer package from CI, in versions that belong together, so the installer can install DocMyRepos without a checkout and users can verify what they run.

## ADDED Requirements

### Requirement: Published container image
The system SHALL publish the application image to the GitHub Container Registry for linux/amd64 and linux/arm64 on every version tag, tagged with the exact version, and SHALL NOT move an existing version tag. A `latest` tag MAY follow the newest stable version. The image SHALL carry source, version and license labels, and SHALL hold no secrets or configuration.

#### Scenario: Tag published
- **WHEN** the tag `v1.2.0` is pushed
- **THEN** the image `1.2.0` becomes available for both architectures

#### Scenario: No overwrite
- **WHEN** a version tag that already has an image is pushed again
- **THEN** the release fails instead of replacing the image

#### Scenario: Labels
- **WHEN** the published image is inspected
- **THEN** its labels name the source repository, version and license

### Requirement: Published installer package
The system SHALL publish the installer to npm as `create-docmyrepos` on every version tag from CI, with provenance, with exactly the same version number as the image. The package SHALL contain only its built files, README and license, SHALL have no runtime dependencies, and SHALL declare the Node version it needs.

#### Scenario: Matching versions
- **WHEN** version 1.2.0 is released
- **THEN** `create-docmyrepos@1.2.0` exists on npm and installs image `1.2.0`

#### Scenario: Minimal contents
- **WHEN** the package contents are listed
- **THEN** they are the built files, README and license only, with no source maps, tests, environment files or keys

#### Scenario: No dependencies
- **WHEN** the package manifest is read
- **THEN** it declares no runtime dependencies

### Requirement: Release is safe and traceable
The system SHALL run releases only from version tags on the main repository, SHALL authenticate to the registries with short-lived workflow credentials and the minimum permissions rather than long-lived secrets where the registry allows it, SHALL run the full test suite and the installer's end-to-end test against the built image before publishing anything, and SHALL attach build provenance to both artifacts.

#### Scenario: Failing tests block release
- **WHEN** any required check fails for a tag
- **THEN** neither the image nor the package is published

#### Scenario: Fork cannot publish
- **WHEN** the workflow runs in a fork or on a pull request
- **THEN** nothing is published

#### Scenario: Provenance
- **WHEN** a published artifact is verified
- **THEN** its provenance names the repository, workflow and commit that built it

### Requirement: The installer installs its own version
The system SHALL make the installer pin the image version equal to its own version in the compose file it writes, SHALL offer an explicit `--image-tag` override for testing, and SHALL refuse a malformed tag.

#### Scenario: Pinned
- **WHEN** installer 1.2.0 writes a compose file
- **THEN** the app service uses image tag `1.2.0`

#### Scenario: Override
- **WHEN** the user passes `--image-tag next`
- **THEN** that tag is used and the wizard says it is not the matching version

### Requirement: Installer is tested end to end
The system SHALL test in CI, against the freshly built image and a fake GitHub server, that the installer's output starts, becomes healthy, accepts the bootstrap administrator and answers the first sync request, and SHALL test the package contents with a dry pack.

#### Scenario: Install test
- **WHEN** CI runs the installer non-interactively with a fake GitHub
- **THEN** the app becomes healthy and the admin can sign in

#### Scenario: Pack test
- **WHEN** CI runs the pack check
- **THEN** it fails if a file outside the allowed list would be published
