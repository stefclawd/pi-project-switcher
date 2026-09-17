# Proposal: surface-adaptive-project-status

## Why

`/project` without arguments currently prints the project list only to the
local UI channel (`ctx.ui.notify`):

- In a native TUI session the user reads the list and must retype
  `/project <name>` to switch — an unnecessary round trip.
- Via the pi-telegram bridge the list never reaches Telegram at all: the
  command executes natively in the RPC daemon, its output lands in the daemon
  journal, and the bridge's settle turn answers the chat with a bare
  `✅ /project executed` instead of the list.

The maintainer now runs pi both natively (TUI) and through the Telegram
bridge and wants the status output to fit each surface.

## What Changes

`/project` (no arguments) becomes surface-adaptive:

1. **Native TUI** — a selection dialog (`ctx.ui.select`) lists all discovered
   projects; confirming a choice runs the exact `/project <name>` switch flow;
   dismissing the dialog falls back to today's plain text list.
2. **Native non-TUI surfaces** (rpc/json/print without Telegram origin) —
   unchanged plain text list via `ctx.ui.notify`.
3. **Telegram-originated** — the switcher sends a follow-up turn carrying the
   authoritative project list plus a pre-rendered `telegram_button` block;
   the reply delivered to Telegram shows one tappable button per project.
   Clicking a button queues the prompt `/project <name>`, which the command
   bridge executes natively — identical to typing `/project <name>` via
   Telegram (session restore, announcements, and safety rules unchanged).

Detection is self-contained in the switcher: an `input`-event handler
recognizes the raw Telegram dispatch (first line `[telegram] /project`,
attribute variants like `[telegram|thread:x]` allowed) and arms a
short-lived flag that the next status execution consumes.

## Impact

- Specs: `project-switching` — adds requirement **Surface-Adaptive Status
  Output** (refines, does not contradict, the existing "Listing projects"
  scenario of Dynamic Project Discovery).
- Code: `index.ts` — new `input` handler + flag, status branch rework,
  switch flow extracted into a shared function.
- Tests: `test/extension.test.ts` — new cases for all three surfaces, flag
  arming/consumption/expiry, and button-markup content.
- Docs: `README.md` (status behavior), `openspec/config.yaml` (stale
  maintainer note "Telegram visibility is NOT relevant" is updated).
- No changes to: session map, config precedence, persistence, switching
  semantics, or the pi-telegram-command-bridge repo.
