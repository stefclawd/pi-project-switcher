/**
 * pi-project-switcher
 *
 * Switch between projects under a configurable base directory.
 * Every direct subdirectory of the base dir is a project (git optional).
 *
 * Commands:
 *   /project          - Show active project + list all discovered projects
 *   /project <name>   - Switch active project
 *
 * Configuration (precedence):
 *   1. ~/.pi/agent/project-switcher.json  { "baseDir": "..." }
 *   2. PI_PROJECT_SWITCHER_BASE env var
 *   3. Default: ~/dev
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();
const ENTRY_TYPE = "project-switcher-state";

interface Config {
  baseDir: string;
}

function loadConfig(): Config {
  // 1. settings file
  const settingsPath = join(HOME, ".pi", "agent", "project-switcher.json");
  if (existsSync(settingsPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const raw = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf8"));
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

    if (activeProject) {
      pi.setSessionName(activeProject);
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
      activeProject = name;

      // Persist to session
      pi.appendEntry(ENTRY_TYPE, { project: name, switchedAt: new Date().toISOString() });

      // Update session name
      pi.setSessionName(name);

      const path = projectPath(name);
      const branch = getGitBranch(path);
      const branchStr = branch ? ` on branch \`${branch}\`` : "";
      const fromStr = previous ? ` (was: ${previous})` : "";

      ctx.ui.notify(`Switched to ${name}${fromStr}\n${path}${branchStr ? ` ${branchStr}` : ""}`, "info");

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
