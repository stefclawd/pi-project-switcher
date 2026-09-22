# Proposal: queue-telegram-switch-confirmation-until-rearm

## Why

After a Telegram-originated `/project <name>` switch that replaces the
session, the switch confirmation follow-up turn is dispatched from
`withSession` immediately — before the Telegram transport has re-armed in
the new runtime. The pre-switch `/telegram-disconnect` (v0.8.1 transport
transition) released the transport lock and stopped polling; the new
runtime only re-acquires the lock when the delayed `/telegram-connect`
(3 s safety delay) completes and pi-telegram finishes initializing
(observable as a new `instanceId` with `pollingActive: true` in
`~/.pi/agent/tmp/telegram/state.json`).

The confirmation turn's reply produced inside that dead window is dropped
silently: pi-telegram's outbound delivery for follow-up turns is gated by
session-context ownership, which is false until the re-arm finishes.
Observed 2026-09-22 22:15 (switch → fritop): the confirmation turn
completed at 22:15:34, the transport re-armed at 22:15:37 — the reply
never reached the chat. The outcome is a coin flip on model latency.

## What Changes

1. **Queue the confirmation until the re-arm is verified.** When a
   Telegram-originated session-replacing switch succeeded and the
   transport was released before the switch, `withSession` no longer
   sends the confirmation follow-up immediately. Instead it schedules a
   single combined callback (superseding any pending one) that:
   - re-arms the transport (`/telegram-connect` after the existing short
     safety delay),
   - then polls pi-telegram's `state.json` (and `owners.json` heartbeat)
     until the re-arm is confirmed: new `instanceId` for the current
     process, `runtime.pollingActive === true`, and `lockState`
     indicating active ownership,
   - and only then dispatches the confirmation follow-up turn from the
     fresh context — guaranteed to be delivered because the transport
     owns the session context again.

2. **Bounded wait, 10 seconds.** The re-arm wait is bounded at 10 s
   (from the end of the safety delay, i.e. the connect dispatch), polled
   at short intervals.

3. **Direct Bot-API warning fallback.** If the re-arm is not confirmed
   within the bound, the confirmation is NOT sent through the follow-up
   turn (it would be dropped anyway). Instead the switcher sends one
   plain warning directly through the Telegram Bot API
   (`https://api.telegram.org/bot<token>/sendMessage`, token read from
   `~/.pi/agent/telegram.json`, allowed user id from the same file):
   "⚠️ Switched to <project>, but reconnecting the pi Telegram extension
   did not work — Telegram commands may not reach the agent until it
   reconnects (/telegram-connect)." The bot-token read and the HTTPS send
   are read-only with respect to pi-telegram's lock/state files and are
   fully decoupled from the transport. The failure is also journaled to
   the local UI.

4. **No re-arm transition (probe failed, native switch, fallback path):
   unchanged behavior.** When no transport transition occurred, the
   confirmation turn is dispatched immediately as today — the transport
   was never released, so there is no dead window.

5. **Failure isolation.** Any error inside the queued callback (connect
   dispatch, poll, confirmation dispatch, Bot-API send) is caught,
   journaled to the local UI, and never propagates — the switch result is
   never affected, and an uncaught timer callback can never kill the
   daemon.

## Impact

- Specs: `project-switching` — MODIFIES **Telegram Transport Re-arm After
  Session Switch** (re-arm and confirmation are sequenced: connect →
  verified polling → confirmation) and MODIFIES **Telegram Switch
  Confirmation** (confirmation waits for the re-arm; adds the Bot-API
  warning fallback).
- Code: `index.ts` — replace `scheduleTelegramRearm` with a combined
  re-arm + rearm-wait + confirmation (or fallback) callback; add
  `state.json` polling helper, Bot-API fallback sender, injectable for
  tests.
- Tests: `test/extension.test.ts` — confirmation delayed until verified
  re-arm; confirmation sent immediately without transport transition;
  Bot-API fallback after 10 s without re-arm; supersession; failure
  isolation.
- Docs: `README.md`.
- No changes to pi-telegram, the command bridge, or lock/state file
  formats (all reads are read-only; the Bot-API fallback uses the public
  HTTP API).
