# Spec Delta

## ADDED Requirements

### Requirement: Public access settings
The system SHALL let admins configure public access on the Repository access tab of the workspace settings page: a switch for anonymous search (on by default), a switch for anonymous Ask (off by default), and the shared anonymous Ask caps per day (default 200, from 1 to 10000) and per ten minutes (default 20, from 1 to 1000). Values SHALL be validated when saved, audited by field name without values, stored in the database and applied to the next request without a restart.

#### Scenario: Defaults
- **WHEN** an admin opens the section on a workspace that never set it
- **THEN** public search is on, public Ask is off, and the caps show 200 and 20

#### Scenario: Invalid cap
- **WHEN** an admin saves a daily cap of 0 or a ten-minute cap of 2000
- **THEN** the request is rejected with 400 naming the field, and nothing is saved

#### Scenario: Applies without a restart
- **WHEN** an admin turns public search off
- **THEN** the next anonymous search request is refused, with no restart

#### Scenario: Only admins
- **WHEN** a non-admin tries to read or change the public access settings
- **THEN** the request answers 403 and nothing changes

#### Scenario: Nothing public yet
- **WHEN** no repository or folder is public
- **THEN** the section says that the switches take effect once something is public
