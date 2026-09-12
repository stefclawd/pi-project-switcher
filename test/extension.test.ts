/**
 * Tests for pi-project-switcher
 *
 * Runs the extension factory against a fake ExtensionAPI and asserts the
 * observable behavior: command registration, project discovery, switching,
 * persistence, session naming, and system-prompt injection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Test fixtures ───────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => any | Promise<any>;

interface Recorded {
  commands: { name: string; options: any }[];
  entries: { customType: string; data: any }[];
  sessionNames: string[];
  userMessages: { content: string; options?: any }[];
  notifications: { message: string; type?: string }[];
}

function createFakePi(): { pi: any; recorded: Recorded; handlers: Map<string, Handler>; api: any } {
  const recorded: Recorded = {
    commands: [],
    entries: [],
    sessionNames: [],
    userMessages: [],
    notifications: [],
  };
  const handlers = new Map<string, Handler>();

  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn((name: string, options: any) => {
      recorded.commands.push({ name, options });
    }),
    appendEntry: vi.fn((customType: string, data: any) => {
      recorded.entries.push({ customType, data });
    }),
    setSessionName: vi.fn((name: string) => {
      recorded.sessionNames.push(name);
    }),
    sendUserMessage: vi.fn((content: string, options?: any) => {
      recorded.userMessages.push({ content, options });
    }),
  };

  return { pi, recorded, handlers, api: pi };
}

/** Minimal ExtensionCommandContext for command handler invocation. */
function createFakeCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: process.cwd(),
    sessionManager: { getEntries: () => [] as any[] },
    ui: {
      notify: vi.fn(),
    },
    waitForIdle: vi.fn(async () => {}),
    isIdle: () => true,
    ...overrides,
  };
}

async function loadExtension() {
  // Fresh import per test to reset module-level state (activeProject, config)
  const modPath = new URL("../index.ts", import.meta.url).href;
  vi.resetModules();
  return await import(modPath);
}

// ── Helpers ────────────────────────────────────────────────────────────────

let baseDir: string;

function makeProjects(names: string[]): void {
  for (const name of names) {
    mkdirSync(join(baseDir, name), { recursive: true });
  }
}

async function fire(event: string, handlers: Map<string, Handler>, payload: any, ctx: any) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`No handler registered for ${event}`);
  return await handler(payload, ctx);
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "ppswitch-"));
  process.env.PI_PROJECT_SWITCHER_BASE = baseDir;
});

afterEach(() => {
  delete process.env.PI_PROJECT_SWITCHER_BASE;
  if (baseDir && existsSync(baseDir)) {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

describe("extension registration", () => {
  it("registers the /project command and lifecycle handlers", async () => {
    const { pi } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith("project", expect.anything());
    const handlers = ["session_start", "before_agent_start"];
    for (const h of handlers) {
      expect(pi.on).toHaveBeenCalledWith(h, expect.any(Function));
    }
  });

  it("completes project name arguments", async () => {
    makeProjects(["alpha", "beta", "gamma"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project");
    const completions = cmd!.options.getArgumentCompletions("al");
    expect(completions).toEqual([{ value: "alpha", label: "alpha" }]);
  });

  it("returns null when no completion matches", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project");
    expect(cmd!.options.getArgumentCompletions("zzz")).toBeNull();
  });
});

describe("/project status", () => {
  it("lists all projects and marks the active one", async () => {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx();
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler(" ", ctx);

    // Notifications are emitted via ctx.ui.notify, not recorded on pi
    expect(ctx.ui.notify).toHaveBeenCalled();
    const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg).toContain("alpha");
    expect(msg).toContain("beta");
  });

  it("warns when no projects exist", async () => {
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx();
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No projects found"),
      "warning"
    );
  });
});

describe("/project switching", () => {
  it("switches to an existing project", async () => {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx();
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("beta", ctx);

    expect(recorded.entries).toContainEqual({
      customType: "project-switcher-state",
      data: expect.objectContaining({ project: "beta" }),
    });
    expect(recorded.sessionNames).toContain("beta");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Switched to beta"),
      "info"
    );
    // Agent announcement queued after idle
    expect(ctx.waitForIdle).toHaveBeenCalled();
    expect(recorded.userMessages).toHaveLength(1);
    expect(recorded.userMessages[0].content).toContain("**beta**");
  });

  it("rejects an unknown project and keeps state", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx();
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("nope", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown project: "nope"'),
      "warning"
    );
    expect(recorded.entries).toHaveLength(0);
    expect(recorded.sessionNames).toHaveLength(0);
  });

  it("rejects path traversal attempts", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx();
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("../", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project"),
      "warning"
    );
    expect(recorded.entries).toHaveLength(0);
  });

  it("is a no-op when switching to the active project", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    let ctx = createFakeCtx();
    await cmd.options.handler("alpha", ctx);

    // Second switch to same project: no new entry
    ctx = createFakeCtx();
    await cmd.options.handler("alpha", ctx);

    expect(recorded.entries).toHaveLength(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already on project"),
      "info"
    );
  });
});

describe("session_start restore & auto-detect", () => {
  it("restores persisted project from session entries", async () => {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "project-switcher-state", data: { project: "beta" } },
        ],
      },
      cwd: join(baseDir, "alpha"), // cwd says alpha, persisted entry wins
    });
    await fire("session_start", handlers, { type: "session_start", reason: "startup" }, ctx);

    expect(recorded.sessionNames).toContain("beta");
  });

  it("auto-detects from cwd when nothing persisted", async () => {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ cwd: join(baseDir, "beta") });
    await fire("session_start", handlers, { type: "session_start", reason: "startup" }, ctx);

    expect(recorded.sessionNames).toContain("beta");
  });

  it("does nothing when starting outside the base dir", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ cwd: tmpdir() });
    await fire("session_start", handlers, { type: "session_start", reason: "startup" }, ctx);

    expect(recorded.sessionNames).toHaveLength(0);
  });
});

describe("before_agent_start injection", () => {
  it("injects project path into the system prompt", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // activate project first
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("alpha", createFakeCtx());

    const result = await fire(
      "before_agent_start",
      handlers,
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
      createFakeCtx()
    );

    expect(result?.systemPrompt).toContain("BASE");
    expect(result?.systemPrompt).toContain("## Active Project");
    expect(result?.systemPrompt).toContain("alpha");
    expect(result?.systemPrompt).toContain(baseDir);
  });

  it("does not inject when no project is active", async () => {
    const { pi, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const result = await fire(
      "before_agent_start",
      handlers,
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
      createFakeCtx()
    );

    expect(result).toBeUndefined();
  });
});

describe("configuration precedence", () => {
  it("honors PI_PROJECT_SWITCHER_BASE over ~/dev default", async () => {
    // baseDir (temp) already set via env in beforeEach; just verify discovery works there
    makeProjects(["envonly"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const completions = cmd.options.getArgumentCompletions("env");
    expect(completions).toEqual([{ value: "envonly", label: "envonly" }]);
  });

  it("falls back to the default base dir without env var", async () => {
    delete process.env.PI_PROJECT_SWITCHER_BASE;
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    // Should not throw; lists whatever exists under ~/dev or empty
    const ctx = createFakeCtx();
    await cmd.options.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled();
  });
});

describe("git branch detection", () => {
  it("shows branch info for git projects", async () => {
    makeProjects(["repo"]);
    // init a git repo with an initial commit to get a stable branch name
    const { execSync } = await import("node:child_process");
    const cwd = join(baseDir, "repo");
    execSync("git init -b trunk", { cwd });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd });

    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const ctx = createFakeCtx();
    await cmd.options.handler("repo", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("`trunk`"),
      "info"
    );
  }, 15000);
});
