# project-switching Specification (Delta)

## ADDED Requirements

### Requirement: Telegram Switch Confirmation

When `/project <name>` is dispatched from the Telegram bridge, the
extension SHALL deliver a visible confirmation of the switch outcome to the
Telegram chat: after a successful switch it starts a follow-up agent turn
in the active (new) runtime whose reply confirms the switch, including the
project name, its working directory, and the session identity per the
Switch Output requirement. The confirmation SHALL be produced on both
switch paths (restored session and same-session fallback).

#### Scenario: Telegram switch with restored session is confirmed in the chat

- **WHEN** `/project beta` is dispatched from the Telegram bridge and beta
  has a stored, existing session file
- **THEN** the session is switched to beta's stored session
- **AND** a follow-up turn is started from the new runtime
  (`withSession` context) whose reply reaches the Telegram chat
- **AND** the reply confirms the switch to beta including its working
  directory and the restored session identity

#### Scenario: Telegram switch without stored session is confirmed in the chat

- **WHEN** `/project beta` is dispatched from the Telegram bridge and beta
  has no stored session file (or it no longer exists)
- **THEN** the switch happens in the current session
- **AND** a follow-up turn is started whose reply reaches the Telegram chat
  and confirms the switch to beta (first session in the project)

#### Scenario: Confirmation includes prompt buttons

- **WHEN** the Telegram switch confirmation reply is composed
- **THEN** it contains a pre-rendered `telegram_button` block with a
  status button queuing `/project`
- **AND** when a previous project exists, a switch-back button queuing
  `/project <previous>` is included

#### Scenario: Already-active switch answers the chat

- **WHEN** `/project beta` is dispatched from the Telegram bridge and beta
  is already the active project
- **THEN** a short follow-up turn informs the chat that the project is
  already active (no switch is performed)

#### Scenario: Cancelled switch answers the chat

- **WHEN** a Telegram-dispatched switch is cancelled (switchSession
  reports cancellation)
- **THEN** a short follow-up turn informs the chat that the switch was
  cancelled and which project remains active

#### Scenario: No stale runtime usage after session replacement

- **WHEN** the confirmation follow-up is sent after a session switch
- **THEN** it is sent exclusively through the fresh `withSession` context
  of the new runtime; the invalidated pre-switch `pi`/context objects are
  never used

### Requirement: Telegram Switch Origin Detection

The extension SHALL detect that `/project <name>` was dispatched from the
Telegram bridge by observing the raw bridge dispatch on the `input` event
(first line tagged `[telegram]`, attribute variants allowed, `/project`
with arguments) and arming a bounded, single-use flag that the next switch
execution consumes. The flag SHALL have the same lifetime rules as the
status flag: short time-to-live, cleared on session start.

#### Scenario: Switch flag armed by Telegram dispatch

- **WHEN** the raw prompt `[telegram] /project beta` (or an attribute
  variant, optionally followed by pi-telegram context sections after a
  blank line) arrives as an `input` event with source "extension"
- **THEN** the switch origin flag is armed

#### Scenario: Native switch does not arm the flag

- **WHEN** `/project beta` is invoked from the TUI or RPC surface without a
  preceding Telegram dispatch
- **THEN** no flag is armed and the switch behaves exactly as before
  (local notification only, no confirmation turn)

## MODIFIED Requirements

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

#### Scenario: Telegram-originated switch confirms in the chat

- **WHEN** the switch was dispatched from the Telegram bridge
- **THEN** the switch facts (project, working directory, session identity)
  additionally reach the Telegram chat through the confirmation turn per
  the Telegram Switch Confirmation requirement
- **AND** the local UI notification is still emitted unchanged

### Requirement: Surface-Adaptive Status Output

`/project` without arguments SHALL adapt its output to the surface the
command was invoked from: a selection dialog on native TUI, a plain text
list on other non-Telegram surfaces, and a Telegram chat reply with one
prompt button per project when the command was dispatched from the
Telegram bridge.

#### Scenario: Native TUI shows a selection dialog

- **WHEN** `/project` is invoked in a native TUI session (run mode "tui")
- **AND** at least one project exists
- **THEN** a selection dialog lists all discovered projects
- **AND** confirming a choice executes the same switch flow as
  `/project <name>` for the chosen project
- **AND** dismissing the dialog falls back to the plain text list without
  changing the active project

#### Scenario: Telegram-originated status shows buttons

- **WHEN** `/project` is dispatched from the Telegram bridge (raw prompt
  first line carries the `[telegram]` tag with no command arguments)
- **THEN** a follow-up agent turn is started whose prompt contains the
  authoritative discovered project list
- **AND** the prompt instructs the reply to include one prompt button per
  project, each queuing exactly `/project <name>` when clicked
- **AND** the active project (when one is active) is listed first and
  marked as active in both the list and the button labels

#### Scenario: Button click behaves like the typed command

- **WHEN** a user clicks a project button generated by the Telegram status
  output
- **THEN** the queued prompt `/project <name>` is executed by the command
  bridge exactly as if the user had typed it
- **AND** switch semantics (session restore, announcements, unknown-name
  rules) are identical to the typed command
- **AND** the switch outcome is confirmed in the Telegram chat per the
  Telegram Switch Confirmation requirement

#### Scenario: Other surfaces keep the plain list

- **WHEN** `/project` is invoked on a non-TUI surface that was not
  dispatched from the Telegram bridge (rpc/json/print without Telegram
  origin)
- **THEN** the behavior is unchanged: the plain text list is emitted via
  the UI notification channel

#### Scenario: No projects

- **WHEN** `/project` is invoked on any surface and the base directory has
  no visible subdirectories
- **THEN** the "no projects found" warning is emitted on the local UI
  channel and no selection dialog, follow-up turn, or button row is
  produced

#### Scenario: Unsafe project names never produce buttons

- **WHEN** the Telegram status list is built and a discovered project name
  contains characters that could alter the button markup or prompt
  (`{`, `}`, `|`, backslash, backtick, newline)
- **THEN** that project appears as plain list text only, without a button

#### Scenario: Telegram flag is bounded

- **WHEN** a Telegram-originated `/project` input (with or without
  arguments) arms an origin flag
- **THEN** the flag is consumed by the next matching execution (status
  without arguments, switch with arguments) and cleared
- **AND** the flag expires without effect after a short time-to-live
- **AND** the flag is cleared on session start
