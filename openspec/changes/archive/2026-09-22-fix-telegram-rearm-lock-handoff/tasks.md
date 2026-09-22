# Tasks: fix-telegram-rearm-lock-handoff

## 1. Implementation

- [x] 1.1 In `switchToProject` (restore path), when the probe passes and
      before `ctx.switchSession()`: execute the release via
      `pi.sendUserMessage("/telegram-disconnect", { expandPromptTemplates:
      true })` wrapped in try/catch (a failure aborts the re-arm attempt
      but never the switch itself).
- [x] 1.2 Replace the 9 s re-arm delay with a ~3 s safety delay for the
      `/telegram-connect` re-dispatch from `withSession` (single-slot
      timer, unref'd, try/catch, local-UI-only failure reporting).
- [x] 1.3 Keep `probeTelegramTransportOwnership` and its constants
      unchanged; keep all no-re-arm guards (native, cancelled, fallback,
      probe failure).

## 2. Tests

- [x] 2.1 Probe verdict tests keep passing unchanged.
- [x] 2.2 Restore-path switch with passing probe: `/telegram-disconnect`
      is sent from the OLD runtime BEFORE `switchSession` is invoked.
- [x] 2.3 Same flow: `/telegram-connect` is re-dispatched from the
      withSession context after the (fake-timer advanced) delay.
- [x] 2.4 Probe failure / native / cancelled: no disconnect, no connect.
- [x] 2.5 Disconnect throwing does not break the switch.
- [x] 2.6 New schedule supersedes a pending connect timer (single fire).

## 3. Docs & release

- [x] 3.1 README: correct the mechanism description
      (disconnect-before-switch + short-delay connect).
- [ ] 3.2 openspec: validate, apply to spec, archive; version bump 0.8.1,
      changelog, tests + typecheck green, commit, push, tag, sync daemon
      checkout.
