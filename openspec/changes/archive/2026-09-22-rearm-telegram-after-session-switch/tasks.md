# Tasks: rearm-telegram-after-session-switch

## 1. Ownership probe

- [x] 1.1 Add `probeTelegramTransportOwnership(oldCwd: string): boolean`:
      read `~/.pi/agent/tmp/telegram/owners.json` (best-effort; false on
      missing/malformed file). Returns true iff a `default` (or any)
      entry exists with `pid === process.pid`, fresh heartbeat
      (`Date.now() - heartbeatMs <= 10_000`), and (`cwd === oldCwd` or
      `cwd` absent). Read-only: never write the file.
- [x] 1.2 Call the probe in `switchToProject` on the session-replacing
      (restore) path, **before** `ctx.switchSession()`, using the old
      session's cwd (`ctx.cwd`), only when the Telegram-origin flag was
      consumed. Capture the boolean for use inside `withSession`.

## 2. Delayed re-arm

- [x] 2.1 In `withSession` of the restore path, when the probe passed and
      the switch succeeded, schedule a single bounded timer (~9 s,
      `unref()`'d) that calls
      `newCtx.sendUserMessage("/telegram-connect", { expandPromptTemplates: true })`
      wrapped in try/catch; on failure notify the local UI (never throw
      from `withSession` or the timer).
- [x] 2.2 Single pending slot: scheduling a new re-arm cancels a
      not-yet-fired previous one; the slot is cleared before it fires.
- [x] 2.3 No re-arm when: the probe failed (foreign pid, stale
      heartbeat, cwd mismatch, no file), the switch was cancelled, the
      switch is the same-session fallback, or the origin was not
      Telegram.

## 3. Tests

- [x] 3.1 Probe: returns true for fresh same-pid same-cwd lock; false
      for foreign pid; false for stale heartbeat; false for cwd
      mismatch; false for missing/malformed file; true when cwd absent
      in the lock.
- [x] 3.2 Restore-path Telegram switch with passing probe: the re-dispatch
      `/telegram-connect` is sent from the withSession context with
      `expandPromptTemplates: true` after the delay (fake timers).
- [x] 3.3 Probe failure: no re-dispatch scheduled.
- [x] 3.4 Native switch (no Telegram flag): probe not consulted, no
      re-dispatch.
- [x] 3.5 Cancelled switch: no re-dispatch.
- [x] 3.6 New re-arm scheduling supersedes a pending one; timer fires
      exactly once.

## 4. Docs & release

- [x] 4.1 README: document the automatic Telegram re-arm and its guard.
- [ ] 4.2 openspec: validate, apply change to the spec, archive.
- [ ] 4.3 Version bump + changelog, tests + typecheck green, commit and
      push.
