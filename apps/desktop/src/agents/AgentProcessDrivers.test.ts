import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./AgentDriver";
import { createDesktopAgentDrivers } from "./AgentProcessDrivers";
import { resolveSpawnCommand } from "../process/windowsSpawn";
import { createTestScratch } from "../workspaces/testTemp";

const fakeAgent = fileURLToPath(new URL("../../e2e/fixtures/fakeAgentProcess.mjs", import.meta.url));

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(message);
    },
    { timeout: timeoutMs, interval: 25 },
  );
}

async function workspaceRoot(): Promise<string> {
  const root = join(await createTestScratch("dohc-agent-driver-"), "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  return root;
}

describe("process-backed agent drivers", () => {
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
      // its argv intact even when the shim path contains spaces. Every token
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
});
