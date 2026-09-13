# Tasks: add-switch-announcement-output

## 1. Restored-session path notification

- [ ] In `index.ts`, after a successful `switchSession(targetSession)`, extend the notify message to:
  - state that the session was restored for the project,
  - include the restored session file basename,
  - include the absolute project working directory (and branch if present).
- [ ] Read any session state needed BEFORE calling `ctx.switchSession` (stale-ctx constraint).

## 2. Fallback (first-session) path notification

- [ ] In `index.ts`, extend the fallback notify message to:
  - state "first session in this project",
  - include the current session file basename via
    `ctx.sessionManager.getSessionFile()` (valid on this path — no session
    replacement happens),
  - state that the current session continues under the new project,
  - include the absolute project working directory (and branch if present).

## 3. Tests

- [ ] Update/extend `test/extension.test.ts`:
  - restored-path notify contains "session restored" wording + basename + absolute project path,
  - fallback-path notify contains "first session" wording + absolute project path,
  - existing assertions updated for the new message shapes.
- [ ] `npx vitest run` green, `npx tsc --noEmit` clean.

## 4. Release

- [ ] Bump version to 0.4.0, commit, tag `v0.4.0`, push (GitHub Actions publishes via trusted publishing).
- [ ] Confirm npm `latest` + provenance attestations after the run.
