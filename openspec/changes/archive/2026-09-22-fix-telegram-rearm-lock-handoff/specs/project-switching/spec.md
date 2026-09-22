# project-switching Specification (Delta)

## MODIFIED Requirements

### Requirement: Telegram Transport Re-arm After Session Switch

When a Telegram-originated `/project <name>` switch replaces the session
(restored-session path), the extension SHALL detect whether the session
being left was the live owner of the Telegram transport, and if — and only
if — it was, transition the transport across the session replacement: the
old runtime releases the transport **before** the switch (by executing the
`/telegram-disconnect` command synchronously, which stops polling and
releases pi-telegram's lock), and the new runtime re-arms it after the
switch (by executing the `/telegram-connect` command from the
`withSession` context after a short safety delay). Ownership SHALL be
determined by a read-only inspection of pi-telegram's lock file
(`~/.pi/agent/tmp/telegram/owners.json`) performed before the session
switch: the lock entry must name the current process (`pid` equal to the
switcher's own PID), carry a fresh heartbeat (within 10 seconds), and match
the old session's working directory (or carry no cwd). The switcher SHALL
NOT modify pi-telegram's lock or state files; all transport transitions
execute pi-telegram's own commands, which perform the transitions through
pi-telegram's own ownership code.

#### Scenario: Connected switch keeps Telegram alive

- **WHEN** `/project beta` is dispatched from the Telegram bridge and the
  switcher's pre-switch probe finds a live same-process lock matching the
  old session's cwd
- **THEN** the old runtime executes `/telegram-disconnect` before the
  session switch, releasing the transport lock
- **AND** after the switch succeeds, the new runtime executes
  `/telegram-connect` once (via the `withSession` context, after a short
  safety delay), re-acquiring the transport and restarting polling
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
- **THEN** no transport transition happens (the old runtime keeps the
  transport)

#### Scenario: Release failure does not break the switch

- **WHEN** the pre-switch `/telegram-disconnect` execution fails
- **THEN** the re-arm attempt is abandoned and the switch proceeds
  normally (the switch result is unaffected)

#### Scenario: Re-arm failure is non-fatal

- **WHEN** the delayed `/telegram-connect` dispatch fails
- **THEN** the failure is reported to the local UI only and the switch
  result is otherwise unaffected
