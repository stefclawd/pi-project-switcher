# Tasks: surface-adaptive-project-status

## 1. Origin detection (input handler + flag)

- [x] Add `TELEGRAM_PREFIX_RE` (first line `[telegram]` incl. attribute
      variants) and a module-level `telegramStatusFlag: number | null`
      (armed-at timestamp) with `TELEGRAM_FLAG_TTL_MS = 30_000`.
- [x] Register an `input` handler: on `source === "extension"` and first
      line matching the telegram tag followed by bare `/project` (no
      arguments), arm the flag; return `continue` always (never transform
      or handle — the bridge owns re-dispatch).
- [x] Clear the flag on `session_start`.

## 2. Shared switch flow extraction

- [x] Extract the body of the `/project <name>` argument handling into an
      internal `switchToProject(name, ctx)` used by both the argument path
      and the new TUI selection path. No behavior change (existing tests
      must pass unmodified).

## 3. Status branch rework

- [x] Consume the flag (armed and not expired) → Telegram path:
      `ctx.ui.notify` plain list as today, then `await ctx.waitForIdle()`,
      then `pi.sendUserMessage(telegramStatusPrompt, { deliverAs: "followUp" })`.
- [x] Build `telegramStatusPrompt` from discovered projects: plain list
      lines, active-first with marker, pre-rendered
      ```telegram_button fenced block with one `{📁 name|/project name}`
      cell per project (omit the button cell for names containing `{`, `}`,
      `|`, backslash, backtick, or newline — plain list text only), and a
      strict instruction to reply with the list plus the block verbatim and
      add nothing else.
- [x] Else if `ctx.mode === "tui"`: `ctx.ui.select("Switch project", …)`;
      on choice call `switchToProject(choice, ctx)`; on dismiss/`undefined`
      fall back to plain list.
- [x] Else: plain list via `ctx.ui.notify` (unchanged).
- [x] No-projects case: warning as today on all surfaces; never a select,
      follow-up, or buttons.

## 4. Tests

- [x] Telegram flag arming: input event with first line
      `[telegram] /project` arms; `[telegram] /project foo` does not;
      `[telegram|thread:x] /project` arms; `[telegram] /project\n\n[time] …`
      arms (arg-less only).
- [x] Telegram status execution: consumed flag → notify list + one
      `sendUserMessage` follow-up whose content contains the project list,
      a `telegram_button` block, one button cell per project, and
      `/project <name>` prompts; flag cleared after consumption.
- [x] Flag expiry: armed flag older than TTL does not trigger the
      Telegram path.
- [x] Flag cleared on session_start.
- [x] Unsafe name: project named `a{b` appears in list text without a
      button cell for it.
- [x] README: document the three surface behaviors of bare `/project` and
      note that the switcher must be loaded before the command bridge
      (package order) for Telegram button output to work.
- [x] TUI: mode "tui" + choice → `switchToProject` runs (entry appended,
      session name set, notify switch message); dismiss → plain list notify,
      no state change.
- [x] RPC (mode "rpc", no flag): plain list only, no select, no
      `sendUserMessage`.
- [x] No projects on telegram-flag path: warning, no follow-up.
- [x] `npx vitest run` green, `npx tsc --noEmit` clean.

## 5. Docs

- [x] README: document the three surface behaviors of bare `/project`
      (see task 4 note) — no separate doc change beyond that.
- [x] `openspec/config.yaml`: replace the stale maintainer note
      "Telegram visibility is NOT relevant" with the updated context
      (TUI + Telegram both targets).

## 6. Release

- [ ] After successful `openspec archive`: bump version to 0.6.0, commit,
      tag `v0.6.0`, push (GitHub Actions publishes via trusted publishing).
- [ ] Confirm npm `latest` + provenance after the run.
- [ ] Remind the maintainer to restart pi-agent so the installed
      `git:` package updates (they trigger the restart themselves).
