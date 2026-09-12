# project-switching Specification

## Purpose
Provide a `/project` command for the pi coding agent to switch between projects that live as direct subdirectories of a configurable base directory. The active project is injected into the agent context so all file operations and commands default to that project.

## Requirements

### Requirement: Dynamic Project Discovery
The extension SHALL discover projects as all direct subdirectories of the configured base directory. Git repositories are NOT required for a folder to count as a project. Hidden folders (dotfiles) SHALL be excluded.

#### Scenario: Listing projects
- **WHEN** the user runs `/project` without arguments
- **THEN** all direct subdirectories of the base directory are listed with an indicator on the active project

#### Scenario: Base directory has no subdirectories
- **WHEN** the configured base directory contains no (visible) subdirectories
- **THEN** `/project` reports that no projects were found and exits gracefully

### Requirement: Configurable Base Directory
The base directory SHALL be configurable. Default is `~/dev`. Configuration source (in order of precedence):
1. Extension-local settings file in the pi agent dir
2. Environment variable `PI_PROJECT_SWITCHER_BASE`
3. Default `~/dev`

#### Scenario: Custom base via environment
- **WHEN** `PI_PROJECT_SWITCHER_BASE=/opt/work` is set
- **THEN** projects are discovered under `/opt/work`

### Requirement: Switching Projects
`/project <name>` SHALL switch to the named project when it exists. Switching consists of:
1. Storing the active project (persisted across reloads via session entry)
2. Setting the session display name to the project name
3. Announcing the switch to the agent (context message)

#### Scenario: Successful switch
- **WHEN** the user runs `/project floop` and `~/dev/floop` exists
- **THEN** the session name is set to include "floop" and the agent is told the new working context

#### Scenario: Unknown project
- **WHEN** the user runs `/project doesnotexist`
- **THEN** an error is shown and the active project remains unchanged

### Requirement: Project Context Injection
While a project is active, every agent turn SHALL receive the project path in the system prompt so file operations default to that project.

#### Scenario: Context present after switch
- **WHEN** a project is active and the user sends any prompt
- **THEN** the system prompt contains the active project's absolute path

### Requirement: Auto-Detection on Session Start
On session start, if no persisted project exists, the extension SHALL try to detect the active project from the current working directory (session cwd inside base dir).

#### Scenario: Start from project directory
- **WHEN** pi is started with cwd `~/dev/floop`
- **THEN** "floop" is active without user interaction

#### Scenario: Start outside base dir
- **WHEN** pi is started with cwd outside the base directory
- **THEN** no project is active; `/project` lists available ones
