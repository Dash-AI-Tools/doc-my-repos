# Spec Delta

## Purpose

Defines the single composition root of DocMyRepos: one factory builds the application from configuration, hooks, adapters and plugins. Both the open-source app and an external host app are thin callers of that factory.

## ADDED Requirements

### Requirement: Application factory
The system SHALL provide a public `createApp` factory that takes optional configuration, hooks, adapters and plugins. It SHALL return an application whose route handlers, page bindings, start-up routine and job runner are the only way the routes, instrumentation and background work reach core behavior. A hook or adapter left out SHALL use its default.

#### Scenario: Defaults only
- **WHEN** `createApp()` is called with no arguments
- **THEN** the returned application uses the default hooks and adapters and no plugins, and behaves like the current release

#### Scenario: Partial override
- **WHEN** `createApp` is called with only an `onEvent` hook
- **THEN** every other hook and every adapter is the default, and `onEvent` is the given one

### Requirement: Open-source app is a thin caller
The open-source app SHALL build its application with `createApp` and the defaults in one module. Its route files, instrumentation and proxy SHALL only bind or re-export what the packages provide, and SHALL hold no product logic.

#### Scenario: Route file content
- **WHEN** any route, page or layout file of the open-source app is read
- **THEN** it imports the application module and a package export and binds them, with no queries, permission checks or rendering logic of its own

#### Scenario: Same routes as before
- **WHEN** the open-source app is built
- **THEN** it serves exactly the same URL paths, methods and status codes as the previous release

### Requirement: Configuration comes from the same environment variables
Without an explicit `config`, the factory SHALL read the startup configuration from the same environment variables as before (`DATABASE_URL`, `SESSION_SECRET`, `SYNC_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `LOG_LEVEL`, `SYNC_SCHEDULER`), with the same validation and messages. Workspace settings SHALL stay in the database.

#### Scenario: Invalid environment
- **WHEN** the app starts with `SESSION_SECRET` still set to the `.env.example` placeholder
- **THEN** it logs the same `config.env_invalid` problem as before, keeps serving, and `/api/health` answers 503

#### Scenario: Explicit config
- **WHEN** a host app passes a `config` object to `createApp`
- **THEN** that object is validated with the same rules, and the environment is not read for those values

### Requirement: Start-up is owned by the application
The application SHALL expose a start routine for the instrumentation hook. It SHALL run the environment checks, report retired settings and start background work with the same gating as before (`SYNC_SCHEDULER`, `NODE_ENV`). It SHALL never throw, and starting twice in one process SHALL start background work once.

#### Scenario: Production start
- **WHEN** the start routine runs with `NODE_ENV=production` and `SYNC_SCHEDULER` unset
- **THEN** the background scheduler starts once, as in the current release

#### Scenario: Double start
- **WHEN** the start routine is called twice in the same process
- **THEN** only one scheduler runs

### Requirement: Composition is validated at creation
`createApp` SHALL reject an invalid composition before serving anything, with an error that names the problem and contains no secret. Invalid compositions are: a duplicate plugin id, a plugin id that is not a lowercase slug, a plugin for an unsupported API major version, two plugins registering the same job name, and a hook that is not a function.

#### Scenario: Duplicate plugin id
- **WHEN** two plugins with the id `metering` are passed
- **THEN** `createApp` throws an error naming the duplicate id

#### Scenario: Unsupported plugin API version
- **WHEN** a plugin declares API major version 2 and the core supports only 1
- **THEN** `createApp` throws an error naming the plugin and both versions

### Requirement: Host apps compose without patching core
A host app SHALL be able to build a complete, working deployment from the published packages alone: the application module, route files, proxy, instrumentation and Next.js configuration helper. It SHALL never import a non-public path or modify package files.

#### Scenario: Host build with public imports only
- **WHEN** the sample host app in the contract suite is type-checked
- **THEN** it compiles with imports from public package entrypoints only
