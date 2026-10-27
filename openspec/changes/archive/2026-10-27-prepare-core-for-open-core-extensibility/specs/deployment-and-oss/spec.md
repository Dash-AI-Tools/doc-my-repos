# Spec Delta

## MODIFIED Requirements

### Requirement: Continuous integration
The repository SHALL run on every pull request:
- lint, type checking, unit tests, end-to-end tests and a production build;
- the extension contract suite;
- the public API surface check;
- the changelog entry check.

#### Scenario: Failing check blocks merge
- **WHEN** a type error is introduced in a pull request
- **THEN** the CI run fails and reports the error

#### Scenario: Contract failure blocks merge
- **WHEN** a pull request breaks a plugin slot contribution or a hook override
- **THEN** the contract suite fails and the CI run reports it
