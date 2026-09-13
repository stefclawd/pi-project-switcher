# project-switching Specification (Delta)

## MODIFIED Requirements

### Requirement: Switching Projects

`/project <name>` SHALL switch to the named project when it exists. Switching consists of:
1. Storing the active project (persisted across reloads via session entry)
2. Setting the session display name to the project name
3. Announcing the switch to the agent (context message)

When the named project does not exist under the base directory, the command SHALL offer to create the project folder and switch to it, subject to the confirmation and safety rules below.

#### Scenario: Successful switch

- **WHEN** the user runs `/project foo` and `~/dev/foo` exists
- **THEN** the session name is set to include "foo" and the agent is told the new working context

#### Scenario: Unknown project, user confirms creation

- **WHEN** the user runs `/project foo` and `~/dev/foo` does not exist
- **AND** the surface is dialog-capable and the user confirms the offered creation (or the command was invoked as `/project foo!`)
- **THEN** the folder `~/dev/foo` is created (empty directory)
- **AND** the switch proceeds exactly like a first-session switch to that project

#### Scenario: Unknown project, user declines creation

- **WHEN** the user runs `/project foo` and `~/dev/foo` does not exist
- **AND** the user declines the offered creation (or dismissal/cancellation is treated as decline)
- **THEN** a warning is shown, no folder is created, and the active project remains unchanged

#### Scenario: Unknown project

- **WHEN** the user runs `/project doesnotexist` on a non-dialog surface without the `!` opt-in
- **THEN** an error is shown and the active project remains unchanged

#### Scenario: Unknown project on non-dialog surface without opt-in

- **WHEN** `/project foo` targets a non-existent project on a surface without dialog capability
- **AND** the command was NOT invoked with the explicit opt-in suffix `!`
- **THEN** the behavior matches the previous warning (`Unknown project: "foo"`) and nothing is created

#### Scenario: Unsafe project name

- **WHEN** the requested name contains path separators (`/`, `\`), `..`, is absolute, or starts with a dot
- **THEN** the creation offer is not given and the existing unknown-project warning applies

#### Scenario: Folder creation fails

- **WHEN** the user confirms creation but the directory cannot be created (permissions, name occupied by a file, race condition)
- **THEN** an error is shown and the active project remains unchanged
