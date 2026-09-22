# Proposal: fix-telegram-rearm-lock-handoff

## Why

The v0.8.0 Telegram re-arm (change `2026-09-22-rearm-telegram-after-session-switch`)
was verified live on 2026-09-22 21:51 and **does not work**: after a
Telegram-originated `/project fritop` switch, the delayed `/telegram-connect`
re-dispatch fired correctly (21:51:48, 9 s after the switch) but could not
re-acquire the transport. pi-telegram answered with an interactive takeover
confirmation that no one can answer in the headless daemon:

```
confirm: "move singleton lock here?
          from: pid 3614991, cwd /home/clawd/.pi-agent-daemon
          to: /home/clawd"
```

Root cause — two wrong assumptions in the v0.8.0 design:

1. **A same-pid lock never goes stale.** `getLockState()` checks
   `lock.pid === pid` (→ `active-here`) *before* the heartbeat staleness
   check. The 8 s staleness window only ever applies to *foreign* pids, so
   the connect handler always saw our own suspended runtime as
   `active-here`, never `stale`.
2. **Same-process takeover requires matching cwd even with force.**
   `canSupersedeSameProcessOwner()` demands `lock.cwd === ctx.cwd`; the
   restored project session's cwd differs from the daemon session's cwd
   that took the lock. Neither the non-forced nor the forced acquire can
   cross the mismatch — the confirm dialog is a dead end by construction.

## What Changes

Replace the delayed-connect re-arm with a **disconnect-before-switch** flow:

1. **Probe** (unchanged from v0.8.0): before the switch, read
   `~/.pi/agent/tmp/telegram/owners.json`; proceed only when the lock names
   this process, has a fresh heartbeat, and matches the old session's cwd.
2. **Release before replacement**: when the probe passes, the switcher —
   still running in the *old* (owning) runtime, before
   `ctx.switchSession()` — executes the `/telegram-disconnect` command via
   `pi.sendUserMessage("/telegram-disconnect", { expandPromptTemplates:
   true })`. Extension commands execute synchronously through pi's
   command-dispatch path, so by the time the call returns, pi-telegram has
   stopped polling and **released the lock** (`lock.release()` deletes the
   `owners.json` entry; it succeeds because the old runtime is the owner).
   No confirm dialog is raised (threaded mode is disabled).
3. **Immediate reconnect in `withSession`**: the fresh context re-dispatches
   `/telegram-connect`. With no lock present, the connect handler's acquire
   succeeds unconditionally — no staleness wait, no takeover dialog. Keep a
   short safety delay (~3 s, unref'd) so the release and session-teardown
   cleanup fully settle before the new runtime connects.

The ownership guard's semantics are unchanged: a session that did not own
the live transport never disconnects and never re-arms.

## Impact

- Specs: `project-switching` — MODIFIES requirement **Telegram Transport
  Re-arm After Session Switch** (release-before-replace replaces the
  staleness-delayed connect; scenarios updated).
- Code: `index.ts` — replace `scheduleTelegramRearm` delayed connect with
  pre-switch disconnect + short-delay connect; keep probe unchanged.
- Tests: probe tests unchanged; re-arm tests rewritten for the new
  sequence (disconnect sent before switchSession from the old runtime,
  connect sent from withSession after the delay).
- Docs: `README.md` — corrected mechanism description.
