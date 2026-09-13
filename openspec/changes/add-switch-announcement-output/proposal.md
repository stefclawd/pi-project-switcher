# Proposal: add-switch-announcement-output

## Why

When the user switches projects with `/project <name>`, the extension already
notifies about the new active project, but the notification does not
consistently surface the two pieces of information the user most needs to
orient themselves after the switch:

1. **The working directory** they now operate in (the project path).
2. **The session identity** they landed in (restored session file/id, or the
   fact that this is the project's first session, in which case no session
   switch happens and the current session continues under the new project).

The session-restore feature (v0.3.x) distinguishes two switch paths —
restoring a stored session vs. same-session fallback — and the notification
text already differs per path, but neither path reports the session id, and
the "first session in this project" case is not explicitly announced as such.
This makes it hard to tell, from the command output alone, where the agent
context now lives.

## What Changes

Extend the `/project <name>` switch notifications (both paths) to always
report:

- the **project working directory** (already partially present — make it
  explicit and uniform), and
- the **session identity** after the switch:
  - restored path: the session **file name and/or session id** of the
    restored session,
  - fallback path (no stored session / first session for that project):
    an explicit message that this is the **first session in this project**
    and the current session continues under the new project.

No behavioral change to switching itself — this is a notification/output
enhancement only.

## Impact

- Affected specs: `project-switching` (Requirement: Switching Projects,
  Requirement: Session Restore on Project Switch)
- Affected code: `index.ts` (command handler notification strings)
- No config, storage, or persistence changes.
