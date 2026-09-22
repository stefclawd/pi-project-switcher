# Proposal: rearm-telegram-after-session-switch

## Why

A Telegram-originated `/project <name>` switch with a stored session calls
`ctx.switchSession()`. pi-telegram reacts to the `session_shutdown` by
suspending its `getUpdates` poll (deliberate stand-down, expecting the new
session runtime in the same process to take over the transport), but the
new runtime's `session_start` auto-reconnect **silently declines the
handoff**: the lock in `owners.json` was taken under the daemon session's
cwd, while the restored project session carries its own project cwd
(e.g. `/home/clawd/dev/pi-telegram-command-bridge`). pi-telegram's handoff
paths (`owns`, stale-same-cwd, active-here-same-cwd, follower-restore) all
require matching cwd, so none applies. Result observed 2026-09-22
(`/project pi-project-switcher` via Telegram button): inbound Telegram is
dead after every session-replacing switch until a manual
`/telegram-connect` (the daemon only sends it once at boot).

## What Changes

1. **Ownership probe before the switch**: when the switcher consumes the
   Telegram-origin flag for a session-replacing switch, it reads
   `~/.pi/agent/tmp/telegram/owners.json` (the pi-telegram transport lock)
   **before** calling `switchSession` and records whether the current
   process is the live transport owner: `lock.pid === process.pid` and
   `lock.cwd` matches the *old* session's cwd and the heartbeat is fresh
   (< 10 s). This is the requirement's guard: the re-arm happens **only**
   when the session we are leaving is the one that owned the connected
   Telegram transport.
2. **Re-arm in `withSession`**: on a successful switch, inside the fresh
   `withSession` context, the switcher sends `/telegram-connect` as a
   command re-dispatch via `newCtx.sendUserMessage("/telegram-connect",
   { expandPromptTemplates: true })`. pi-telegram's connect handler
   re-acquires the (by then stale) lock and restarts polling, restoring
   inbound Telegram in the new session.
3. **Timing**: the re-dispatch is sent only after the old lock heartbeat
   has gone stale (pi-telegram staleness window is 8 s, heartbeat refresh
   stops at suspend). The switcher waits ~9 s (bounded, unref'd timer)
   before re-dispatching, so the connect command finds a *stale* lock,
   which its non-forced acquire can replace even across cwd mismatch
   (stale locks bypass the active-here/active-elsewhere acquisition block).
   The re-dispatch does not start an agent turn (prompt-template command
   dispatch) and is fire-and-forget: failures are logged to the local UI,
   never thrown from `withSession`.
4. **No re-arm when the guard fails**: if `owners.json` shows no live
   same-process owner for the old session's cwd (different PID — another
   pi instance owns the bot; or no lock at all — Telegram was never
   connected here), the switcher sends nothing. A non-Telegram (native)
   switch never reads `owners.json` and never re-arms.

## Impact

- Specs: `project-switching` — adds requirement **Telegram Transport
  Re-arm After Session Switch** (ownership probe + guarded re-arm).
- Code: `index.ts` — `probeTelegramTransportOwnership()` helper (read +
  freshness check of `owners.json`), delayed re-arm in the `withSession`
  callback of the restore path, only when the probe passed and the
  Telegram-origin flag was consumed.
- Tests: `test/extension.test.ts` — probe unit tests (fresh/stale/foreign
  pid/missing file/cwd mismatch), re-arm fired on successful switch with
  matching owner, no re-arm on guard failure, re-arm deferred past the
  staleness window, no re-arm on native switches.
- Docs: `README.md` — document the automatic Telegram re-arm.
- No changes to: pi-telegram, pi-telegram-command-bridge, the session
  map, or switching semantics otherwise. Read-only access to
  `owners.json`; the lock file itself is never mutated by the switcher
  (the connect command does the acquiring through pi-telegram's own code).
