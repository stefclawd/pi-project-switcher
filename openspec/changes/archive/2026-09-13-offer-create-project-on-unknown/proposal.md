# Proposal: offer-create-project-on-unknown

## Why

Today `/project <name>` on a non-existent directory ends in a dead end:
`Unknown project: "xyz". Available: …`. For the actual use case — "start
working on something new" — the user must leave the agent, `mkdir
~/dev/xyz`, and re-run the command. The extension knows the base dir, has
filesystem access, and already has a full switch flow; creating one empty
directory is a natural completion of the command.

## What Changes

When `/project <name>` targets a name that does not exist under the base
directory, the extension offers to create the project folder and switch to
it:

- Ask the user for confirmation (dialog-capable surfaces: `ctx.ui.confirm`;
  non-dialog surfaces: explicit opt-in command form `/project <name>!`,
  described below — never create silently).
- On confirm: `mkdir` the folder, then run the normal first-session switch
  flow (announce, context injection, session naming — same as switching to
  an empty/existing project today).
- On decline: behave exactly like today (warning, no state change).
- Path-safety: reject names containing `/`, `\`, `..`, absolute paths, or
  names starting with `.` (hidden) — only a single plain directory name may
  be created.
- If the mkdir fails (permissions, existing file of that name, race), show
  the error and keep state unchanged.

## Can our extension do this? (feasibility — confirmed)

Yes:
- Extensions run with full filesystem access (`node:fs` is already imported
  for discovery).
- `ctx.ui.confirm(title, message)` exists on `ExtensionUIContext` (verified
  against pi 0.85.1 types) and returns a real user decision on dialog-
  capable surfaces (TUI/RPC with `hasUI`/dialog capability).
- `ctx.hasUI` lets us detect non-dialog surfaces; there we require the
  explicit `!` opt-in form so scripted/RPC contexts never get a blocking
  dialog and never create folders implicitly.

## Impact

- Affected specs: `project-switching` (Requirement: Switching Projects —
  the "Unknown project" scenario gains an offer-or-create path)
- Affected code: `index.ts` (command handler: validation branch, mkdir +
  switch reuse)
- No storage/session-map changes (a freshly created project trivially has
  no stored session → first-session fallback path applies).
