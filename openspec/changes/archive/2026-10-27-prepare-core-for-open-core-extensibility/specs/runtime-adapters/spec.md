# Spec Delta

## Purpose

Puts the database, background jobs, secrets, blob storage and email behind small adapter contracts. A host can then supply its own infrastructure, while the open-source defaults keep today's behavior.

## ADDED Requirements

### Requirement: Database adapter
The database adapter SHALL provide the Postgres database for a tenant. Every read and write of a request or job SHALL use the database the adapter returns for that request's or job's tenant. The default SHALL return the one database from `DATABASE_URL` for the built-in tenant and refuse any other tenant. Postgres remains required: the adapter selects a database, it does not replace Postgres.

#### Scenario: Default database
- **WHEN** the open-source app serves a page
- **THEN** it reads the database at `DATABASE_URL`, through one shared connection pool per process, as before

#### Scenario: Database per tenant
- **WHEN** a host adapter returns database A for tenant `a` and database B for tenant `b`
- **THEN** requests resolved to `a` read and write only database A, and requests resolved to `b` only database B

#### Scenario: Unknown tenant in default adapter
- **WHEN** the default adapter is asked for a tenant other than the built-in one
- **THEN** it throws a configuration error that names no connection detail

### Requirement: Migrations per database
The core SHALL expose a public migration routine that applies the core migrations, then each plugin's migrations, to one given database. It SHALL be serialized per database and idempotent. The existing migration command and the container start-up migration SHALL keep working unchanged against `DATABASE_URL`.

#### Scenario: Existing command
- **WHEN** an operator runs `pnpm db:migrate` or the container starts without `SKIP_MIGRATIONS=1`
- **THEN** the same migrations are applied to `DATABASE_URL` as before, with the same lock, wait and messages

#### Scenario: Host migrates a tenant
- **WHEN** a host calls the migration routine for a new tenant database
- **THEN** core and plugin migrations are applied to that database only, and a second call applies nothing

### Requirement: Jobs adapter
Background work SHALL be submitted to a jobs adapter as named jobs with a JSON payload that includes the tenant id. The default adapter SHALL run each job in-process at once, as today. The core SHALL expose a public way to execute a submitted job by name, so a host's own queue workers can run core and plugin jobs.

#### Scenario: Default in-process jobs
- **WHEN** a push webhook arrives in the open-source app
- **THEN** the sync runs in the same process, and the webhook is answered within the same 5-second window as before

#### Scenario: Host queue
- **WHEN** a host adapter stores submitted jobs in its own queue, and its worker calls the core job runner with one of them
- **THEN** the job runs for the tenant named in its payload, with that tenant's database and workspace

#### Scenario: Unknown job
- **WHEN** the job runner is called with a name no core module or plugin registered
- **THEN** it rejects with an error naming the job, and nothing runs

### Requirement: Jobs keep sync guarantees
Whatever jobs adapter is used, syncs SHALL stay serialized per repository, coalesced and idempotent. Running the same sync job twice, or two jobs for one repository at once, SHALL produce the same stored state as one run.

#### Scenario: Duplicate delivery
- **WHEN** a host queue delivers the same repository sync job twice at the same time
- **THEN** one sync runs, the other coalesces, and the stored documents are those of one sync

### Requirement: Secrets adapter
The secrets adapter SHALL provide the key that encrypts and decrypts a tenant's stored workspace secrets. The default SHALL derive it from `SETTINGS_ENCRYPTION_KEY` for every tenant, exactly as today. The stored ciphertext format SHALL be unchanged. Keys and secrets SHALL never reach responses or logs, whichever adapter is used.

#### Scenario: Existing secrets stay readable
- **WHEN** a release with this change starts against a database whose secrets were stored by the previous release, with the same `SETTINGS_ENCRYPTION_KEY`
- **THEN** every stored secret decrypts, and nothing has to be entered again

#### Scenario: Missing key
- **WHEN** the adapter has no usable key for a tenant
- **THEN** the workspace reports the same encryption-key problem as today, and secrets read as not set

### Requirement: Startup secrets stay in the environment
`SESSION_SECRET`, `SYNC_SECRET` and `DATABASE_URL` SHALL be read only from the startup configuration, never from the secrets adapter or the database.

#### Scenario: Sync secret source
- **WHEN** `POST /api/sync` is called
- **THEN** the bearer token is checked against `SYNC_SECRET` from the startup configuration, as before

### Requirement: Blob storage adapter
Stored binary files SHALL be read and written through a blob storage adapter, keyed by tenant and name. Today the only stored file is the branding logo. The default SHALL keep the logo in the database where it is stored now, so existing logos keep showing without migration.

#### Scenario: Existing logo
- **WHEN** a release with this change serves `/api/branding/logo` for a workspace that uploaded a logo before
- **THEN** the same bytes and content type are served

#### Scenario: Host blob store
- **WHEN** a host blob adapter is given and an admin uploads a logo
- **THEN** the bytes are written through that adapter for the request's tenant, with the same size and type validation as today

### Requirement: Email adapter
The core SHALL define an email adapter that plugins use to send mail, with a recipient, subject, text body and optional HTML body. The open-source core sends no email. The default adapter SHALL reject every message with a "not configured" error, never silently drop it.

#### Scenario: Default email
- **WHEN** a plugin sends a message through the default email adapter
- **THEN** the call rejects with a "not configured" error, and nothing is sent

#### Scenario: Host email
- **WHEN** a host supplies an email adapter and a plugin sends a message
- **THEN** the message reaches that adapter with the tenant it was sent for
