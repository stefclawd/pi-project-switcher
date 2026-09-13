# Design: add-switch-announcement-output

## Context

The switch handler has two notification paths (index.ts):

1. **Restored-session path** (`ctx.switchSession(targetSession)`):
   currently prints `Switched to <name> (session: <basename>)` + project path.
   The session file name is present but not the session id, and the wording
   does not say the session was restored.
2. **Fallback path** (no stored session / file gone): prints
   `Switched to <name> (was: <prev>)` + project path + branch, then sends a
   follow-up user message. It does not tell the user that this is the
   project's first session and that the current session simply continues.

## Goals / Non-Goals

Goals:
- Both paths print the absolute project working directory (already true —
  keep it uniform and explicit).
- Restored path: report session file name AND session id.
- Fallback path: report "first session in project X" + current session
  continues (with current session id/file where available).
- Keep it a pure output change — no logic, storage, or persistence changes.

Non-Goals:
- Changing what is stored in the session map.
- Printing notifications in any channel other than `ctx.ui.notify`.
- Announcing the switch to the LLM differently (follow-up message text is
  unchanged except where it already differs per path).

## Decisions

1. **Session id source:** after `switchSession()` succeeds, the fresh
   session's id is not directly reachable from the old command ctx (old ctx
   is stale). Derive the id from the session file name instead: pi session
   files are named `<ISO-timestamp>_<uuid>.jsonl`, so the basename already
   carries the id; print the basename (stable, human-readable) — and the
   session id where directly derivable. For the fallback path,
   `ctx.sessionManager.getSessionFile()` is still valid before any session
   replacement happens.
2. **"First session" definition:** the fallback path IS the first-session
   case from the user's perspective (nothing restorable existed). Word it
   as "First session in project <name>" plus "continuing current session".
3. **Wording (uniform shape):**
   - Restored: `Switched to <name> — session restored: <basename>` + `Workdir: <abs path>` (+ branch)
   - First: `Switched to <name> — first session in this project` + `Workdir: <abs path>` + `Continuing session: <basename>` (+ branch)

## Risks / Trade-offs

- Deriving identity from file names couples us to pi's session file naming
  convention. Mitigation: print the basename only as stable identity label;
  it is already what the restore path shows today.
- Stale-ctx pitfall after `switchSession()` (documented pi constraint): all
  reads of session state must happen BEFORE the switchSession call.

## Migration Plan

None needed — additive notification text only.
