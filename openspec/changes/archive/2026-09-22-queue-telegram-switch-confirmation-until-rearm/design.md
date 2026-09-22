# Design: queue-telegram-switch-confirmation-until-rearm

## Context

- **Flakiness root cause** (observed 2026-09-22 22:15): the confirmation
  follow-up turn is dispatched from `withSession` immediately after the
  session replacement. Its reply is delivered by pi-telegram's proactive
  push, which is gated by session-context ownership
  (`isSessionContextActive`). The pre-switch `/telegram-disconnect`
  released the transport; until the delayed `/telegram-connect` completes
  and pi-telegram re-initializes in the new runtime, ownership is false
  and replies finishing inside that window are dropped silently. Model
  latency decides the outcome.

- **Re-arm observability**: pi-telegram persists a runtime snapshot to
  `~/.pi/agent/tmp/telegram/state.json` on a scheduler and on status
  changes. After a completed re-arm the snapshot shows
  `runtime.pollingActive: true`, `runtime.lockState` indicating active
  ownership, and the ownership lock
  `~/.pi/agent/tmp/telegram/owners.json` holds a fresh same-pid
  heartbeat. The new runtime's `instanceId` (in `owners.json`) changes
  across session replacement, so "new instance for the current process
  with active polling + fresh lock heartbeat" is a reliable re-arm
  signal. The switcher only READS these files.

- **Direct Bot-API fallback**: `~/.pi/agent/telegram.json` holds the bot
  token, bot username, and `allowedUserId` (the paired private chat).
  A plain `sendMessage` HTTPS call needs no transport, no lock, and no
  pi-telegram runtime — it works precisely in the situation where the
  extension transport is dead. It cannot render `telegram_button`
  markup, so it carries only a plain warning line.

- **Sequencing**: the existing re-arm timer (3 s safety delay before
  `/telegram-connect`) is extended into one combined callback:
  connect → poll state (short interval, 10 s bound) → on success
  dispatch the queued confirmation follow-up from the same fresh
  `withSession` context; on timeout send the Bot-API warning. The
  callback captures only the `withSession` context; the pre-switch
  `pi`/ctx are already invalid by then and are never touched.

- **Failure isolation**: the callback is a timer callback. Any error
  escaping it would kill the daemon (2026-09-18 lesson). Every step is
  wrapped; the catch journals to the local UI via the captured context
  (itself guarded, since a follow-up switch can replace the runtime
  while the timer is pending — the pending slot is superseded instead).

## Goals / Non-Goals

Goals:

- Every Telegram-originated session-replacing switch that released the
  transport delivers a visible outcome to the chat: either the full
  confirmation (buttons included) after a verified re-arm, or the plain
  Bot-API warning when the re-arm fails/times out.
- The confirmation reply is never produced while the transport is down,
  removing the latency coin flip.
- The switch result is never affected by any transport or delivery
  failure; no uncaught timer errors.

Non-Goals:

- Fixing pi-telegram's drop-on-inactive-context behavior itself.
- Bracket (pre-switch) messages, Delivery API usage — superseded by this
  simpler sequencing design.
- Re-arming or confirming when the probe failed (transport not owned
  here): unchanged behavior, immediate confirmation as today.

## Risks / Trade-offs

- `state.json` is a snapshot written by a scheduler; a completed re-arm
  may not be reflected instantly. The poll uses BOTH the state snapshot
  and `owners.json` (fresh same-pid heartbeat + polling flag when
  readable) to bound staleness; the 10 s window comfortably covers the
  scheduler cadence observed in practice (seconds).
- Reading `~/.pi/agent/telegram.json` couples the switcher to that
  config file's shape (botToken/allowedUserId). Both fields have
  fallbacks: missing/invalid config → the warning is journaled locally
  only.
- The Bot-API warning is a plain message without buttons; acceptable for
  a failure path whose whole point is that the extension transport is
  dead.

## Reset & Supersession

- One pending combined-callback slot (timer handle), superseded by a
  newer switch exactly like the v0.8.1 re-arm slot. The superseded
  callback's captured context is never used after supersession.
- All module-level testability hooks (rearm-state path, Bot-API sender)
  are injectable so tests need no real pi-telegram install.

## Migration Plan

- Single-file extension: the combined callback replaces
  `scheduleTelegramRearm`; the immediate confirmation dispatch inside
  `withSession` moves behind the verified re-arm (transport-released
  path only). No config or lock file changes; rollout is a version bump
  + daemon checkout sync.
