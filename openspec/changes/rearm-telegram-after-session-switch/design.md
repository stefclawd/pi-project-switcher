# Design: rearm-telegram-after-session-switch

## Context

- pi-telegram (v0.48.1) owns the transport lock at
  `~/.pi/agent/tmp/telegram/owners.json`. The entry records
  `{ pid, cwd, instanceId, heartbeatMs, leaderEpoch, runtimeGeneration }`.
  The heartbeat is refreshed every 2 s while polling is owned
  (`TELEGRAM_OWNERSHIP_REFRESH_MS = 2_000`); a lock whose heartbeat is
  older than 8 s (`TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 8_000`) is
  classified **stale** by `getLockState()`.

- On `session_shutdown`, pi-telegram suspends polling
  (`suspendPolling()`: bumps the polling generation, stops the ownership
  watcher and heartbeat refresh, aborts `getUpdates`) but deliberately
  does **not** release the lock — it expects a same-process session
  handoff.

- The new runtime's `session_start` auto-start
  (`locks.js onSessionStart`) only takes over the lock when one of:
  the new ctx already owns it, the lock is stale **and** `lock.cwd ===
  ctx.cwd`, the lock is active-here **and** `lock.cwd === ctx.cwd`, or a
  remembered follower can be restored. `/project` switches restore
  sessions with a *project* cwd (e.g. `/home/clawd/dev/x`) while the
  daemon session that took the lock has cwd `/home/clawd/.pi-agent-daemon`
  — every path fails, the auto-start returns silently, and inbound
  Telegram is dead.

- `/telegram-connect` (command registered by pi-telegram) re-arms the
  transport. Its non-forced acquire is blocked only by an **active-here**
  or **active-elsewhere** lock with mismatched owner; a **stale** lock is
  replaceable regardless of cwd. Since the suspended old runtime stops
  refreshing the heartbeat at session shutdown, the lock goes stale after
  ~8 s.

- The switcher already has a Telegram-origin flag for switches
  (`TELEGRAM_SWITCH_RE`, consumed by `switchToProject`). The
  session-replacing (restore) path runs all post-switch work inside
  `withSession` on a fresh `ReplacedSessionContext`, whose
  `sendUserMessage(content, { expandPromptTemplates: true })` re-dispatch
  mechanism is exactly what the command bridge uses to execute slash
  commands — so `/telegram-connect` can be executed programmatically
  from the new runtime.

- **Why the cwd guard is required (maintainer requirement):** the same
  machine may run other pi processes (TUI sessions, other daemons) that
  never used Telegram, or a *different* pi instance may legitimately own
  the bot. If a non-owning session ran `/telegram-connect` after its
  switch, it would either try to steal the transport from the real owner
  (active-elsewhere → follower registration attempts / error noise) or
  spin up polling in a session that has no Telegram user expectation.
  Therefore the re-arm must fire **only** when the session being left is
  demonstrably the connected transport owner. `owners.json.cwd` compared
  against the old session's cwd, plus `pid === process.pid` and a fresh
  heartbeat, is that proof. The diagnosis doc for pi-telegram also
  explicitly forbids mutating lock/state files by hand; the switcher only
  **reads** `owners.json` and lets the real connect handler do all
  acquiring.

## Goals / Non-Goals

Goals:

- Inbound Telegram survives every session-replacing `/project` switch
  that originated from the connected bridge session.
- The re-arm is provably tied to ownership: it never fires when the
  source session was not the Telegram transport owner.
- No mutation of pi-telegram's state or lock files by the switcher.
- Native (non-Telegram) switches behave exactly as before.

Non-Goals:

- No changes to pi-telegram (the cwd-mismatch auto-start gap is an
  upstream issue; this change is a sanctioned workaround).
- No re-arm for same-session fallback switches (no `session_shutdown`
  happens there; polling is never suspended).
- No re-arm on cancelled switches (the old runtime keeps the transport).
- Not detecting Telegram origin from `owners.json` (the input-event flag
  remains the origin signal; the lock probe only proves ownership).

## Possible Solutions

### A. Relax the cwd check in pi-telegram's handoff

Upstream fix: same-pid takeover should not require matching cwd since the
old runtime is the same, now-dead process. Correct place, but out of scope
for this repo (and the installed package would need patching). Worth an
upstream issue.

### B. Re-arm by writing `/telegram-connect` into the daemon FIFO pipe

Same mechanism as `pi-agent-daemon.sh` at boot. Rejected: raw pipe
writing couples the switcher to daemon internals (per-PID pipe names),
and the command would execute in whatever session is active — the guard
could not run from the correct (new) runtime context. The
`sendUserMessage` re-dispatch from `withSession` achieves the same with
public API only.

### C. Immediate re-dispatch of `/telegram-connect` in `withSession`

Fails on timing: right after the switch the old lock is still
active-here (heartbeat ≤ 2 s old at the moment of suspend) with a
mismatched cwd for the new session's ctx; the non-forced acquire fails
with "Telegram bridge is active in another Pi instance" and follower
registration against the just-suspended leader bus. The connect must
wait until the lock is stale.

### D. Delayed re-dispatch after the staleness window (chosen)

In `withSession`, when the pre-switch ownership probe passed, schedule
the `/telegram-connect` re-dispatch after ~9 s (> 8 s staleness window).
A bounded, unref'd timer; the send is wrapped in try/catch and failures
go to the new runtime's local UI notify. The confirmation turn
(`followUp`) is unaffected — it is queued in the new session before the
timer fires and the transport for *outbound* messages is still functional
even while polling is suspended (only `getUpdates` was aborted).

## Serialization

`probeTelegramTransportOwnership(oldCwd)` runs **before**
`ctx.switchSession()` (the old session's cwd is only available there) and
captures its verdict; `withSession` only acts on the captured boolean.
The timer callback runs in the new runtime and only touches the
`withSession` context, so no stale-context hazard exists. The timer is
cleared defensively if a newer switch supersedes it (single-slot pending
re-arm; a re-arm is only meaningful once per session replacement).

## Risks / Trade-offs

- **9 s blind window**: inbound Telegram messages sent in the first ~9 s
  after a switch are not polled during the window. Telegram retains
  updates server-side for 24 h, so they are fetched once polling
  resumes — nothing is lost, only delayed.
- **Probe races**: a heartbeat could be >10 s old but the owner still
  live (clock skew, GC pause). The probe's 10 s freshness bound is
  looser than pi-telegram's 8 s staleness so a *passing* probe means the
  runtime was definitely alive at switch time; the delayed connect
  itself re-validates through pi-telegram's own acquire, so a wrong probe
  verdict cannot corrupt ownership — worst case the connect fails and
  logs locally.
- **The re-dispatched `/telegram-connect` produces no agent turn**
  (prompt-template commands run their handler directly), so it does not
  interfere with the confirmation follow-up turn queued in
  `withSession`, and it does not settle or wedge the Telegram dispatch
  queue (the queue was already reset by the session replacement).
