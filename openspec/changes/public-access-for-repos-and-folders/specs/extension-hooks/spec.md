# Spec Delta

## MODIFIED Requirements

### Requirement: Event catalogue
The core SHALL export the event names it emits as a fixed set:
- Sync: `sync.completed`, `sync.failed`.
- Auth: `auth.login_succeeded`, `auth.login_failed`, `auth.logout`.
- Users and tokens: `user.created`, `user.updated`, `token.created`, `token.revoked`.
- Settings: `settings.updated`, `branding.updated`, `repo.access_changed`, `repo.public_changed`, `folder.public_changed`.
- Comments: `comment.created`, `comment.deleted`.
- Usage: `search.performed`, `ask.answered`, `mcp.tool_called`.

#### Scenario: Every name is emitted
- **WHEN** the contract suite performs each corresponding action once
- **THEN** a recording `onEvent` receives every exported event name at least once, and no name outside the set
