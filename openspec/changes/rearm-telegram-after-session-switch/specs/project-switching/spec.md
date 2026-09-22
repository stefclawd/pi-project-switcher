# project-switching Specification (Delta)

## ADDED Requirements

### Requirement: Telegram Transport Re-arm After Session Switch

When a Telegram-originated `/project <name>` switch replaces the session
(restored-session path), the extension SHALL detect whether the session
being left was the live owner of the Telegram transport, and if — and
only if — it was, re-arm the Telegram transport in the new session by
executing the `/telegram-connect` command once, after the transport lock
has gone stale. Ownership SHALL be determined by a read-only inspection
of pi-telegram's lock file (`~/.pi/agent/tmp/telegram/owners.json`)
performed before the session switch: the lock entry must name the
current process (`pid` equal to the switcher's own PID), carry a fresh
heartbeat (within 10 seconds), and match the old session's working
directory (or carry no cwd). The switcher SHALL NOT modify pi-telegram's
lock or state files; the re-arm executes the connect command, which
acquires the transport through pi-telegram's own ownership code.

#### Scenario: Connected switch keeps Telegram alive

- **WHEN** `/project beta` is dispatched from the Telegram bridge and the
  switcher's pre-switch probe finds a live same-process lock matching the
  old session's cwd
- **THEN** after the session switch succeeds, the `/telegram-connect`
  command is executed once from the new runtime (via the `withSession`
  context), delayed past pi-telegram's lock staleness window
- **AND** the re-arm never mutates `owners.json` or `state.json` directly

#### Scenario: Switch from a session that did not own the transport

- **WHEN** the probe finds no lock, a lock owned by a different PID, a
  stale heartbeat, or a cwd that does not match the old session
- **THEN** no re-arm is performed and no `/telegram-connect` command is
  sent

#### Scenario: Native switch never re-arms

- **WHEN** `/project beta` is invoked from a native surface (no
  Telegram-origin flag)
- **THEN** the lock file is not consulted and no re-arm happens,
  regardless of ownership

#### Scenario: Cancelled switch never re-arms

- **WHEN** a Telegram-originated session-replacing switch is cancelled
- **THEN** no re-arm is performed (the old runtime keeps the transport)

#### Scenario: Re-arm failure is non-fatal

- **WHEN** the delayed `/telegram-connect` dispatch fails
- **THEN** the failure is reported to the local UI only and the switch
  result is otherwise unaffected
