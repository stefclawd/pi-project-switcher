# pi-project-switcher

A [pi coding agent](https://github.com/earendil-works/pi) extension to switch between projects that live as direct subdirectories of a configurable base directory.

## What it does

- **`/project`** — list all projects (direct subdirectories of the base dir) with git branch info, mark the active one. The output adapts to the surface:
  - **native TUI**: a selection dialog; picking a project switches to it (dismissing shows the plain list)
  - **Telegram bridge**: the reply in the chat shows one tappable button per project; clicking a button is exactly like typing `/project <name>`
  - **other surfaces** (rpc/json/print): plain text list
  - Note: for the Telegram buttons to work, this extension must be loaded **before** `pi-telegram-command-bridge` (package order in `~/.pi/agent/settings.json`) — the switcher needs to see the raw `[telegram] /project` dispatch before the bridge re-dispatches it.
- **`/project <name>`** — switch the active project:
  - restores the project's last session if one is stored (see below)
  - persists across reloads (session entry)
  - sets the session display name
  - injects the project path into every agent turn's system prompt, so file operations default to the active project
  - **via the Telegram bridge**: the switch is confirmed in the chat — a short reply with the project, working directory, and session identity, plus buttons (project list, and switch back to the previous project). The confirmation is sent from the new session runtime, so it also works when the switch restores a stored session. No-switch outcomes (already active, cancelled, unknown) are answered in the chat too. When the switch released the Telegram transport (see below), the confirmation is **queued until the transport has verifiably re-armed** (fresh same-pid lock + active polling in `~/.pi/agent/tmp/telegram/state.json`, polled for up to 10 s) — a reply produced while the transport is down would be silently dropped. If the re-arm is not confirmed in time, the switcher instead sends a plain warning directly through the Telegram Bot API (token and chat id from `~/.pi/agent/telegram.json`): the switch happened, but the Telegram extension did not reconnect.
  - **Telegram transport re-arm**: a session-replacing switch from the Telegram bridge loses the bridge's transport: pi-telegram stands down on session shutdown, and its reconnect cannot take over the lock across the restored session's different cwd (same-pid locks never go stale; same-process takeover requires matching cwd). The switcher therefore transitions the transport across the switch itself: before the session switch it executes `/telegram-disconnect` (which releases pi-telegram's lock), and after the switch it re-executes `/telegram-connect` from the new session (~3 s delay) — but **only** when the session being left provably owned the connected transport: pi-telegram's lock (`~/.pi/agent/tmp/telegram/owners.json`) must name this process with a fresh heartbeat and a cwd matching the old session. A cancelled switch reconnects immediately. Native switches and switches from sessions that didn't own the bot never touch the transport. The lock file is only read, never modified.
  - **if the project doesn't exist yet**, offers to create the folder and switch to it (confirmation dialog on dialog-capable surfaces; use `/project <name>!` to skip the dialog — e.g. on headless/RPC surfaces). Unsafe names (path segments, `..`, hidden, absolute) are never created.
- **Session restore** — a machine-local map (`~/.pi/agent/project-switcher-sessions.json`) remembers the most recent session per project. Switching projects returns you to that project's last session; if none exists (or the file is gone), the switch happens in the current session.
- **Auto-detection** — if pi starts inside `~/dev/<project>`, that project is active automatically

Every direct subdirectory of the base directory counts as a project. **Git is not required.** Hidden directories are ignored.

## Configuration

Precedence (first wins):

1. Settings file `~/.pi/agent/project-switcher.json`:
   ```json
   { "baseDir": "/home/you/dev" }
   ```
2. Environment variable `PI_PROJECT_SWITCHER_BASE`
3. Default: `~/dev`

## Install

```bash
pi install npm:pi-project-switcher
```

Or from git:

```bash
pi install git:github.com/stefclawd/pi-project-switcher
```

Or from a local checkout:

```bash
pi install ./pi-project-switcher
```

## Development

Single-file TypeScript extension (`index.ts`), loaded directly by pi via jiti — no build step. Spec lives in `openspec/specs/project-switching/`.

```bash
npm install
npm test        # vitest (45 tests)
npm run typecheck

# Run once without installing
pi -e ./index.ts

# Verify
pi -p -e ./index.ts "/project"
```

## License

MIT
