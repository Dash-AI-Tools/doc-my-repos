# core-packages Specification

## Purpose

Defines how the DocMyRepos core is distributed to external consumers: the published packages and their public surface, versioning and changelog, and the contract suite that proves the core can be extended through that surface alone.

## Requirements

### Requirement: Published packages
The core SHALL be published as three npm packages:
- `@docmyrepos/core`: contracts, hook, adapter, plugin and event types, version constants, and shared pure code.
- `@docmyrepos/server`: the application factory, services, default adapters, route handlers, the migration routine and the Edge-safe proxy.
- `@docmyrepos/ui`: page and component bindings, slot rendering and styles.

Each published package SHALL contain compiled JavaScript and type declarations.

#### Scenario: Install in a fresh project
- **WHEN** a project installs the three packages at one version
- **THEN** it can import their public entrypoints in Node.js 24 with TypeScript strict mode and no access to this repository

### Requirement: Explicit public surface
Each package's public API SHALL be exactly the entrypoints listed in its `exports` map, other than internal ones. Any entrypoint under an `internal` path SHALL be marked internal and excluded from semver guarantees. Consumers SHALL be unable to import any other file of the package.

#### Scenario: Deep import refused
- **WHEN** a consumer imports `@docmyrepos/server/src/workspace`
- **THEN** module resolution fails because the path is not exported

### Requirement: Public surface changes are deliberate
A checked-in report SHALL list every public export of every package. CI SHALL fail when the built packages' public exports differ from it, until the report is updated in the same change.

#### Scenario: Accidental export
- **WHEN** a pull request adds an export to a public entrypoint without updating the report
- **THEN** CI fails and names the added export

### Requirement: Edge-safe proxy entrypoint
The proxy entrypoint SHALL import no Node.js-only module, no database code and no React. It SHALL accept extra public path prefixes from the host app.

#### Scenario: Host public page
- **WHEN** a host builds its proxy with the extra public path `/pricing`
- **THEN** `/pricing` passes the session gate, and every other path is gated as in the open-source app

### Requirement: Lockstep semantic versioning with a changelog
All published packages, the open-source app, the installer and the container image SHALL share one version that follows semantic versioning. Every change to published code SHALL carry a changelog entry declaring its bump. The release SHALL write a changelog that names breaking changes and the hook API version.

#### Scenario: Missing changelog entry
- **WHEN** a pull request changes package source without a changelog entry
- **THEN** CI fails and says how to add one

#### Scenario: Breaking change
- **WHEN** a change alters a hook signature
- **THEN** its changelog entry is a major bump, and the release raises the major version of every package and the hook API version

### Requirement: Packages are published from release tags
A version tag SHALL publish every package at that version, after the same CI run that gates the image. Publishing SHALL attach npm provenance, use no long-lived registry token, run only in the project's repository, and never overwrite a published version.

#### Scenario: Tag pushed
- **WHEN** the tag `v1.2.3` is pushed on the main repository
- **THEN** `@docmyrepos/core`, `@docmyrepos/server` and `@docmyrepos/ui` 1.2.3 are published with provenance, alongside image 1.2.3

#### Scenario: Version exists
- **WHEN** a package version is already published
- **THEN** the run fails before publishing anything

### Requirement: Extension contract suite
A contract test suite SHALL boot the application through `createApp`, importing only public package entrypoints. It runs with stub hooks, stub adapters, two tenant databases and a sample plugin. It SHALL prove:
- tenant resolution and isolation;
- authentication, authorization and entitlement overrides;
- event delivery;
- the jobs, secrets, blob and email adapters;
- plugin routes, pages, jobs, migrations and slots.

#### Scenario: Suite passes on the public surface
- **WHEN** the contract suite runs
- **THEN** it passes, and a static check confirms none of its files imports a non-public path of any package

#### Scenario: Contract regression
- **WHEN** a core change makes a hook's override stop taking effect
- **THEN** a contract test fails
