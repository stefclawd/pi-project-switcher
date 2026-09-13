# Design: offer-create-project-on-unknown

## Context

The unknown-project branch currently just warns. We add an optional
create-and-switch step before that warning. The switch itself is NOT
re-implemented — after successful creation, the folder exists and the
existing switch flow runs unchanged (it will take the first-session
fallback path since a new project has no stored session).

## Goals / Non-Goals

Goals:
- One confirmation before any folder creation — never silent mkdir.
- Works on dialog-capable surfaces (TUI, RPC-with-UI) via `ctx.ui.confirm`.
- Works on headless surfaces via explicit opt-in `/project <name>!`
  (no dialog → no blocking → no implicit creation).
- Strict name validation before mkdir (single path segment, not hidden,
  no traversal).
- Reuse the entire existing switch flow untouched.

Non-Goals:
- Creating nested paths (`/project a/b`) — rejected.
- Initializing git, README, or other scaffolding inside the new folder.
- Configurable "auto-create without asking" mode (explicit opt-in `!` is the
  headless equivalent).

## Decisions

1. **Confirmation mechanics:** call `ctx.ui.confirm("Create project?", …)`
   on surfaces where `ctx.hasUI` is true. `confirm()` returns
   `Promise<boolean>`; treat any thrown error / `false` as decline.
   The "dialog-capable" check is `ctx.hasUI` (documented as "true in TUI
   and RPC modes").
2. **Opt-in suffix:** `/project foo!` = create-if-missing without asking.
   Rationale: pi-telegram and other RPC flows may not surface confirm
   dialogs usefully; an explicit marker keeps headless use deterministic.
   Parsing: strip a trailing `!` from the name before validation; if the
   remaining name is unsafe, fall through to the plain warning.
3. **Safety validation order:** (a) strip `!`; (b) reject unsafe names
   (separator, `..`, absolute, leading dot) with the existing warning;
   (c) only then confirm/create. Unsafe names never reach a dialog.
4. **mkdir semantics:** `mkdirSync(path, { recursive: false })` — fails on
   existing file/dir, surfaces races; we catch and report. `recursive:
   false` is deliberate: the name was already validated to be a single
   segment, so any failure is a real error, not a missing parent.
5. **After creation:** notify `Created project folder` + run the normal
   switch (first-session path announces workdir + "first session in this
   project"). The creation notice is separate from the switch notice to
   keep the existing output contract intact.

## Risks / Trade-offs

- **RPC/Telegram confirm dialogs:** if the active surface doesn't render
  `ui.confirm` (returns immediately), the user could see a decline without
  having answered. Mitigation: the `!` opt-in exists precisely for that;
  docs mention it. (Behavior matches pi's documented dialog semantics.)
- **Name squatting / fat-finger:** the confirm dialog shows the exact
  absolute path that would be created.
- **Concurrent pi instances** could race the mkdir; `recursive:false` +
  error handling covers it.

## Migration Plan

Additive. Default for dialog surfaces changes from "warn only" to
"offer creation" — that is the requested UX change and the delta-spec
scenario "Unknown project, user declines" documents the unchanged
fallback for declines.
