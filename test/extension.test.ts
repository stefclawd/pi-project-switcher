/**
 * Tests for pi-project-switcher
 *
 * Runs the extension factory against a fake ExtensionAPI and asserts the
 * observable behavior: command registration, project discovery, switching,
 * persistence, session naming, and system-prompt injection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
    hasUI: true,
    sessionManager: {
      getEntries: () => [] as any[],
      getSessionFile: () => undefined as string | undefined,
    },
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => false),
      select: vi.fn(async () => undefined),
    },
    switchSession: vi.fn(async (_path: string) => ({ cancelled: false })),
    waitForIdle: vi.fn(async () => {}),
    isIdle: () => true,
    ...overrides,
  };
}

/** Create a fake session file inside the fake sessions dir and return its absolute path. */
function makeFakeSession(name: string): string {
  const dir = join(fakeHome, ".pi", "agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "{}\n", "utf8");
  return file;
}

function readSessionMap(): any {
  return JSON.parse(readFileSync(sessionMapPath, "utf8"));
}

async function loadExtension() {
  // Fresh import per test to reset module-level state (activeProject, config)
  const modPath = new URL("../index.ts", import.meta.url).href;
  vi.resetModules();
  return await import(modPath);
}

// ── Helpers ────────────────────────────────────────────────────────────────

let baseDir: string;
let fakeHome: string;
let sessionMapPath: string;
let realHome: string;

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

  // The extension resolves ~/.pi/agent paths from os.homedir() at module
  // load. Point HOME at a temp dir so tests never touch the real map.
  // loadExtension() calls vi.resetModules() -> constants re-evaluate.
  fakeHome = mkdtempSync(join(tmpdir(), "ppswitch-home-"));
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  sessionMapPath = join(fakeHome, ".pi", "agent", "project-switcher-sessions.json");
  realHome = process.env.HOME ?? "";
  process.env.HOME = fakeHome;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PI_PROJECT_SWITCHER_BASE;
  process.env.HOME = realHome;
  for (const dir of [baseDir, fakeHome]) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

    const ctx = createFakeCtx({
      sessionManager: {
        getEntries: () => [] as any[],
        getSessionFile: () => "/some/other-session.jsonl" as string | undefined,
      },
    });
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
    // First-session fallback wording + workdir line
    const notifyMsg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(notifyMsg).toContain("first session in this project");
    expect(notifyMsg).toContain(`Workdir: ${join(baseDir, "beta")}`);
    expect(notifyMsg).toContain("Continuing session: other-session.jsonl");
    // Agent announcement queued after idle
    expect(ctx.waitForIdle).toHaveBeenCalled();
    expect(recorded.userMessages).toHaveLength(1);
    expect(recorded.userMessages[0].content).toContain("**beta**");
  });  it("rejects an unknown project and keeps state", async () => {
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
        getSessionFile: () => undefined as string | undefined,
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

describe("session map persistence", () => {
  it("stores the current session under the previous project on switch", async () => {
    makeProjects(["alpha", "beta"]);
    const sessionFile = makeFakeSession("sess-alpha.jsonl");

    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // start on alpha (cwd auto-detect)
    const startCtx = createFakeCtx({
      sessionManager: {
        getEntries: () => [] as any[],
        getSessionFile: () => sessionFile,
      },
      cwd: join(baseDir, "alpha"),
    });
    await fire("session_start", handlers, { type: "session_start" }, startCtx);

    // no stored session for beta -> same-session switch
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("beta", createFakeCtx({
      sessionManager: {
        getEntries: () => [] as any[],
        getSessionFile: () => sessionFile,
      },
    }));

    const map = readSessionMap();
    expect(map.alpha.sessionFile).toContain("sess-alpha.jsonl");
    expect(map.alpha.updatedAt).toBeTruthy();
  });

  it("restores the stored session of the target project", async () => {
    makeProjects(["alpha", "beta"]);
    const betaSession = makeFakeSession("2026-09-12-beta.jsonl");

    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // Pre-seed the map: beta -> its session file (relative to ~/.pi/agent/sessions/)
    writeFileSync(
      sessionMapPath,
      JSON.stringify({
        beta: { sessionFile: "2026-09-12-beta.jsonl", updatedAt: "x" },
      }),
      "utf8"
    );

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const ctx = createFakeCtx();
    await cmd.options.handler("beta", ctx);

    expect(ctx.switchSession).toHaveBeenCalledWith(betaSession);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("session restored: 2026-09-12-beta.jsonl"),
      "info"
    );
    const restoreMsg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(restoreMsg).toContain(`Workdir: ${join(baseDir, "beta")}`);
  });

  it("falls back to same-session switch when stored session file is gone", async () => {
    makeProjects(["alpha", "beta"]);

    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // Map points to a file that does not exist
    writeFileSync(
      sessionMapPath,
      JSON.stringify({
        beta: { sessionFile: "gone.jsonl", updatedAt: "x" },
      }),
      "utf8"
    );

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const ctx = createFakeCtx();
    await cmd.options.handler("beta", ctx);

    expect(ctx.switchSession).not.toHaveBeenCalled();
    expect(recorded.userMessages).toHaveLength(1); // follow-up announcement (same-session path)
  });

  it("rolls back when switchSession is cancelled", async () => {
    makeProjects(["alpha", "beta"]);
    makeFakeSession("beta-session.jsonl");
    writeFileSync(
      sessionMapPath,
      JSON.stringify({
        beta: { sessionFile: "beta-session.jsonl", updatedAt: "x" },
      }),
      "utf8"
    );

    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // start on alpha
    const startCtx = createFakeCtx({ cwd: join(baseDir, "alpha") });
    await fire("session_start", handlers, { type: "session_start" }, startCtx);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const ctx = createFakeCtx({
      switchSession: vi.fn(async () => ({ cancelled: true })),
    });
    await cmd.options.handler("beta", ctx);

    // stayed on alpha: prompt injection still says alpha
    const result = await fire(
      "before_agent_start",
      handlers,
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
      createFakeCtx()
    );
    expect(result.systemPrompt).toContain("alpha");
  });

  it("ignores malformed session map entries", async () => {
    makeProjects(["alpha", "beta"]);
    writeFileSync(sessionMapPath, JSON.stringify({ beta: { nope: true }, gamma: "garbage" }), "utf8");

    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    const ctx = createFakeCtx();
    await cmd.options.handler("beta", ctx);

    expect(ctx.switchSession).not.toHaveBeenCalled();
    expect(recorded.userMessages).toHaveLength(1);
  });

  it("does not persist sessions that live outside ~/.pi/agent/sessions", async () => {
    makeProjects(["alpha", "beta"]);
    const outside = join(baseDir, "alpha", "some-session.jsonl");
    writeFileSync(outside, "{}", "utf8");

    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const startCtx = createFakeCtx({
      sessionManager: {
        getEntries: () => [] as any[],
        getSessionFile: () => outside,
      },
      cwd: join(baseDir, "alpha"),
    });
    await fire("session_start", handlers, { type: "session_start" }, startCtx);

    expect(existsSync(sessionMapPath)).toBe(false);
  });
});

describe("create project on unknown name", () => {
  it("creates the folder and switches after user confirms", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({
      ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
    });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("newproj", ctx);

    expect(existsSync(join(baseDir, "newproj"))).toBe(true);
    const msgs = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]);
    expect(msgs.some((m: string) => m.includes("Created project folder:"))).toBe(true);
    expect(msgs.some((m: string) => m.includes("Switched to newproj"))).toBe(true);
    expect(msgs.some((m: string) => m.includes("first session in this project"))).toBe(true);
  });

  it("warns and creates nothing when user declines", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({
      ui: { notify: vi.fn(), confirm: vi.fn(async () => false) },
    });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("newproj", ctx);

    expect(existsSync(join(baseDir, "newproj"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown project: "newproj"'),
      "warning"
    );
    expect(recorded.sessionNames).toHaveLength(0);
  });

  it("creates without dialog via explicit '!' opt-in on headless surfaces", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ hasUI: false });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("newproj!", ctx);

    expect(existsSync(join(baseDir, "newproj"))).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Created project folder:"),
      "info"
    );
    expect(recorded.sessionNames).toContain("newproj");
  });

  it("never offers creation for unsafe names even with '!'", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    for (const unsafe of ["../x!", "a/b!", ".hidden!", "/abs!", "..!"]) {
      const ctx = createFakeCtx({
        ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
      });
      const cmd = recorded.commands.find((c) => c.name === "project")!;
      await cmd.options.handler(unsafe, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      const msgs = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]);
      expect(msgs.some((m: string) => m.includes("Unknown project"))).toBe(true);
    }
    expect(existsSync(join(baseDir, "x"))).toBe(false);
    expect(existsSync(join(baseDir, "a"))).toBe(false);
    expect(existsSync(join(baseDir, ".hidden"))).toBe(false);
  });

  it("reports mkdir failure and keeps state unchanged", async () => {
    makeProjects(["alpha"]);
    // occupy the name with a file so mkdir fails
    writeFileSync(join(baseDir, "blocked"), "occupied", "utf8");

    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({
      ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
    });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("blocked", ctx);

    const msgs = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]);
    expect(msgs.some((m: string) => m.includes("Failed to create project folder"))).toBe(true);
    expect(recorded.sessionNames).toHaveLength(0);
  });

  it("headless without '!' keeps the plain warning", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ hasUI: false });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("newproj", ctx);

    expect(existsSync(join(baseDir, "newproj"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown project: "newproj"'),
      "warning"
    );
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

// ── Surface-adaptive status (telegram flag, TUI select, plain list) ────────

describe("telegram status flag: input handler arming", () => {
  async function armWith(
    pi: any,
    handlers: Map<string, Handler>,
    text: string,
    source = "extension"
  ) {
    await fire("input", handlers, { type: "input", text, source }, createFakeCtx());
  }

  it("arms on bare [telegram] /project first line", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);
    expect(handlers.has("input")).toBe(true);

    await armWith(pi, handlers, "[telegram] /project");
    // armed: a status call in mode "rpc" now takes the telegram path
    makeProjects(["alpha"]);
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect((pi.sendUserMessage as any).mock.calls[0][0]).toContain("telegram_button");
  });

  it("does not arm for /project with arguments", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await armWith(pi, handlers, "[telegram] /project alpha");
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("arms for attribute variants like [telegram|thread:x]", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await armWith(pi, handlers, "[telegram|thread:dev] /project");
    makeProjects(["alpha"]);
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("arms when pi-telegram context sections follow the first line", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await armWith(pi, handlers, "[telegram] /project\n\n[time] 2026-09-17 08:00:00 Europe/Berlin");
    makeProjects(["alpha"]);
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not arm for interactive source", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await armWith(pi, handlers, "[telegram] /project", "interactive");
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("clears the flag on session_start", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await armWith(pi, handlers, "[telegram] /project");
    await fire("session_start", handlers, { type: "session_start" }, createFakeCtx());

    makeProjects(["alpha"]);
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("telegram status output", () => {
  async function runStatusAfterArm(mode = "rpc") {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );

    const ctx = createFakeCtx({ mode });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    return { pi, recorded, ctx };
  }

  it("sends one follow-up with list, button block, and /project prompts", async () => {
    const { pi, ctx } = await runStatusAfterArm();

    // local surface parity: plain list notify
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

    // exactly one follow-up turn
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [content, options] = (pi.sendUserMessage as any).mock.calls[0];
    expect(options).toEqual({ deliverAs: "followUp" });

    // authoritative list included
    expect(content).toContain("alpha");
    expect(content).toContain("beta");

    // pre-rendered button block with one cell per project
    expect(content).toContain("```telegram_button");
    expect(content).toContain("{📁 alpha|/project alpha}");
    expect(content).toContain("{📁 beta|/project beta}");
  });

  it("marks the active project first with an active-styled button", async () => {
    makeProjects(["alpha", "beta", "gamma"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    // make beta active via a switch
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("beta", createFakeCtx({ sessionManager: { getEntries: () => [] as any[], getSessionFile: () => undefined } }));

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );
    const ctx = createFakeCtx({ mode: "rpc" });
    await cmd.options.handler("", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2); // switch announce + status
    const statusContent = (pi.sendUserMessage as any).mock.calls[1][0] as string;
    const activeIdx = statusContent.indexOf("{✅ beta (active)|/project beta}");
    const alphaIdx = statusContent.indexOf("{📁 alpha|/project alpha}");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(alphaIdx);
    expect(statusContent).toContain("◀ active");
  });

  it("omits the button cell for unsafe project names", async () => {
    makeProjects(["alpha", "a{b"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    const content = (pi.sendUserMessage as any).mock.calls[0][0] as string;
    expect(content).toContain("a{b"); // still listed as plain text
    expect(content).not.toContain("/project a{b"); // but no button prompt for it
    expect(content).toContain("{📁 alpha|/project alpha}");
  });

  it("expires the flag after the TTL", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );

    // fake timers to push the armed timestamp past the TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);
    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);
    vi.useRealTimers();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // plain list fallback
  });

  it("consumes the flag exactly once", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );

    makeProjects(["alpha"]);
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", createFakeCtx({ mode: "rpc" }));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // second, native status call: no telegram path anymore
    await cmd.options.handler("", createFakeCtx({ mode: "rpc" }));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("no projects: warning only, no follow-up", async () => {
    const { pi, recorded, handlers } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    await fire(
      "input",
      handlers,
      { type: "input", text: "[telegram] /project", source: "extension" },
      createFakeCtx()
    );

    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No projects found"),
      "warning"
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("TUI status: selection dialog", () => {
  it("selecting a project runs the shared switch flow", async () => {
    makeProjects(["alpha", "beta"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const select = vi.fn(async () => "beta");
    const ctx = createFakeCtx({ mode: "tui" });
    (ctx.ui as any).select = select;

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(select).toHaveBeenCalledWith("Switch project", ["alpha", "beta"]);
    expect(recorded.entries).toContainEqual({
      customType: "project-switcher-state",
      data: expect.objectContaining({ project: "beta" }),
    });
    expect(recorded.sessionNames).toContain("beta");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Switched to beta"),
      "info"
    );
  });

  it("dismissing the dialog falls back to the plain list", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const select = vi.fn(async () => undefined);
    const ctx = createFakeCtx({ mode: "tui" });
    (ctx.ui as any).select = select;

    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(select).toHaveBeenCalled();
    expect(recorded.entries).toHaveLength(0);
    expect(recorded.sessionNames).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const msg = (ctx.ui.notify as any).mock.calls[0][0] as string;
    expect(msg).toContain("alpha");
    expect(msg).toContain("Projects under");
  });
});

describe("plain status on other surfaces", () => {
  it("rpc without telegram flag: plain list only", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ mode: "rpc" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect((ctx.ui as any).select).not.toHaveBeenCalled();
  });

  it("print mode: plain list only", async () => {
    makeProjects(["alpha"]);
    const { pi, recorded } = createFakePi();
    const { default: factory } = await loadExtension();
    factory(pi);

    const ctx = createFakeCtx({ mode: "print" });
    const cmd = recorded.commands.find((c) => c.name === "project")!;
    await cmd.options.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
