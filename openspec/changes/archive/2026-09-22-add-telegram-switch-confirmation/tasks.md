# Tasks: add-telegram-switch-confirmation

## 1. Origin detection

- [x] 1.1 Extend the `input` handler: arm a switch flag when the
      Telegram-dispatched first line is `[telegram] /project <name>` (with
      arguments; attribute variants like `[telegram|thread:x]` allowed;
      pi-telegram context sections after a blank line ignored). Keep the
      existing bare-`/project` status flag arming unchanged.
- [x] 1.2 Share the TTL and session_start clearing between both flags.

## 2. Confirmation turn

- [x] 2.1 Build a confirmation prompt carrying the switch facts (project
      name, absolute workdir, git branch, session identity, previous
      project) and a pre-rendered `telegram_button` block (status button;
      switch-back button when a previous project exists).
- [x] 2.2 Restore path: when the switch flag is consumed, send the
      confirmation follow-up via the fresh `newCtx.sendUserMessage(...,
      { deliverAs: "followUp" })` inside `withSession`, after the existing
      local notify. Keep the local notify for non-Telegram surfaces.
- [x] 2.3 Fallback path (no stored session): send the confirmation prompt
      instead of (not in addition to) the generic announcement when the
      switch originated from Telegram; keep the generic announcement for
      native surfaces.
- [x] 2.4 Already-on-project and cancelled switch, Telegram origin: send a
      short follow-up so the chat always receives a reply.
- [x] 2.5 Never touch the stale old `pi`/`ctx` after `switchSession()` —
      all post-replacement work stays inside `withSession`.

## 3. Tests

- [x] 3.1 Input handler arms the switch flag for
      `[telegram] /project beta` (plain and attribute variants, with
      context sections); does not arm for native/interactive source.
- [x] 3.2 Restore-path Telegram switch: `withSession` context receives the
      confirmation `sendUserMessage` follow-up with the project name,
      workdir, and button block.
- [x] 3.3 Fallback-path Telegram switch: confirmation prompt sent, no
      generic announcement.
- [x] 3.4 Native switch (no flag): no confirmation turn, behavior
      unchanged (including the existing announcement on the fallback path).
- [x] 3.5 Flag TTL expiry and consumption-once semantics for the switch
      flag; cleared on session_start.
- [x] 3.6 Already-active and cancelled switches with Telegram origin send a
      short follow-up.

## 4. Docs & release

- [x] 4.1 README: document the Telegram switch confirmation and the button
      row.
- [x] 4.2 openspec: validate the change, apply it to the spec, archive it.
- [x] 4.3 Version bump + changelog, tests + typecheck green, commit and
      push.
