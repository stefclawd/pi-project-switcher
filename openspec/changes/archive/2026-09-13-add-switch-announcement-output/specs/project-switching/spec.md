# project-switching Specification (Delta)

## ADDED Requirements

### Requirement: Switch Output Includes Working Directory and Session Identity

After a successful `/project <name>` switch, the extension SHALL print a
notification that includes (a) the absolute path of the new active project
working directory and (b) the session identity the user now operates in.

#### Scenario: Switch with restored session

- **WHEN** the user runs `/project foo` and foo has a stored, existing session file
- **THEN** the notification contains foo's absolute project path
- **AND** the notification identifies the restored session (session file name and/or session id)
- **AND** the notification states that this session was restored for project foo

#### Scenario: Switch to a project with no stored session (first session)

- **WHEN** the user runs `/project foo` and no session is stored for foo (or the stored file no longer exists)
- **THEN** the notification contains foo's absolute project path
- **AND** the notification states that this is the first session in project foo
- **AND** the notification identifies that the current session continues under the new project (no session switch performed)

#### Scenario: Session id reported on restore

- **WHEN** a stored session is restored during the switch
- **THEN** the session id (or, when not separately available, the session file name from which it is derivable) is included in the notification
