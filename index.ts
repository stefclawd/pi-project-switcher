/**
 * pi-project-switcher
 *
 * Switch between projects under a configurable base directory.
 * Every direct subdirectory of the base dir is a project (git optional).
 *
 * Commands:
 *   /project          - Show active project + list all discovered projects
 *   /project <name>   - Switch active project (restores its last session)
 *
 * Configuration (precedence):
 *   1. ~/.pi/agent/project-switcher.json  { "baseDir": "..." }
 *   2. PI_PROJECT_SWITCHER_BASE env var
 *   3. Default: ~/dev
 *
 * Session map (project -> session file, machine-local):
 *   ~/.pi/agent/project-switcher-sessions.json
 *   Session paths stored relative to ~/.pi/agent/sessions/ for portability.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const HOME = homedir();
const ENTRY_TYPE = "project-switcher-state";
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const SESSION_MAP_PATH = join(HOME, ".pi", "agent", "project-switcher-sessions.json");

interface Config {
  baseDir: string;
}

/** project name -> persisted session state */
interface SessionMap {
  [project: string]: {
    /** Session file path, relative to ~/.pi/agent/sessions/ */
    sessionFile: string;
    updatedAt: string;
  };
}

function loadConfig(): Config {
  // 1. settings file
  const settingsPath = join(HOME, ".pi", "agent", "project-switcher.json");
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof raw.baseDir === "string" && raw.baseDir) {
        return { baseDir: resolve(raw.baseDir) };
      }
    } catch {
      // fall through to env/default
    }
  }
  // 2. env var
  const env = process.env.PI_PROJECT_SWITCHER_BASE;
  if (env) {
    return { baseDir: resolve(env) };
  }
  // 3. default
  return { baseDir: join(HOME, "dev") };
}

/** All direct, non-hidden subdirectories of the base dir. */
function discoverProjects(baseDir: string): string[] {
  if (!existsSync(baseDir)) {
    return [];
  }
  try {
    return readdirSync(baseDir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(baseDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function getGitBranch(path: string): string {
  try {
    return execSync("git branch --show-current", { cwd: path, stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// ── Session map (project -> session file) ─────────────────────────────────

function loadSessionMap(): SessionMap {
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // keep only well-formed entries
      const map: SessionMap = {};
      for (const [project, value] of Object.entries(raw)) {
        if (
          value &&
          typeof value === "object" &&
          typeof (value as any).sessionFile === "string" &&
          (value as any).sessionFile
        ) {
          map[project] = {
            sessionFile: (value as any).sessionFile,
            updatedAt: typeof (value as any).updatedAt === "string" ? (value as any).updatedAt : "",
          };
        }
      }
      return map;
    }
  } catch {
    // missing/corrupt file -> empty map
  }
  return {};
}

function saveSessionMap(map: SessionMap): void {
  const dir = join(HOME, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf8");
}

/** Resolve a stored relative session file to its absolute path. */
function resolveSessionFile(relPath: string): string {
  const abs = resolve(SESSIONS_DIR, relPath);
  // Guard: stored path must stay inside the sessions dir
  const rel = relative(SESSIONS_DIR, abs);
  if (rel.startsWith("..") || resolve(rel) === SESSIONS_DIR) {
    return abs; // resolve() already clamps to sessions dir via resolve(), re-checked by caller via existsSync
  }
  return abs;
}

/** Convert an absolute session file path to the relative form we store. */
function toRelativeSessionFile(absPath: string): string | null {
  const rel = relative(SESSIONS_DIR, resolve(absPath));
  if (!rel || rel.startsWith("..")) {
    return null; // session lives outside the default sessions dir -> don't persist
  }
  return rel;
}

function getMappedSessionFile(project: string): string | null {
  const map = loadSessionMap();
  const entry = map[project];
  if (!entry) {
    return null;
  }
  const abs = resolveSessionFile(entry.sessionFile);
  return existsSync(abs) ? abs : null;
}

function rememberSessionFile(project: string, absSessionFile: string): void {
  const rel = toRelativeSessionFile(absSessionFile);
  if (!rel) {
    return;
  }
  const map = loadSessionMap();
  map[project] = { sessionFile: rel, updatedAt: new Date().toISOString() };
  saveSessionMap(map);
}

let activeProject: string | null = null;
let config: Config | null = null;

// ── Telegram origin detection (input event + flag) ───────────────────────────

/**
 * Matches a first line dispatched from the pi-telegram bridge: a
 * `[telegram]` tag (optionally with attributes like `[telegram|thread:x]`)
 * followed by a bare `/project` with no arguments.
 */
const TELEGRAM_STATUS_RE = /^\[telegram(?:\|[^\]]*)?\]\s*\/project\s*$/;

/**
 * Same, but for `/project <name>` (a switch). The command bridge strips
 * the tag and re-dispatches the bare command line, so a Telegram-originated
 * switch would otherwise be indistinguishable from a native invocation.
 * Arguments are captured so the flag matches the command the user sent.
 */
const TELEGRAM_SWITCH_RE = /^\[telegram(?:\|[^\]]*)?\]\s*\/project\s+(\S.*)$/;

/** How long an armed flag stays valid (ms). Guards against stale flags
 *  from dispatches that never reached the command handler. */
const TELEGRAM_FLAG_TTL_MS = 30_000;

/** Armed-at timestamp of a pending Telegram-originated status request, or null. */
let telegramStatusFlag: number | null = null;

/** Armed-at timestamp of a pending Telegram-originated switch request, or null. */
let telegramSwitchFlag: number | null = null;

function armTelegramStatusFlag(): void {
  telegramStatusFlag = Date.now();
}

/** Consume the flag: returns true (and clears it) when armed and not expired. */
function consumeTelegramStatusFlag(): boolean {
  if (telegramStatusFlag === null) return false;
  const armed = telegramStatusFlag;
  telegramStatusFlag = null;
  return Date.now() - armed <= TELEGRAM_FLAG_TTL_MS;
}

function armTelegramSwitchFlag(): void {
  telegramSwitchFlag = Date.now();
}

/** Consume the switch flag: returns true (and clears it) when armed and not expired. */
function consumeTelegramSwitchFlag(): boolean {
  if (telegramSwitchFlag === null) return false;
  const armed = telegramSwitchFlag;
  telegramSwitchFlag = null;
  return Date.now() - armed <= TELEGRAM_FLAG_TTL_MS;
}

function clearTelegramStatusFlag(): void {
  telegramStatusFlag = null;
  telegramSwitchFlag = null;
}

/**
 * A project name that could alter button markup or the button prompt is
 * rendered as plain list text only (never gets a button cell).
 */
function isUnsafeButtonName(name: string): boolean {
  return /[{}|`\\\n]/.test(name);
}

/**
 * Build the follow-up prompt for a Telegram-originated status request.
 * Embeds the authoritative project list and a pre-rendered telegram_button
 * block the agent copies verbatim into its reply.
 */
function buildTelegramStatusPrompt(projects: string[]): string {
  const ordered = [...projects];
  if (activeProject) {
    const idx = ordered.indexOf(activeProject);
    if (idx > 0) {
      ordered.splice(idx, 1);
      ordered.unshift(activeProject);
    } else if (idx === -1) {
      ordered.unshift(activeProject);
    }
  }

  const listLines = ordered
    .map((p) => `  ${p}${p === activeProject ? " ◀ active" : ""}`)
    .join("\n");

  const buttonCells = ordered
    .filter((p) => !isUnsafeButtonName(p))
    .map((p) =>
      p === activeProject
        ? `{✅ ${p} (active)|/project ${p}}`
        : `{📁 ${p}|/project ${p}}`,
    )
    .join("\n");
  const buttonBlock =
    buttonCells.length > 0
      ? "\n\n```telegram_button\n" + buttonCells + "\n```"
      : "";

  const current = activeProject ? `Active: ${activeProject}` : "No project active";

  return (
    `[project-switcher] The user ran /project via Telegram and expects the project list in the chat.\n` +
    `Authoritative list (do not re-derive, do not add or remove entries):\n` +
    `${current}\n\n${listLines}\n\n` +
    `Reply in the chat with exactly this list (keep the active marker) followed by the button block below, ` +
    `copied verbatim. Do not run any command, do not switch projects yourself, and add nothing else.${buttonBlock}`
  );
}

/**
 * Build the follow-up prompt for a Telegram-originated project switch. The
 * turn's reply is delivered to the Telegram chat as the visible confirmation
 * that the switch succeeded (the local UI notification never reaches the
 * phone). Facts are passed by the extension; the reply shape is prescribed
 * so the model cannot invent outcomes. `sendFn` is passed in so both switch
 * paths reuse this: the restore path must send from the fresh withSession
 * context (never the stale pre-switch pi), the fallback path from the
 * current runtime.
 */
function buildTelegramSwitchConfirmationPrompt(opts: {
  project: string;
  path: string;
  branchStr: string;
  sessionLine: string;
  previous: string | null;
}): string {
  const { project, path, branchStr, sessionLine, previous } = opts;

  const confirmLine = `✅ Switched to **${project}**${previous ? ` (was: ${previous})` : ""}`;
  const infoLines = [confirmLine, `📁 ${path}${branchStr ? ` (${branchStr})` : ""}`, sessionLine].join("\n");

  const cells: string[] = ["{📋 Projects|/project}"];
  if (previous && !isUnsafeButtonName(previous) && previous !== project) {
    cells.push(`{↩️ Back to ${previous}|/project ${previous}}`);
  }
  const buttonBlock =
    cells.length > 0
      ? "\n\n```telegram_button\n" + cells.join("\n") + "\n```"
      : "";

  return (
    `[project-switcher] The user ran /project ${project} via Telegram and expects a confirmation that the switch succeeded.\n` +
    `Authoritative switch facts (do not re-derive, do not run any command, do not switch projects yourself):\n` +
    `${infoLines}\n\n` +
    `Reply in the chat with exactly the lines above, followed by the button block below, copied verbatim. ` +
    `Add nothing else.${buttonBlock}`
  );
}

/**
 * Short follow-up for Telegram-originated switch outcomes that changed
 * nothing (already-active or cancelled): guarantees the chat still gets a
 * visible reply instead of silence.
 */
function buildTelegramNoChangePrompt(text: string): string {
  return (
    `[project-switcher] The user ran /project via Telegram.\n` +
    `Reply in the chat with exactly this line and nothing else: ${text}`
  );
}

// ── Telegram transport ownership probe & re-arm ──────────────────────────────

/**
 * Path of pi-telegram's transport ownership lock. The switcher only ever
 * READS this file (pi-telegram's own connect handler performs the actual
 * acquisition); mutating it by hand is explicitly forbidden by the
 * bridge's diagnosis guidance.
 */
function telegramOwnersPath(): string {
  return join(HOME, ".pi", "agent", "tmp", "telegram", "owners.json");
}

/**
 * Freshness bound for the ownership probe. Deliberately LOOSER than
 * pi-telegram's 8s staleness window: a passing probe means the owner
 * runtime was definitely alive at switch time (a false positive here only
 * leads to a connect attempt that pi-telegram itself re-validates).
 */
const TELEGRAM_OWNERSHIP_FRESH_MS = 10_000;

/**
 * Delay before re-dispatching /telegram-connect after a session-replacing
 * switch. Must exceed pi-telegram's lock staleness window (8s): the
 * suspended old runtime stops refreshing the heartbeat at session
 * shutdown, and a *stale* lock is the only one the connect handler's
 * non-forced acquire can replace across a cwd mismatch.
 */
const TELEGRAM_REARM_DELAY_MS = 9_000;

/**
 * Read-only probe: is the session we are about to leave the live owner of
 * the connected Telegram transport? True iff pi-telegram's lock file has
 * an entry for the current process whose heartbeat is fresh and whose cwd
 * matches the old session's cwd (or is absent). This is the guard that
 * prevents stealing the bot from a different pi instance or re-arming in
 * a session that never used Telegram.
 */
function probeTelegramTransportOwnership(oldCwd: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(telegramOwnersPath(), "utf8"));
    if (!raw || typeof raw !== "object") return false;
    // Any profile entry counts (the default profile uses the key "default").
    for (const entry of Object.values(raw) as any[]) {
      if (
        entry &&
        typeof entry === "object" &&
        entry.pid === process.pid &&
        typeof entry.heartbeatMs === "number" &&
        Date.now() - entry.heartbeatMs <= TELEGRAM_OWNERSHIP_FRESH_MS &&
        (entry.cwd === undefined || entry.cwd === oldCwd)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // Missing or malformed lock file: transport not owned here.
    return false;
  }
}

/**
 * Pending re-arm timer (single slot): scheduling a new re-arm supersedes
 * a not-yet-fired previous one. The callback only touches the withSession
 * context it was scheduled with, so it can never act on a stale runtime.
 */
let pendingRearmTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTelegramRearm(newCtx: any, source: string): void {
  if (pendingRearmTimer) {
    clearTimeout(pendingRearmTimer);
    pendingRearmTimer = null;
  }
  const timer = setTimeout(async () => {
    pendingRearmTimer = null;
    try {
      // Command re-dispatch from the FRESH runtime: executes pi-telegram's
      // connect handler (no agent turn) and re-acquires the now-stale lock,
      // restarting polling in the new session.
      await newCtx.sendUserMessage("/telegram-connect", {
        expandPromptTemplates: true,
      });
    } catch (err: any) {
      try {
        newCtx.ui.notify(
          `Telegram re-arm after ${source} switch failed: ${err?.message ?? err}`,
          "warning"
        );
      } catch {
        // Even the fresh context can be gone (e.g. another switch followed):
        // never let an error escape into an uncaught timer callback.
      }
    }
  }, TELEGRAM_REARM_DELAY_MS);
  timer.unref?.();
  pendingRearmTimer = timer;
}

function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

function projectPath(name: string): string {
  return join(getConfig().baseDir, name);
}

function isValidProject(name: string): boolean {
  const projects = discoverProjects(getConfig().baseDir);
  return projects.includes(name);
}

/** True when a name is safe to materialize as a single directory under the base dir. */
function isSafeProjectName(name: string): boolean {
  if (!name || name === "." || name === "..") {
    return false;
  }
  if (name.startsWith(".")) {
    return false; // hidden
  }
  if (name.includes("/") || name.includes("\\")) {
    return false; // no path segments
  }
  if (name.includes("..")) {
    return false; // no traversal
  }
  if (isAbsolute(name)) {
    return false; // absolute paths
  }
  return true;
}

/**
 * Plain text project list via the local UI notification channel —
 * the unchanged default output for non-Telegram surfaces.
 */
function notifyPlainProjectList(ctx: any, projects: string[]): void {
  const current = activeProject ? `Active: ${activeProject}` : "No project active";
  const lines = projects.map((p) => {
    const branch = getGitBranch(projectPath(p));
    const branchStr = branch ? ` [${branch}]` : "";
    const marker = p === activeProject ? " ◀ active" : "";
    return `  ${p}${branchStr}${marker}`;
  });
  ctx.ui.notify(
    `${current}\n\nProjects under ${getConfig().baseDir}:\n${lines.join("\n")}`,
    "info"
  );
}

export default function (pi: ExtensionAPI) {
  // ── Restore state on session start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Session switches reset any pending Telegram status flag
    clearTelegramStatusFlag();

    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === ENTRY_TYPE &&
        (entry as any).data?.project
      ) {
        activeProject = (entry as any).data.project;
      }
    }

    // Auto-detect from cwd if nothing persisted
    if (!activeProject) {
      const base = getConfig().baseDir;
      const cwd = resolve(ctx.cwd);
      if (cwd.startsWith(base + "/")) {
        const candidate = cwd.slice(base.length + 1).split("/")[0];
        if (isValidProject(candidate)) {
          activeProject = candidate;
        }
      }
    }

    // Keep the session map fresh: current session belongs to the active project
    if (activeProject) {
      pi.setSessionName(activeProject);
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        rememberSessionFile(activeProject, sessionFile);
      }
    }
  });

  // ── Telegram origin detection (input event) ────────────────────────────────
  //
  // Prompts dispatched from the pi-telegram queue arrive with source
  // "extension" and a `[telegram]`-tagged first line, BEFORE the command
  // bridge re-dispatches the bare command line. Recognizing the raw
  // dispatch here is the only reliable origin signal; the re-dispatched
  // text is indistinguishable from a native TUI invocation.
  //
  // Requires this extension to be listed BEFORE the command bridge in the
  // package order (the bridge's "handled" result would short-circuit the
  // input chain before this handler runs otherwise). Wrong order degrades
  // gracefully: the flag is never armed and the status falls back to the
  // plain list.
  pi.on("input", async (event) => {
    if (event.source !== "extension") return;
    const firstLine = event.text.split("\n", 1)[0];
    const trimmed = firstLine.trim();
    if (TELEGRAM_STATUS_RE.test(trimmed)) {
      armTelegramStatusFlag();
    } else if (TELEGRAM_SWITCH_RE.test(trimmed)) {
      armTelegramSwitchFlag();
    }
    // Never transform or handle: the command bridge owns the re-dispatch.
  });

  // ── Inject project context into every agent turn ─────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!activeProject || !isValidProject(activeProject)) {
      return;
    }
    const path = projectPath(activeProject);
    const branch = getGitBranch(path);
    const branchInfo = branch ? ` (git: ${branch})` : "";
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Active Project\n` +
        `Project: **${activeProject}**\n` +
        `Path: \`${path}\`${branchInfo}\n` +
        `All file operations and bash commands should default to this project path unless specified otherwise.`,
    };
  });

  // ── Shared switch flow ──────────────────────────────────────────────────
  //
  // Single implementation of /project <name> semantics, used by the typed
  // argument path and the TUI selection dialog. `createOptIn` (trailing
  // "!") only applies to the typed path; dialog users confirm interactively.
  const switchToProject = async (rawName: string, ctx: any, createOptIn: boolean): Promise<void> => {
    const name = rawName;
    const isTelegramOrigin = consumeTelegramSwitchFlag();

    if (!isValidProject(name)) {
      // Offer to create the folder and switch to it (never silently)
      if (isSafeProjectName(name)) {
        let create = false;
        if (createOptIn) {
          create = true;
        } else if (ctx.hasUI) {
          try {
            create = await ctx.ui.confirm(
              "Create project?",
              `Project "${name}" does not exist. Create ${join(getConfig().baseDir, name)} and switch to it?`
            );
          } catch {
            create = false;
          }
        }

        if (create) {
          const newPath = projectPath(name);
          try {
            mkdirSync(newPath, { recursive: false });
            ctx.ui.notify(`Created project folder: ${newPath}`, "info");
          } catch (err: any) {
            ctx.ui.notify(
              `Failed to create project folder ${newPath}: ${err?.message ?? err}`,
              "error"
            );
            return;
          }
          // fall through: the folder now exists and the switch proceeds below
        }
      }

      if (!isValidProject(name)) {
        const available = discoverProjects(getConfig().baseDir).join(", ");
        ctx.ui.notify(
          `Unknown project: "${name}".\nAvailable: ${available || "(none)"}`,
          "warning"
        );
        if (isTelegramOrigin) {
          await ctx.waitForIdle();
          pi.sendUserMessage(
            buildTelegramNoChangePrompt(`⚠️ Unknown project: ${name} — no switch performed.`),
            { deliverAs: "followUp" }
          );
        }
        return;
      }
    }

    if (name === activeProject) {
      ctx.ui.notify(`Already on project: ${name}`, "info");
      if (isTelegramOrigin) {
        await ctx.waitForIdle();
        pi.sendUserMessage(buildTelegramNoChangePrompt(`ℹ️ Already on project: **${name}**`), {
          deliverAs: "followUp",
        });
      }
      return;
    }

    const previous = activeProject;

    // Remember the current session under the PREVIOUS project before switching
    const currentSessionFile = ctx.sessionManager.getSessionFile();
    if (previous && currentSessionFile) {
      rememberSessionFile(previous, currentSessionFile);
    }

    // Try to restore the target project's last session
    const targetSession = getMappedSessionFile(name);

    if (targetSession) {
      // Pre-write the switch state INTO THE TARGET session file so the
      // fresh runtime's session_start restores the right project. Writing
      // it to the current (old) session instead would leave the target
      // session's own (stale) project entry authoritative.
      // SessionManager.open() advances the target file's leaf to this entry.
      // The same entry must also exist in the old session so a later switch
      // BACK to the previous project still restores it (the old session is
      // remembered under the previous project below).
      try {
        SessionManager.open(targetSession).appendCustomEntry(ENTRY_TYPE, {
          project: name,
          switchedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        ctx.ui.notify(
          `Could not persist switch state to target session: ${err?.message ?? err}`,
          "warning"
        );
      }

      // Persist the switch in the OLD session too (for switching back later).
      // Still valid: the old runtime has not been invalidated yet.
      try {
        pi.appendEntry(ENTRY_TYPE, { project: name, switchedAt: new Date().toISOString() });
      } catch {
        // Non-fatal: the target-session entry above is the authoritative one.
      }

      // Everything after ctx.switchSession() must run in withSession: the
      // captured `pi` and command `ctx` are stale once the session is
      // replaced, and using them throws (previously crashed the command
      // with "stale ctx" errors and killed the whole flow).
      const branch = getGitBranch(projectPath(name));
      const branchStr = branch ? ` on branch \`${branch}\`` : "";
      // Ownership probe BEFORE the switch (the old session's cwd is only
      // available here): when the session we are leaving is the live owner
      // of the connected Telegram transport, the new runtime must re-arm
      // it after the switch (pi-telegram suspends polling on session
      // shutdown and its auto-start declines the handoff across a cwd
      // mismatch). The probe failing means we are NOT the owner (another
      // pi instance, or Telegram was never connected here): re-arm nothing.
      const ownedTelegramTransport =
        isTelegramOrigin && probeTelegramTransportOwnership(ctx.cwd);
      const result = await ctx.switchSession(targetSession, {
        withSession: async (newCtx: any) => {
          // Safety net in case the restored session has no project entry:
          // session_start has already run for the new runtime; if it
          // restored a different project from a stale entry, the pre-written
          // entry above is the LAST project-switcher-state entry in the file
          // and therefore authoritative — set the in-memory state explicitly.
          activeProject = name;
          newCtx.ui.notify(
            `Switched to ${name} — session restored: ${basename(targetSession)}\n` +
            `Workdir: ${projectPath(name)}${branchStr ? ` ${branchStr}` : ""}`,
            "info"
          );
          if (isTelegramOrigin) {
            // Confirmation turn from the FRESH runtime: the reply reaches
            // the Telegram chat (the local notify above never does). Only
            // the new context is touched — the pre-switch pi/ctx are stale.
            // The turn also settles pi-telegram's dispatch queue.
            await newCtx.waitForIdle();
            await newCtx.sendUserMessage(
              buildTelegramSwitchConfirmationPrompt({
                project: name,
                path: projectPath(name),
                branchStr,
                sessionLine: `🗂 Session restored: ${basename(targetSession)}`,
                previous,
              }),
              { deliverAs: "followUp" }
            );
          }
          if (ownedTelegramTransport) {
            // Re-arm the Telegram transport from the fresh runtime. Only the
            // withSession context is touched; the delay lets the old lock
            // go stale (see TELEGRAM_REARM_DELAY_MS) so the connect
            // handler's acquire can replace it across the cwd mismatch.
            scheduleTelegramRearm(newCtx, name);
          }
        },
      });
      if (result.cancelled) {
        // User cancelled; roll back in-memory state. The pre-written target
        // entry is harmless: it only records that a switch to `name` was
        // attempted; an explicit later status/switch overrides it.
        activeProject = previous;
        ctx.ui.notify(`Switch cancelled. Staying on ${previous ?? "no project"}.`, "info");
        if (isTelegramOrigin) {
          await ctx.waitForIdle();
          pi.sendUserMessage(
            buildTelegramNoChangePrompt(
              `⚠️ Switch to ${name} cancelled — staying on ${previous ?? "no project"}.`
            ),
            { deliverAs: "followUp" }
          );
        }
        return;
      }

      // Remember the mapping AFTER a successful switch (withSession has
      // already run). rememberSessionFile only touches the JSON map on
      // disk, so calling it here is safe.
      rememberSessionFile(name, targetSession);
      return;
    }

    // ── Fallback: no stored session (or file gone) -> same-session switch ─
    activeProject = name;

    // Persist to session
    pi.appendEntry(ENTRY_TYPE, { project: name, switchedAt: new Date().toISOString() });

    // Update session name
    pi.setSessionName(name);

    const path = projectPath(name);
    const branch = getGitBranch(path);
    const branchStr = branch ? ` on branch \`${branch}\`` : "";
    const fromStr = previous ? ` (was: ${previous})` : "";

    // Current session identity — still valid on this path (no session replacement)
    const currentFile = currentSessionFile ?? ctx.sessionManager.getSessionFile();
    const sessionLine = currentFile
      ? `Continuing session: ${basename(currentFile)}`
      : "Continuing current session";

    ctx.ui.notify(
      `Switched to ${name}${fromStr} — first session in this project\n` +
      `Workdir: ${path}${branchStr ? ` ${branchStr}` : ""}\n` +
      sessionLine,
      "info"
    );

    // Announce to the agent so it operates in the new context — or, for a
    // Telegram-originated switch, send the chat-visible confirmation turn
    // (it doubles as the agent context announcement).
    await ctx.waitForIdle();
    pi.sendUserMessage(
      isTelegramOrigin
        ? buildTelegramSwitchConfirmationPrompt({
            project: name,
            path,
            branchStr,
            sessionLine: `🗂 First session in this project (${sessionLine})`,
            previous,
          })
        : `[Project switched to **${name}**]\n` +
          `Working directory: \`${path}\`${branchStr}\n` +
          `Please keep all file operations within this project from now on.`,
      { deliverAs: "followUp" }
    );
  };

  // ── /project command ─────────────────────────────────────────────────────
  pi.registerCommand("project", {
    description: "Show or switch active project (/project [name])",

    getArgumentCompletions: (prefix: string) => {
      const projects = discoverProjects(getConfig().baseDir);
      const filtered = projects.filter((p) => p.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((p) => ({ value: p, label: p }))
        : null;
    },

    handler: async (args, ctx) => {
      let name = args.trim();

      // ── Explicit create opt-in: trailing "!" on the project name ────────
      const createOptIn = name.endsWith("!");
      if (createOptIn) {
        name = name.slice(0, -1).trim();
      }

      // ── No arg: surface-adaptive status ──────────────────────────────────
      if (!name) {
        const projects = discoverProjects(getConfig().baseDir);
        if (projects.length === 0) {
          ctx.ui.notify(
            `No projects found under ${getConfig().baseDir}. Set PI_PROJECT_SWITCHER_BASE or create the settings file.`,
            "warning"
          );
          return;
        }

        const isTelegramOrigin = consumeTelegramStatusFlag();

        if (isTelegramOrigin) {
          // Plain list for the local surface (parity with today) …
          notifyPlainProjectList(ctx, projects);
          // … then a follow-up turn whose reply reaches the Telegram chat,
          // with one button per project. The turn also settles the command
          // bridge's pending dispatch (its agent_start hook clears the
          // pending settle entry first).
          await ctx.waitForIdle();
          pi.sendUserMessage(buildTelegramStatusPrompt(projects), {
            deliverAs: "followUp",
          });
          return;
        }

        if (ctx.mode === "tui") {
          // Selection dialog; dismissing falls back to the plain list.
          const choice = await ctx.ui.select("Switch project", projects);
          if (choice !== undefined) {
            await switchToProject(choice, ctx, false);
            return;
          }
          notifyPlainProjectList(ctx, projects);
          return;
        }

        // rpc/json/print and any other surface: unchanged plain list
        notifyPlainProjectList(ctx, projects);
        return;
      }

      // ── Switch project ────────────────────────────────────────────────────
      await switchToProject(name, ctx, createOptIn);
    },
  });
}
