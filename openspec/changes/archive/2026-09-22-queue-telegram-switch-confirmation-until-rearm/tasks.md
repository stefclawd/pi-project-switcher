# Tasks: queue-telegram-switch-confirmation-until-rearm

## 1. Rearm-state verification helper

- [x] 1.1 Add a read-only helper that reads
      `~/.pi/agent/tmp/telegram/state.json` (runtime snapshot) and
      `~/.pi/agent/tmp/telegram/owners.json` (lock heartbeat) and
      decides "transport re-armed here": polling active + lock entry for
      the current process with a fresh heartbeat. Paths injectable for
      tests.
- [x] 1.2 Add a bounded poll loop (short interval, 10 s bound after the
      connect dispatch) using the helper; returns
      `{ confirmed: true } | { confirmed: false, reason }`.

## 2. Bot-API warning fallback

- [x] 2.1 Add a fallback sender that reads bot token + allowed user id
      from `~/.pi/agent/telegram.json` and POSTs `sendMessage` (plain
      text) to `https://api.telegram.org/bot<token>/sendMessage`.
- [x] 2.2 Message text: switch happened (project named), but
      reconnecting the pi Telegram extension did not work — suggest
      reconnecting (/telegram-connect) or restarting the agent.
- [x] 2.3 Injectable for tests (module-level override hook); all errors
      journaled to the local UI, never thrown.

## 3. Combined re-arm + queued confirmation

- [x] 3.1 Replace `scheduleTelegramRearm` with a combined callback:
      after the safety delay, dispatch `/telegram-connect`, then run the
      rearm-state poll, then dispatch the confirmation follow-up from
      the captured `withSession` context.
- [x] 3.2 On poll timeout or connect dispatch failure: send the Bot-API
      warning (2.1), journal the reason locally, do NOT dispatch the
      follow-up turn.
- [x] 3.3 On the restore path WITHOUT transport transition (probe
      failed) and on the fallback (same-session) path: confirmation
      follow-up is dispatched immediately as today.
- [x] 3.4 Keep the single pending slot with supersession semantics.
- [x] 3.5 Wrap every step in try/catch; journal to the local UI via the
      captured context (guarded); never let an error escape the timer.

## 4. Tests

- [x] 4.1 Confirmation NOT sent from withSession when the transport was
      released; sent only after verified re-arm (fake timers + fake
      state.json).
- [x] 4.2 Re-arm never confirms within the bound → Bot-API warning sent
      (injected fake sender), no follow-up turn, failure journaled.
- [x] 4.3 Connect dispatch throws → Bot-API warning, no follow-up.
- [x] 4.4 Bot-API sender itself fails → journaled, nothing thrown.
- [x] 4.5 No transport transition (probe fail, native, fallback path) →
      immediate confirmation, no poll, no Bot-API usage.
- [x] 4.6 Supersession: second switch replaces the pending callback;
      exactly one re-arm + one confirmation from the current runtime.
- [x] 4.7 Cancelled-after-release switch: reconnect + immediate
      cancellation follow-up (existing behavior), no queued
      confirmation.
- [x] 4.8 Existing re-arm/confirmation suites updated and green.

## 5. Docs & release

- [x] 5.1 README: document the sequenced confirmation, the 10 s bound,
      and the Bot-API warning fallback.
- [x] 5.2 openspec: validate, apply to specs, archive.
- [x] 5.3 Version bump 0.9.0, tests + typecheck green, commit, push, tag,
      sync daemon checkout.
