# Spec Delta

## MODIFIED Requirements

### Requirement: Starred repositories lead the home page
The system SHALL show starred, visible repositories in a **Starred** section above any folder sections and the **Repositories** section on the All view of the home page, in the admin-set order. A repository SHALL appear in exactly one section; a starred repository that is in a folder SHALL appear in Starred only. The Repositories section SHALL keep the existing order (owner, then name, case-insensitive). When no visible repository is starred, the home page SHALL NOT show an empty Starred section.

#### Scenario: Starred repository moves to the top
- **WHEN** a visitor opens the home page and a repository is starred
- **THEN** it appears in the Starred section above the other sections, and not in the Repositories section

#### Scenario: Admin order is shown
- **WHEN** several repositories are starred and an admin has ordered them
- **THEN** the Starred section lists them in that order, whatever their names, and the Repositories section lists the rest by owner then name

#### Scenario: Nothing starred
- **WHEN** no visible repository is starred
- **THEN** the home page shows no Starred section and otherwise lists folders and the Repositories section as usual

#### Scenario: Every viewer sees the same stars and order
- **WHEN** an admin stars or reorders repositories
- **THEN** every viewer, admin or not, sees the new Starred section on their next page load

#### Scenario: Starred repository keeps its card
- **WHEN** a starred repository is listed
- **THEN** its card shows the same information and link as any other repository card, including private and error states

#### Scenario: Starred repository in a folder
- **WHEN** a starred repository is in a folder
- **THEN** it appears in the Starred section only, keeps its folder, and returns to that folder's section when unstarred
