# pi-project-switcher

A [pi coding agent](https://github.com/earendil-works/pi) extension to switch between projects that live as direct subdirectories of a configurable base directory.

## What it does

- **`/project`** — list all projects (direct subdirectories of the base dir) with git branch info, mark the active one
- **`/project <name>`** — switch the active project:
  - persists across reloads (session entry)
  - sets the session display name
  - injects the project path into every agent turn's system prompt, so file operations default to the active project
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
pi install git:github.com/stefclawd/pi-project-switcher
```

Or from a local checkout:

```bash
pi install ./pi-project-switcher
```

## Development

Single-file TypeScript extension (`index.ts`), loaded directly by pi via jiti — no build step. Spec lives in `openspec/specs/project-switching/`.

```bash
# Run once without installing
pi -e ./index.ts

# Verify
pi -p -e ./index.ts "/project"
```

## License

MIT
