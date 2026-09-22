# Design: add-telegram-switch-confirmation

## Context

- The pi-telegram bridge never forwards slash commands; the companion
  pi-telegram-command-bridge re-dispatches them via
  `pi.sendUserMessage(text, { expandPromptTemplates: true })`. The raw
  Telegram dispatch (first line `[telegram] …`) fires as an `input` event
  with `source: "extension"` BEFORE the re-dispatch — the only reliable
  Telegram-origin signal. The existing status feature already uses this
  mechanism for bare `/project`.

- The command bridge schedules a settle prompt (a short turn so pi-telegram
  settles its queue and the reply reaches the chat) but **clears all
  pending settles on `session_shutdown`**, because a session-replacing
  command invalidates the captured `pi` (a stale timer firing on it used to
  crash the daemon). Its design comment explicitly states: "the switcher
  announces the switch from inside the replacement session." So the bridge
  deliberately leaves switch announcements to the switcher — the switcher
  just never implemented one for the restore path.

- `switchSession()` accepts a `withSession(ctx)` callback that runs with a
  fresh `ReplacedSessionContext` bound to the new session. That context
  extends `ExtensionCommandContext` and **adds**
  `sendUserMessage(content, { deliverAs: "steer" | "followUp" })`. This is
  the sanctioned way to act on the new session after replacement without
  touching stale objects — exactly what the existing in-`withSession`
  `notify` already does.

## Goals / Non-Goals

Goals:

- A Telegram-originated `/project <name>` always produces a visible
  confirmation reply in the Telegram chat, on both switch paths
  (session restored / same-session fallback).
- Confirmation content is deterministic (built by the extension), not
  model-invented: the prompt carries the facts and the exact reply shape.
- Native TUI/RPC behavior unchanged.

Non-Goals:

- No changes to pi-telegram or pi-telegram-command-bridge.
- No new session naming, map, or persistence semantics.
- Not making `/project` status more chatty on Telegram (already covered).

## Possible Solutions

### A. Settle-prompt from the old runtime after the switch

Send the confirmation follow-up from the OLD `pi` after `switchSession()`
returns. Rejected: the old runtime is invalidated by the session
replacement; the previous crash bug (2026-09-18) was exactly a stale
post-switch `pi` call. The API contract says post-switch work must run in
`withSession`.

### B. Command-bridge change: keep the settle prompt across session switches

Have the bridge send its generic settle prompt in the new session.
Rejected: the bridge cannot know the switch outcome, its prompt says
"command executed" with no switch facts, and it would produce a generic
model turn for every session-replacing command. The bridge's
responsibility boundary (deliberately established during the crash fix) is
queue settlement; user-facing switch messaging belongs to the switcher.

### C. Confirmation turn from the fresh `withSession` context (chosen)

Extend the existing Telegram-origin detection to `/project <name>`:

- `TELEGRAM_STATUS_RE` today matches only `[telegram] /project` with no
  arguments. A second regex (or one regex with an optional argument group)
  arms a **switch flag** when the dispatched first line is
  `[telegram] /project <args>`. The bare-status flag and the switch flag
  are armed from the same handler; both get the same TTL and are cleared on
  `session_start`.
- `switchToProject` consumes the switch flag. On Telegram origin:
  - **Restore path**: inside `withSession(newCtx)`, after the existing
    local `notify`, call
    `newCtx.sendUserMessage(confirmationPrompt, { deliverAs: "followUp" })`.
    The follow-up starts an agent turn in the new session; pi-telegram
    delivers the reply to the chat. The turn also settles any dispatch
    queue state pi-telegram kept across the replacement.
  - **Fallback path** (no stored session): the existing
    `pi.sendUserMessage` announcement is replaced by the same
    confirmation prompt when the flag says Telegram origin (the current
    announcement is aimed at the agent's working context, the confirmation
    prompt is aimed at the Telegram user — one turn satisfies both).
  - Already-on-project and cancelled switches send a short follow-up too,
    so the Telegram user is never left without a reply (same wedge-free
    settle reasoning as the bridge).
- Non-Telegram origin: behavior byte-identical to today.

## Decision

Solution C. It uses only sanctioned API surfaces (`ReplacedSessionContext`
follow-ups, existing input-event origin detection), keeps the
responsibility split established during the 2026-09-18 crash fix, and
requires no change to either other repo.

## Risks / Trade-offs

- One extra model turn per Telegram switch (cost ~1 short reply). Accepted:
    it is the only channel that reaches the Telegram user, and the settle
  prompt previously produced exactly one such turn for other commands.
- The confirmation prompt instructs a specific reply; a misbehaving model
  could add prose. Mitigated the same way as the status feature: the prompt
  carries the exact button block to copy verbatim.
- If the switch flag is consumed by a *different* command execution than
  the one the user dispatched (e.g. a raced TUI invocation within the TTL
  window), a native switch would produce a Telegram-looking confirmation
  turn. Bounded by the 30 s TTL, and the flag is only consumed by the
  next `/project <name>` execution — the same accepted risk profile as the
  existing status flag.

## Migration Plan

Single-repo change, no data migration. The change is fully backward
compatible: without the flag armed, all code paths behave exactly as
before. Deploy = pull + restart (user-initiated).

## Open Questions

- Should the confirmation include a "switch back to <previous>" button?
  Decided: yes when a previous project exists — it is one pre-rendered
  button cell and makes the flow conversational. No open question remains.
