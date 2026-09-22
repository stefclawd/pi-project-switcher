# Proposal: add-telegram-switch-confirmation

## Why

When `/project <name>` is dispatched from the Telegram bridge (typed command
or a status-list button tap), the switch executes but **the Telegram user
receives no confirmation**: the "Switched to …" success notification goes to
the local UI channel only (`ctx.ui.notify`), which in the RPC daemon lands
in the journal — invisible on the phone. The user cannot tell whether the
switch worked and must run `/project` again to check.

Observed 2026-09-22 (daemon log, `/project pi-project-switcher` via button):

- `entry_appended` project-switcher-state → OK
- `notify "Switched to pi-project-switcher — session restored: …"` → local UI only
- **no `agent_start` / no turn afterwards** — nothing is delivered to Telegram

This is a fault in **pi-project-switcher**, not in the command bridge: the
switch-to-session path of `/project <name>` never starts the confirmation
follow-up turn. (The command bridge's settle prompt is intentionally
suppressed for session-replacing commands — pi-telegram resets its queue on
session replacement, and the switcher is responsible for the announcement.)

Two gaps in the current code:

1. **Telegram origin is not detected for switches.** The `input` handler only
   arms a flag for bare `[telegram] /project` status requests
   (`TELEGRAM_STATUS_RE` matches `/project` with **no arguments**); a
   Telegram-originated `/project <name>` re-dispatched by the command bridge
   is indistinguishable from a native TUI invocation, so the switch flow
   never learns the command came from Telegram.
2. **No confirmation turn on the restored-session path.** When the target
   project has a stored session, the switch replaces the session and
   deliberately never sends a follow-up (the old `pi`/`ctx` are stale), so
   no agent turn runs that could reply into the Telegram chat.

The no-stored-session fallback path already sends a follow-up announcement
via `pi.sendUserMessage` — but that path is unreachable from Telegram in
practice (pi-telegram requires a mapped session file), and the prompt is
directed at the agent rather than at the Telegram user.

## What Changes

1. **Telegram-origin detection for switches**: the `input` handler also arms
   a flag when the Telegram-dispatched first line is `[telegram] /project
   <name>` (with arguments). The switch flow consumes this flag and knows it
   was invoked from Telegram.
2. **Confirmation turn on every Telegram-originated switch**: after a
   successful switch — including the session-restore path — the switcher
   starts a follow-up turn in the *new* runtime whose prompt carries the
   switch facts (project, path, branch, session identity, previous project)
   and instructs the reply to be a one-to-two-line Telegram confirmation
   (with a compact `telegram_button` row to switch back / show status).
   For the session-restore path this uses the fresh `ReplacedSessionContext`
   (`sendUserMessage` available inside `withSession`), so no stale context is
   touched.
3. The plain local notification (workdir + session identity) is kept for
   non-Telegram surfaces, unchanged.

## Impact

- Specs: `project-switching` — adds requirement **Telegram Switch
  Confirmation**; modifies **Switch Output Includes Working Directory and
  Session Identity** (adds the Telegram scenario) and **Telegram flag is
  bounded** (flag now also armed for switches).
- Code: `index.ts` — input-handler regex covers `/project <name>`, flag
  consumption in `switchToProject`, confirmation-turn builder shared by both
  switch paths.
- Tests: `test/extension.test.ts` — flag arming for switches, confirmation
  turn content on both paths, no confirmation on native surfaces.
- Docs: `README.md` documents the Telegram switch confirmation.
- No changes to: session map, config precedence, persistence, switching
  semantics, or the pi-telegram-command-bridge repo.
