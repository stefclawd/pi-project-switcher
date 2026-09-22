# project-switching Specification

## Purpose
Provide a `/project` command for the pi coding agent to switch between projects that live as direct subdirectories of a configurable base directory. The active project is injected into the agent context so all file operations and commands default to that project.

## Requirements

### Requirement: Dynamic Project Discovery

The extension SHALL discover projects as all direct subdirectories of the
configured base directory. Git repositories are NOT required for a folder
to count as a project. Hidden folders (dotfiles) SHALL be excluded.

#### Scenario: Listing projects

- **WHEN** the user runs `/project` without arguments
- **THEN** all direct subdirectories of the base directory are listed with
  an indicator on the active project
- **AND** the output form adapts to the invocation surface per the
  Surface-Adaptive Status Output requirement (selection dialog on native
  TUI, plain list on other surfaces, buttons in the Telegram chat reply)

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

### Requirement: Project Context Injection
While a project is active, every agent turn SHALL receive the project path in the system prompt so file operations default to that project.

#### Scenario: Context present after switch
- **WHEN** a project is active and the user sends any prompt
- **THEN** the system prompt contains the active project's absolute path

### Requirement: Auto-Detection on Session Start
On session start, if no persisted project exists, the extension SHALL try to detect the active project from the current working directory (session cwd inside base dir).

#### Scenario: Start from project directory
- **WHEN** pi is started with cwd `~/dev/foo`
- **THEN** "foo" is active without user interaction

#### Scenario: Start outside base dir
- **WHEN** pi is started with cwd outside the base directory
- **THEN** no project is active; `/project` lists available ones

### Requirement: Session Restore on Project Switch
The extension SHALL maintain a machine-local session map (`~/.pi/agent/project-switcher-sessions.json`) mapping each project to its most recent session file, stored relative to `~/.pi/agent/sessions/`. On `/project <name>`, if the target project has a stored session file that still exists, the extension SHALL switch to that session via `switchSession()`; otherwise it SHALL fall back to switching context within the current session.

#### Scenario: Target project has a stored session
- **WHEN** the user runs `/project beta` and beta has a stored, existing session file
- **THEN** pi switches to that session file and the active project becomes beta

#### Scenario: Stored session file no longer exists
- **WHEN** the target project's mapped session file was deleted
- **THEN** the switch happens in the current session (context injection only)

#### Scenario: Session lives outside the sessions dir
- **WHEN** the current session file is not under `~/.pi/agent/sessions/`
- **THEN** it is not persisted to the session map

#### Scenario: Switch is cancelled
- **WHEN** `switchSession()` reports cancellation (e.g. user aborts)
- **THEN** the active project remains unchanged

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

### Requirement: Telegram Switch Confirmation

When `/project <name>` is dispatched from the Telegram bridge, the
extension SHALL deliver a visible confirmation of the switch outcome to the
Telegram chat: after a successful switch it starts a follow-up agent turn
in the active (new) runtime whose reply confirms the switch, including the
project name, its working directory, and the session identity per the
Switch Output requirement. The confirmation SHALL be produced on both
switch paths (restored session and same-session fallback). On the
restored-session path, when the switch released the Telegram transport
before replacing the session, the confirmation follow-up SHALL NOT be
dispatched until the transport has re-armed in the new runtime (per the
Telegram Transport Re-arm requirement): the follow-up is queued with the
re-arm, and once the re-arm is verified the confirmation is dispatched
from the fresh `withSession` context. If the re-arm cannot be verified
within a bounded window (10 seconds after the reconnect dispatch), the
switcher SHALL send a plain warning directly through the Telegram Bot API
to the configured allowed user (token and chat id read from
`~/.pi/agent/telegram.json`) stating that the switch happened but the
Telegram extension did not reconnect, and SHALL journal the failure to
the local UI. Any error while waiting for, verifying, or performing the
re-arm-sequenced confirmation is reported to the local UI and never
affects the switch result.

#### Scenario: Telegram switch with restored session is confirmed in the chat

- **WHEN** `/project beta` is dispatched from the Telegram bridge and beta
  has a stored, existing session file
- **THEN** the session is switched to beta's stored session
- **AND** a follow-up turn is started from the new runtime
  (`withSession` context) whose reply reaches the Telegram chat
- **AND** the reply confirms the switch to beta including its working
  directory and the restored session identity

#### Scenario: Confirmation waits for the verified re-arm when the transport was released

- **WHEN** a Telegram-originated restored-session switch released the
  transport before the session replacement
- **THEN** the confirmation follow-up is not dispatched immediately from
  `withSession`
- **AND** it is dispatched only after the transport re-arm is verified in
  the new runtime (new instance state with active polling for the current
  process)
- **AND** the confirmation is still dispatched from the fresh
  `withSession` context, never from the invalidated pre-switch runtime

#### Scenario: Bot-API warning when the re-arm does not complete in time

- **WHEN** the transport re-arm is not verified within 10 seconds after
  the reconnect dispatch
- **THEN** no confirmation follow-up turn is dispatched (its reply would
  be undeliverable)
- **AND** the switcher sends a plain warning message directly through
  the Telegram Bot API (token and allowed chat id from
  `~/.pi/agent/telegram.json`) saying the switch happened but the
  Telegram extension did not reconnect
- **AND** the failure is journaled to the local UI
- **AND** the switch result is unaffected

#### Scenario: Telegram switch without stored session is confirmed in the chat

- **WHEN** `/project beta` is dispatched from the Telegram bridge and beta
  has no stored session file (or it no longer exists)
- **THEN** the switch happens in the current session (no transport
  transition occurred)
- **AND** a follow-up turn is started immediately whose reply reaches the
  Telegram chat and confirms the switch to beta (first session in the
  project)

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

### Requirement: Telegram Transport Re-arm After Session Switch

When a Telegram-originated `/project <name>` switch replaces the session
(restored-session path), the extension SHALL detect whether the session
being left was the live owner of the Telegram transport, and if — and only
if — it was, transition the transport across the session replacement: the
old runtime releases the transport **before** the switch (by executing the
`/telegram-disconnect` command synchronously, which stops polling and
releases pi-telegram's lock), and the new runtime re-arms it after the
switch (by executing the `/telegram-connect` command from the
`withSession` context after a short safety delay) **and verifies the
re-arm** before any Telegram-transport-dependent follow-up (such as the
switch confirmation) is dispatched: the switcher polls pi-telegram's
runtime state (`~/.pi/agent/tmp/telegram/state.json`) until it shows an
active lock and polling for the current process, bounded at 10 seconds
after the reconnect dispatch. Ownership SHALL be determined by a read-only
inspection of pi-telegram's lock file
(`~/.pi/agent/tmp/telegram/owners.json`) performed before the session
switch: the lock entry must name the current process (`pid` equal to the
switcher's own PID), carry a fresh heartbeat (within 10 seconds), and match
the old session's working directory (or carry no cwd). The switcher SHALL
NOT modify pi-telegram's lock or state files; all transport transitions
execute pi-telegram's own commands, which perform the transitions through
pi-telegram's own ownership code. A pending re-arm with its queued
follow-up is superseded when a new one is scheduled, so exactly one
re-arm runs for the current runtime.

#### Scenario: Connected switch keeps Telegram alive

- **WHEN** `/project beta` is dispatched from the Telegram bridge and the
  switcher's pre-switch probe finds a live same-process lock matching the
  old session's cwd
- **THEN** the old runtime executes `/telegram-disconnect` before the
  session switch, releasing the transport lock
- **AND** after the switch succeeds, the new runtime executes
  `/telegram-connect` once (via the `withSession` context, after a short
  safety delay), re-acquiring the transport and restarting polling
- **AND** the switcher verifies the re-acquired state before dispatching
  the confirmation follow-up
- **AND** the switcher never mutates `owners.json` or `state.json`
  directly

#### Scenario: Switch from a session that did not own the transport

- **WHEN** the probe finds no lock, a lock owned by a different PID, a
  stale heartbeat, or a cwd that does not match the old session
- **THEN** no disconnect and no connect command are sent

#### Scenario: Native switch never re-arms

- **WHEN** `/project beta` is invoked from a native surface (no
  Telegram-origin flag)
- **THEN** the lock file is not consulted and no transport transition
  happens, regardless of ownership

#### Scenario: Cancelled switch never re-arms

- **WHEN** a Telegram-originated session-replacing switch is cancelled
  **before** the transport was released
- **THEN** no transport transition happens (the old runtime keeps the
  transport)

#### Scenario: Release failure does not break the switch

- **WHEN** the pre-switch `/telegram-disconnect` execution fails
- **THEN** the re-arm attempt is abandoned and the switch proceeds
  normally (the switch result is unaffected)

#### Scenario: Re-arm failure is non-fatal

- **WHEN** the delayed `/telegram-connect` dispatch fails or the re-arm
  cannot be verified within the bound
- **THEN** the failure is reported to the local UI, the queued
  confirmation falls back to the Bot-API warning (Telegram Switch
  Confirmation requirement), and the switch result is otherwise
  unaffected
