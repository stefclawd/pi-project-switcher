# Design: fix-telegram-rearm-lock-handoff

## Context

Live verification of v0.8.0 (2026-09-22 21:51, daemon PID 3614991) showed the
re-arm firing but failing at lock acquisition. Reading pi-telegram v0.48.1
source explains why — the v0.8.0 design rested on two false premises:

- `getLockState()` (locks.js): `lock.pid === pid → "active-here"` is checked
  **before** the heartbeat-staleness branch. Our own PID's lock is never
  "stale", regardless of heartbeat age.
- `canSupersedeSameProcessOwner()` (locks.js): same-process lock
  replacement requires `current.cwd === undefined || current.cwd === ctx.cwd`
  — for both normal and forced acquisition. A restored project session's
  cwd never matches the daemon cwd that took the lock.

Therefore `/telegram-connect` (immediate or delayed, plain or forced) can
never re-acquire the transport after a cwd-changing session switch while the
old entry sits in `owners.json`. The only clean path is for the **old, owning
runtime to release the lock before the session is replaced**.

Key enabling facts (all verified in pi-telegram v0.48.1 and pi 0.85.x source):

- `/telegram-disconnect` handler → `lockedPollingRuntime.stop()` →
  `suspendPolling()` (stop poll, abort getUpdates) + **`lock.release()`**.
- `release()` deletes the `owners.json` entry only when the calling lock
  runtime actually owns it (`ownedLockKey` set by a prior acquire) — exactly
  our old runtime's situation. From a non-owning runtime, release is a safe
  no-op that leaves the file untouched (and the probe prevents even
  attempting it).
- The disconnect command raises a confirm dialog **only in Threaded Mode**
  (`getDisconnectThreadName()` returns a thread name). Threaded Mode is
  disabled for this bot, so the headless daemon runs it unattended.
- pi's `prompt()` executes extension commands **synchronously**
  (`_tryExecuteExtensionCommand` runs before any streaming/queue check), so
  `pi.sendUserMessage("/telegram-disconnect", { expandPromptTemplates: true })`
  from inside the `/project` command handler completes the release before it
  returns. Nested command execution inside the command bridge's re-dispatch
  is the same established pattern the bridge itself uses.
- With no lock present, the connect handler's acquire succeeds
  unconditionally (the acquisition block only guards `active-here` /
  `active-elsewhere` states).

## Goals / Non-Goals

Goals:

- Telegram survives a session-replacing switch, verified end to end.
- Ownership guard semantics unchanged: never disconnect a transport this
  session does not own (fresh same-pid same-cwd lock required first).
- No lock/state file mutation by the switcher; all transport transitions go
  through pi-telegram's own commands.

Non-Goals:

- No pi-telegram changes (the same-pid-never-stale + cwd-bound takeover
  behavior is upstream; worth an upstream issue, out of scope here).
- No re-arm for fallback/cancelled/native switches (unchanged from v0.8.0).

## Possible Solutions

### A. Keep the delayed connect, answer the takeover dialog automatically

Rejected: the forced takeover path also fails on cwd mismatch
(`canSupersedeSameProcessOwner`), so even an auto-confirmed dialog cannot
acquire. Dead end by construction.

### B. Keep the delay but connect from a context whose cwd matches the lock cwd

Rejected: no such runtime exists after the switch; the whole problem is the
cwd change.

### C. Disconnect before the switch, connect in the new runtime (chosen)

The old runtime is the only party that can release the lock
(`release()` is ownership-guarded), and the disconnect command is the
sanctioned way to do it. Sequence:

1. probe passes (we own the live transport),
2. `/telegram-disconnect` via `pi.sendUserMessage` — synchronous command
   execution in the old runtime → poll stopped, lock entry deleted,
3. `ctx.switchSession(...)` — replacement; pi-telegram's shutdown handlers
   run with polling already stopped (idempotent),
4. in `withSession`: short-delay (~3 s) unref'd timer re-dispatches
   `/telegram-connect` via `newCtx.sendUserMessage` — acquire succeeds on
   the now-empty lock, polling restarts in the new session.

Trade-off: a ~3 s window with polling stopped (plus the switch duration).
Telegram buffers updates server-side (24 h), so inbound messages are
delayed, never lost. This is strictly better than v0.8.0's 9 s window which
also did not work.

### D. Reconnect immediately in withSession without a delay

Rejected as the default: the release is synchronous, but the surrounding
session-teardown and extension-runtime cleanup are not fully ordered
guarantees across pi-telegram internals; a small delay avoids racing the
replacement's own lifecycle observers for the price of 3 s.

## Risks / Trade-offs

- **Disconnect during the active Telegram dispatch**: we are mid-turn in
  the command that the bridge dispatched. Stopping polling does not affect
  the already-dispatched command or the outbound delivery of the
  confirmation turn (sendMessage is independent of getUpdates polling).
- **Probe false positive** (owner alive but different instance): the probe
  requires same pid + fresh heartbeat + matching cwd, so the disconnect
  would release a lock genuinely owned by this process. No corruption path.
- **Connect failing** (e.g. network): reported to the new runtime's local
  UI only, never thrown; the switch itself is complete. A later manual
  `/telegram-connect` works because no lock remains.
- **Double re-arm** on rapid consecutive switches: single-slot timer
  semantics kept from v0.8.0 (a new schedule supersedes the pending one);
  the disconnect path is idempotent for a non-owning runtime (probe gates
  it anyway).
