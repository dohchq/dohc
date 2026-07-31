import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "./AgentDriver";
import { createDesktopAgentDrivers } from "./AgentProcessDrivers";
import { resolveSpawnCommand } from "../process/windowsSpawn";

const fakeAgent = fileURLToPath(new URL("../../e2e/fixtures/fakeAgentProcess.mjs", import.meta.url));
const tempRoots: string[] = [];

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function workspaceRoot(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "dohc-agent-driver-")), "workspace");
  tempRoots.push(dirname(root));
  await mkdir(join(root, "notes"), { recursive: true });
  return root;
}

describe("process-backed agent drivers", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("routes Windows npm command shims through ComSpec with argv preserved", () => {
    const resolved = resolveSpawnCommand("codex", ["app-server"], {
      platform: "win32",
      env: {
        Path: "C:\\Users\\ice\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      exists: (candidate) => candidate === "C:\\Users\\ice\\AppData\\Roaming\\npm\\codex.CMD",
    });

    expect(resolved).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      // One outer-quoted /s /c command line, passed verbatim so Node cannot
      // re-quote it — cmd.exe strips the outer quotes and runs the shim with
      // its argv intact even when the shim path contains spaces. EVERY token
      // is quoted so cmd metacharacters (& | < > ^) inside arguments are
      // inert instead of being parsed as command separators.
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\ice\\AppData\\Roaming\\npm\\codex.CMD" "app-server""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("runs the fake ACP lifecycle and answers permission options by kind", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_GENERIC_ACP_COMMAND: process.execPath,
      DOHC_AGENT_GENERIC_ACP_ARGS_JSON: JSON.stringify([fakeAgent, "acp"]),
    }).find((entry) => entry.id === "generic-acp");
    expect(driver).toBeDefined();
    const probe = await driver!.probe();
    expect(probe).toMatchObject({ installed: true, version: "fake-acp 1.0.0" });

    const events: AgentEvent[] = [];
    const session = await driver!.startSession({
      workspaceRoot: root,
      mode: "approval-required",
      mcp: { command: "dohc-mcp", args: ["--workspace", root] },
      onEvent: (event) => events.push(event),
    });
    await session.prompt({ text: "write the note" });
    await waitFor(
      () => events.some((event) => event.kind === "permission-request"),
      "ACP permission request did not arrive.",
    );
    const permission = events.find(
      (event): event is Extract<AgentEvent, { kind: "permission-request" }> =>
        event.kind === "permission-request",
    );
    expect(permission?.options.map((option) => option.kind)).toContain("allow_once");
    expect(permission?.options.map((option) => option.kind)).toContain("reject_always");
    await session.answerPermission(permission!.requestId, "allow_once");
    await waitFor(
      () => events.some((event) => event.kind === "turn-completed"),
      "ACP turn did not complete.",
    );
    await expect(readFile(join(root, "notes", "agent-output.md"), "utf8")).resolves.toContain(
      "Fake ACP wrote this",
    );
    await session.dispose();
  });

  it("passes MCP env through the ACP session config", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_GENERIC_ACP_COMMAND: process.execPath,
      DOHC_AGENT_GENERIC_ACP_ARGS_JSON: JSON.stringify([fakeAgent, "acp-require-mcp-env"]),
    }).find((entry) => entry.id === "generic-acp");
    expect(driver).toBeDefined();

    const session = await driver!.startSession({
      workspaceRoot: root,
      mode: "approval-required",
      mcp: {
        command: "dohc-mcp",
        args: ["--workspace", root],
        env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
      },
      onEvent: () => {},
    });
    await session.dispose();
  });

  it("runs the fake Codex app-server lifecycle and rejects token refresh storage", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_CODEX_COMMAND: process.execPath,
      DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeAgent, "codex"]),
    }).find((entry) => entry.id === "codex-app-server");
    expect(driver).toBeDefined();
    const probe = await driver!.probe();
    expect(probe).toMatchObject({ installed: true, version: "fake-codex 1.0.0" });

    const events: AgentEvent[] = [];
    const session = await driver!.startSession({
      workspaceRoot: root,
      mode: "approval-required",
      mcp: { command: "dohc-mcp", args: ["--workspace", root] },
      onEvent: (event) => events.push(event),
    });
    await session.prompt({ text: "write the codex note" });
    await waitFor(
      () => events.some((event) => event.kind === "permission-request"),
      "Codex approval request did not arrive.",
    );
    const permission = events.find(
      (event): event is Extract<AgentEvent, { kind: "permission-request" }> =>
        event.kind === "permission-request",
    );
    expect(permission?.options.map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    await session.answerPermission(permission!.requestId, "allow_once");
    await waitFor(
      () => events.some((event) => event.kind === "turn-completed"),
      "Codex turn did not complete.",
    );
    expect(
      events.some(
        (event) =>
          event.kind === "auth" &&
          event.event === "login-required" &&
          event.detail === "Codex CLI manages ChatGPT token refresh.",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          !event.fatal &&
          event.message.includes("requested user input"),
      ),
    ).toBe(true);
    await expect(readFile(join(root, "notes", "codex-output.md"), "utf8")).resolves.toContain(
      "Fake Codex wrote this",
    );
    await session.dispose();
  });

  it("passes MCP env through the Codex app-server config", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_CODEX_COMMAND: process.execPath,
      DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeAgent, "codex-require-mcp-env"]),
    }).find((entry) => entry.id === "codex-app-server");
    expect(driver).toBeDefined();

    const session = await driver!.startSession({
      workspaceRoot: root,
      mode: "approval-required",
      mcp: {
        command: "dohc-mcp",
        args: ["--workspace", root],
        env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
      },
      onEvent: () => {},
    });
    await session.dispose();
  });

  it("disposes a fake ACP process when initialization fails", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_GENERIC_ACP_COMMAND: process.execPath,
      DOHC_AGENT_GENERIC_ACP_ARGS_JSON: JSON.stringify([fakeAgent, "acp-fail-init"]),
    }).find((entry) => entry.id === "generic-acp");
    expect(driver).toBeDefined();
    const events: AgentEvent[] = [];

    await expect(
      driver!.startSession({
        workspaceRoot: root,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", root] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("fake ACP init failed");
    await waitFor(
      () => events.some((event) => event.kind === "session-state" && event.state === "closed"),
      "Failed ACP process did not close.",
    );
  });

  it("disposes a fake Codex process when thread start fails", async () => {
    const root = await workspaceRoot();
    const driver = createDesktopAgentDrivers({
      DOHC_AGENT_CODEX_COMMAND: process.execPath,
      DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeAgent, "codex-fail-thread"]),
    }).find((entry) => entry.id === "codex-app-server");
    expect(driver).toBeDefined();
    const events: AgentEvent[] = [];

    await expect(
      driver!.startSession({
        workspaceRoot: root,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", root] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("fake Codex thread failed");
    await waitFor(
      () => events.some((event) => event.kind === "session-state" && event.state === "closed"),
      "Failed Codex process did not close.",
    );
  });
});
