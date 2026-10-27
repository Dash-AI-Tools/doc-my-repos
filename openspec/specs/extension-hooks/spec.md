# extension-hooks Specification

## Purpose

Defines the typed, versioned hook contract through which an external layer decides tenant, identity, permission, entitlement and event handling. Each hook has a default that reproduces the open-source behavior.

## Requirements

### Requirement: Versioned hook contract
The hook contract SHALL carry an API major version that the core package exports. A breaking change to a hook's signature or meaning, or to the action, feature or event names, SHALL raise that major version and the packages' major version. Adding an optional hook, action, feature or event SHALL NOT be breaking.

#### Scenario: Version is exported
- **WHEN** a host app reads the exported hook API version
- **THEN** it gets the integer major version that this release implements

### Requirement: Tenant resolution hook
`resolveTenant(request)` SHALL return the tenant for an incoming HTTP request, or null when the request matches no tenant. The default SHALL return the single built-in tenant for every request. A null result SHALL be answered 404 with a generic body, before any authentication, database read or plugin code runs.

#### Scenario: Default resolution
- **WHEN** any request reaches the open-source app
- **THEN** it is handled for the built-in tenant

#### Scenario: Unknown tenant
- **WHEN** a host's `resolveTenant` returns null for a request to `/acme/handbook`
- **THEN** the response is 404 with no tenant, repository or configuration detail, and no tenant database is opened

### Requirement: Tenant listing hook
`listTenants()` SHALL return the tenants that background work runs for. The default SHALL return only the built-in tenant.

#### Scenario: Default listing
- **WHEN** the scheduler asks which tenants to run for in the open-source app
- **THEN** it gets exactly the built-in tenant

### Requirement: Authentication hook
`authenticate(request, tenant)` SHALL return the signed-in user for a request, or null. The default SHALL accept exactly what is accepted today: a valid session cookie whose user exists in the tenant's database, is enabled, and whose password version and role match the cookie. On the MCP endpoint only, a valid API token is accepted instead.

#### Scenario: Default session
- **WHEN** a request carries a valid session cookie of an enabled user of the tenant
- **THEN** `authenticate` returns that user with id, email and role

#### Scenario: Disabled user
- **WHEN** the cookie belongs to a user who has been disabled since it was issued
- **THEN** `authenticate` returns null

#### Scenario: Host override
- **WHEN** a host supplies an `authenticate` that recognises its own SSO session
- **THEN** pages and APIs treat the user it returns as signed in, with the role it returns

### Requirement: Authorization hook
`authorize(ctx, action, resource)` SHALL decide every permission check the core makes, for a fixed, exported set of actions: `admin.manage`, `content.read`, `ask.use`, `comment.create`, `comment.create_as_organization`, `comment.edit`, `comment.delete`, `comment.resolve`, `comment.moderate`, `comment.view_author_email`, `token.manage_own` and `token.manage_any`. The default SHALL reproduce today's role and ownership rules exactly.

#### Scenario: Default admin rule
- **WHEN** a user with role `user` requests `/admin/users`
- **THEN** the default `authorize` denies `admin.manage` and the page shows "Access denied" as before

#### Scenario: Default ownership rule
- **WHEN** a user edits a comment they wrote, which is not an organization comment
- **THEN** the default `authorize` allows `comment.edit`, and denies it for another non-admin user

#### Scenario: Host denies an action
- **WHEN** a host's `authorize` denies `comment.create` for a tenant
- **THEN** posting a comment answers 403 as an unauthorized post does today, and nothing is stored

### Requirement: Authorization keeps data invariants
The core SHALL enforce its user-management invariants after `authorize` allows an action, and no hook SHALL be able to bypass them: an admin cannot demote or disable themselves, and the last enabled admin cannot lose the admin role. Repository visibility SHALL stay decided by the shared visibility filter, not by `authorize`.

#### Scenario: Permissive hook and last admin
- **WHEN** a host's `authorize` allows everything and the only admin tries to demote themselves
- **THEN** the request still answers 409 and the role is unchanged

### Requirement: Entitlement hook
`checkEntitlement(ctx, feature)` SHALL decide whether a tenant may use a feature, for an exported set that includes `ask`, `mcp` and `comments`. Plugins MAY check feature names of their own. The default SHALL always allow. A denied feature SHALL behave exactly as if an administrator had turned it off in the workspace settings.

#### Scenario: Default
- **WHEN** an administrator has enabled Ask and no host hook is given
- **THEN** Ask is available as before

#### Scenario: Ask not entitled
- **WHEN** a host's `checkEntitlement` denies `ask`
- **THEN** `/ask` answers 404, the Ask launcher is not shown and `POST /api/ask` answers as when Ask is off, while the stored Ask settings are unchanged

### Requirement: Domain events
After each key domain action succeeds, the core SHALL emit an event to `onEvent`. Events SHALL carry a name, a schema version, the tenant id, a timestamp, the acting user id when there is one, and ids and counts only, never document content, queries, comment text, prompts or secrets.

#### Scenario: Sync event
- **WHEN** a repository sync finishes
- **THEN** one `sync.completed` event is emitted with the tenant id, repository GitHub id, trigger and the counts of added, changed and removed documents

#### Scenario: No content in events
- **WHEN** a user asks a question through Ask
- **THEN** the `ask.answered` event carries token counts and the provider name, but neither the question nor the answer

#### Scenario: Default
- **WHEN** no `onEvent` hook is given
- **THEN** events are discarded and nothing observable changes

### Requirement: Event catalogue
The core SHALL export the event names it emits as a fixed set:
- Sync: `sync.completed`, `sync.failed`.
- Auth: `auth.login_succeeded`, `auth.login_failed`, `auth.logout`.
- Users and tokens: `user.created`, `user.updated`, `token.created`, `token.revoked`.
- Settings: `settings.updated`, `branding.updated`, `repo.access_changed`.
- Comments: `comment.created`, `comment.deleted`.
- Usage: `search.performed`, `ask.answered`, `mcp.tool_called`.

#### Scenario: Every name is emitted
- **WHEN** the contract suite performs each corresponding action once
- **THEN** a recording `onEvent` receives every exported event name at least once, and no name outside the set

### Requirement: Events never affect the action
Event delivery SHALL happen after the action's result is decided, and SHALL NOT delay, change or fail the response or the job. An `onEvent` that throws or rejects SHALL be logged by event name only and otherwise ignored.

#### Scenario: Failing event hook
- **WHEN** `onEvent` throws for `comment.created`
- **THEN** the comment is stored, the response is the usual 201, and one `hook.failed` warning is logged without the event payload

### Requirement: Hooks fail closed
When `resolveTenant`, `authenticate`, `authorize` or `checkEntitlement` throws or rejects, the core SHALL treat the result as deny. For `resolveTenant` that is no tenant, for `authenticate` no user, and for the other two denied. It SHALL log a `hook.failed` event naming the hook, without request data or secrets.

#### Scenario: Authorize throws
- **WHEN** a host's `authorize` throws while an admin opens `/admin/workspace`
- **THEN** the page shows "Access denied" and a `hook.failed` warning names `authorize`
