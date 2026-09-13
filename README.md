# pi-project-switcher

A [pi coding agent](https://github.com/earendil-works/pi) extension to switch between projects that live as direct subdirectories of a configurable base directory.

## What it does

- **`/project`** — list all projects (direct subdirectories of the base dir) with git branch info, mark the active one
- **`/project <name>`** — switch the active project:
  - restores the project's last session if one is stored (see below)
  - persists across reloads (session entry)
  - sets the session display name
  - injects the project path into every agent turn's system prompt, so file operations default to the active project
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
npm test        # vitest (17 tests)
npm run typecheck

# Run once without installing
pi -e ./index.ts

# Verify
pi -p -e ./index.ts "/project"
```

## License

MIT
