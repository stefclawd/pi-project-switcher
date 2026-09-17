# Design: surface-adaptive-project-status

## Context

pi runs for the maintainer in two relevant configurations:

1. **Native TUI** (`ctx.mode === "tui"`, source of prompts `"interactive"`).
2. **Headless daemon (RPC)** behind `@llblab/pi-telegram`, with
   `pi-telegram-command-bridge` re-dispatching Telegram commands. Prompts
   dispatched from the Telegram queue arrive via
   `AgentSession.sendUserMessage()` with `source: "extension"` (hardcoded in
   pi core) and text prefixed `[telegram] …`; the bridge then re-dispatches
   the bare `/project` line so `prompt()` executes it as an extension command.

Facts driving the design (all verified against pi 0.85.1 core and
@llblab/pi-telegram 0.x sources):

- `emitInput` (extension runner) fires for every prompt **before**
  skill/template expansion, chains `transform` results across extensions, and
  `handled` short-circuits. Extension order follows package order; the
  switcher (`git:github.com/stefclawd/pi-project-switcher`) is listed before
  the bridge (`../../dev/pi-telegram-command-bridge`) in the maintainer's
  settings — the switcher's `input` handler therefore sees the raw
  `[telegram] /project` dispatch before the bridge re-dispatches it. This
  ordering is an explicit assumption (documented in the README): if the
  bridge were listed first, its `handled` result would short-circuit the
  chain and arming would silently degrade to the plain-list path.
- Telegram buttons are not a tool call: they are `telegram_button` markup in
  the assistant's reply text. A switcher-internal deterministic
  `ctx.ui.notify` can therefore never surface buttons in the chat; only an
  assistant turn whose reply contains the markup can.
- Button clicks queue an ordinary prompt (`[telegram] /project abc`), which
  the existing command bridge already executes natively. "Click behaves like
  typing the command" holds with zero bridge changes.
- `ExtensionCommandContext.ui.select(title, options)` exists in TUI mode and
  resolves to the user's choice (`undefined` on dismiss/abort).
- The bridge's settle mechanism watches for `agent_start` after a bridged
  command; a follow-up turn started by the switcher settles the Telegram
  queue exactly like the bridge's own settle prompt, but with useful content.

## Goals / Non-Goals

Goals:

- `/project` status output adapts to the surface it is used from.
- TUI gets an interactive picker that reuses the full switch flow.
- Telegram gets the authoritative list in-chat, with one button per project;
  button prompt is exactly `/project <name>`.
- No pi-telegram or pi-telegram-command-bridge changes.
- Switch semantics (restore, announcements, `!` opt-in, name safety) are
  shared 1:1 between typed and button-initiated switches.

Non-Goals:

- Changing `/project <name>` behavior in any way.
- Telegram inline-editing of the status message or callback-driven in-place
  switching (buttons are prompt buttons, not Generative App bindings).
- Supporting other chat surfaces (Discord, Slack) — pattern is
  Telegram-specific markup by design.
- Fixing the bridge's generic settle prompt for other commands.

## Decisions

1. **Telegram detection via raw `input` event.** The switcher registers an
   `input` handler. When it sees `source === "extension"` and the first line
   matches `^\[telegram(?:\|[^\]]*)?\]\s*/project\s*$` (only `/project` with
   no arguments — attribute variants `[telegram|thread:…]`,
   `[telegram|from-thread:…]` allowed), it arms a module-level flag with a
   short TTL (30 s). The status branch of the command handler consumes and
   clears the flag. The regex deliberately ignores anything after a newline
   (pi-telegram appends `[time]` and other context sections after a blank
   line).
   - Why not `ctx.mode === "rpc"` alone: RPC is also used by non-Telegram
     tooling; and TUI sessions never carry the `[telegram]` tag.
   - Why not inspecting the bridge's re-dispatch: the re-dispatched text
     (`/project`, `expandPromptTemplates: true`) is indistinguishable from a
     native TUI invocation, so the only reliable origin signal is the raw
     first dispatch.

2. **Flag, not synchronous coupling.** The input event fires before the
   command check in `prompt()`; the flag decouples "where this came from"
   from "where it is handled". TTL bounds the window so a later, unrelated
   native `/project` (e.g. the user runs the command again in a TUI that
   shares the process — impossible today, but cheap to guard) cannot consume
   a stale flag. The flag is cleared on consumption, `session_start`
   (session switches reset it), and expiry.

3. **Telegram path = follow-up turn with authoritative content.** When the
   status branch consumes an armed flag, it (a) still emits the plain
   `ctx.ui.notify` list (local surface parity), and (b) after
   `ctx.waitForIdle()` sends
   `pi.sendUserMessage(telegramStatusPrompt, { deliverAs: "followUp" })`.
   The prompt embeds the discovered projects (one per line) and instructs
   the agent to reply in-chat with a compact list plus one
   `telegram_button` row per project (`{📁 <name>|/project <name>}` in a
   fenced ```telegram_button block, active project first and marked).
   The agent turn this starts also settles the bridge queue, so the
   bridge's own settle timer fires a harmless duplicate confirmation at
   most (its `agent_start` handler clears the pending settle first —
   verified behavior).
   - The buttons carry the literal command text as prompt; the bridge
     re-dispatches `/project <name>` natively. Identical semantics.
   - 8-button native-row limit: the prompt instructs chunking into rows of
     up to 8 when there are more projects; list sizes here are < 12.

4. **TUI path = select dialog, then shared switch flow.** When
   `ctx.mode === "tui"` and no Telegram flag is armed, the status branch
   calls `ctx.ui.select("Switch project", projects)`. On a choice it runs
   the same code path as `/project <name>`; on dismiss it falls back to the
   plain list (current behavior preserved). `ctx.hasUI` remains the guard
   for the plain-text path.
   - The switch flow is extracted into a shared internal function
     `switchToProject(name, ctx)` used by both the argument path and the
     TUI selection, so there is exactly one implementation of switch
     semantics.

5. **Plain-text default unchanged.** All other cases (RPC without Telegram
   origin, `print`, `json`, TUI fallback after dismiss) print today's list
   via `ctx.ui.notify` with the active marker.

## Risks / Trade-offs

- **Prompt-injection surface:** the follow-up prompt text is generated from
  project directory names. A malicious directory name could try to smuggle
  button markup. Mitigation: project names are already constrained by
  discovery (no `/`, no leading dot); the prompt builder additionally
  omits the button cell for names containing `{`, `}`, `|`, backslash,
  backtick, or newline — they render as plain list text only.
- **Model dependence:** the Telegram reply relies on the model echoing the
  pre-rendered button block faithfully. Mitigation: the markup is fully
  pre-rendered in the prompt (the model copies it verbatim), and the plain
  list is included even if the model drops the buttons.
- **Extension order:** the input-event chain short-circuits on `handled`.
  Arming only works when the switcher's `input` handler runs before the
  command bridge's (package order in settings). The maintainer's
  configuration satisfies this; it is documented in the README as a
  requirement. If the order is wrong, arming silently fails and the status
  falls back to plain text — graceful degradation, never a wrong-surface
  button.
- **Flag staleness:** bounded by TTL + consumption + session_start reset.
- **Cost:** the Telegram path always starts one LLM turn (as does today's
  settle turn — no regression; strictly more useful).

## Migration Plan

None. New behavior is additive; `/project` list format and `/project <name>`
semantics are unchanged.
