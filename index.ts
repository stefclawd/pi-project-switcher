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
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

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

export default function (pi: ExtensionAPI) {
  // ── Restore state on session start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
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
      const name = args.trim();

      // ── No arg: show status ──────────────────────────────────────────────
      if (!name) {
        const projects = discoverProjects(getConfig().baseDir);
        if (projects.length === 0) {
          ctx.ui.notify(
            `No projects found under ${getConfig().baseDir}. Set PI_PROJECT_SWITCHER_BASE or create the settings file.`,
            "warning"
          );
          return;
        }
        const current = activeProject ? `Active: ${activeProject}` : "No project active";
        const lines = projects.map((p) => {
          const branch = getGitBranch(projectPath(p));
          const branchStr = branch ? ` [${branch}]` : "";
          const marker = p === activeProject ? " ◀ active" : "";
          return `  ${p}${branchStr}${marker}`;
        });
        ctx.ui.notify(`${current}\n\nProjects under ${getConfig().baseDir}:\n${lines.join("\n")}`, "info");
        return;
      }

      // ── Switch project ────────────────────────────────────────────────────
      if (!isValidProject(name)) {
        const available = discoverProjects(getConfig().baseDir).join(", ");
        ctx.ui.notify(
          `Unknown project: "${name}".\nAvailable: ${available || "(none)"}`,
          "warning"
        );
        return;
      }

      if (name === activeProject) {
        ctx.ui.notify(`Already on project: ${name}`, "info");
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
        // Persist the switch in the OLD session before replacing it
        pi.appendEntry(ENTRY_TYPE, { project: name, switchedAt: new Date().toISOString() });

        const result = await ctx.switchSession(targetSession);
        if (result.cancelled) {
          // User cancelled; roll back in-memory state
          activeProject = previous;
          ctx.ui.notify(`Switch cancelled. Staying on ${previous ?? "no project"}.`, "info");
          return;
        }

        // switchSession fires a new session_start, which restores state from
        // the target session's entries (or auto-detects). Set it explicitly as
        // a safety net in case the session has no project entry yet.
        activeProject = name;
        pi.setSessionName(name);
        rememberSessionFile(name, targetSession);

        const path = projectPath(name);
        const branch = getGitBranch(path);
        const branchStr = branch ? ` on branch \`${branch}\`` : "";
        ctx.ui.notify(
          `Switched to ${name} — session restored: ${basename(targetSession)}\n` +
          `Workdir: ${path}${branchStr ? ` ${branchStr}` : ""}`,
          "info"
        );
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

      // Announce to the agent so it operates in the new context
      await ctx.waitForIdle();
      pi.sendUserMessage(
        `[Project switched to **${name}**]\n` +
          `Working directory: \`${path}\`${branchStr}\n` +
          `Please keep all file operations within this project from now on.`,
        { deliverAs: "followUp" }
      );
    },
  });
}
