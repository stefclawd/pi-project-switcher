# project-switching Specification (Delta)

## MODIFIED Requirements

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
