# Spec Delta

## ADDED Requirements

### Requirement: Public folders
The system SHALL let an admin mark a folder as public from the Folders tab, with a switch named after the folder. A public folder makes every allowed repository in it public to anonymous visitors, including repositories added later. The mark SHALL be kept when a folder is renamed or reordered, SHALL survive sync, and SHALL be removed with the folder when it is deleted.

#### Scenario: Mark a folder public
- **WHEN** an admin turns Public on for the folder "Open source"
- **THEN** the Folders tab shows it as public, and its repositories are readable without signing in

#### Scenario: Repository added later
- **WHEN** an admin moves another repository into a public folder
- **THEN** that repository is public from the next request

#### Scenario: Delete a public folder
- **WHEN** an admin deletes a public folder
- **THEN** its repositories are no longer public through it, and each stays public only if it is marked public itself

### Requirement: Folders in the anonymous home page
The system SHALL show an anonymous visitor a folder section only for a public folder, with all of that folder's allowed repositories. A repository that is public on its own but sits in a folder that is not public SHALL appear in the repositories section without the folder's name or description, so a non-public folder is never revealed.

#### Scenario: Public folder section
- **WHEN** an anonymous visitor opens the home page and the folder "Open source" is public
- **THEN** a section named "Open source" lists its repositories, in the order and with the starring the admin chose

#### Scenario: Public repository in a private folder
- **WHEN** a repository marked public sits in the non-public folder "Internal"
- **THEN** an anonymous visitor sees the repository among the other repositories, and the name "Internal" appears nowhere on the page or in its data

#### Scenario: Signed-in users unchanged
- **WHEN** a signed-in user opens the home page
- **THEN** folders appear as before, public or not
