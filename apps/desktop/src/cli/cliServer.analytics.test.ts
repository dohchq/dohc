import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  handleCliRequestLine,
  type CliServerOptions,
  type CliToolInvocationEvent,
} from "./cliServer";

const token = "a".repeat(64);
const server = "https://dohc.example.test";
const preview = {
  email: "ice@dohc.dev",
  server,
  workspaces: [],
  workspacesElsewhere: 0,
  storedBytes: 0,
  ownedShareCount: 0,
  heldGrantCount: 0,
  previewToken: "expiry.digest.signature",
};

function createOptions(
  events: CliToolInvocationEvent[],
  serverAccount?: CliServerOptions["serverAccount"],
): CliServerOptions {
  return {
    stateDir: "unused",
    listWorkspaces: () => [],
    openWorkspace: async () => {
      throw new Error("no workspace");
    },
    chatWrites: {} as CliServerOptions["chatWrites"],
    localUserDisplayName: () => "Ice",
    localPersonId: () => "person",
    agentRunDepth: () => 0,
    dispatchedAgent: () => null,
    dispatchedRunId: () => null,
    dispatchedRunSecret: () => null,
    agentWriteRunId: () => null,
    agentRunWorkspace: () => undefined,
    connectedAgent: async () => null,
    onToolInvoked: (event) => events.push(event),
    ...(serverAccount ? { serverAccount } : {}),
  };
}

describe("CLI and MCP tool_invoked analytics", () => {
  it("skips successful reads, counts writes, classifies refusals and errors, and ignores aborted requests", async () => {
    const events: CliToolInvocationEvent[] = [];
    const serverAccount = {
      preview: vi.fn(async () => preview),
      delete: vi.fn(async () => ({
        ok: true as const,
        finished: true,
        email: "ice@dohc.dev",
        server,
        disconnectError: null,
      })),
    };
    const options = createOptions(events, serverAccount);
    const base = { cwd: "/not/a/workspace", actor: "agent" };

    await handleCliRequestLine(
      JSON.stringify({
        token,
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "accountDeletePreview",
        args: base,
      }),
      token,
      options,
    );
    expect(events).toEqual([]);

    await handleCliRequestLine(
      JSON.stringify({
        token,
        protocolVersion: CLI_PROTOCOL_VERSION,
        door: "mcp",
        verb: "accountDelete",
        args: { ...base, server, previewToken: preview.previewToken, password: "secret" },
      }),
      token,
      options,
    );
    expect(events).toEqual([
      {
        door: "mcp",
        capabilityId: "account.delete",
        outcome: "ok",
        durationMs: expect.any(Number),
      },
    ]);

    events.length = 0;
    await handleCliRequestLine(
      JSON.stringify({
        token,
        protocolVersion: CLI_PROTOCOL_VERSION,
        workspaceId: "missing-workspace",
        verb: "accountDelete",
        args: { ...base, server, previewToken: preview.previewToken, password: "secret" },
      }),
      token,
      options,
    );
    expect(events).toEqual([
      {
        door: "cli",
        capabilityId: "account.delete",
        outcome: "refused",
        durationMs: expect.any(Number),
      },
    ]);

    events.length = 0;
    serverAccount.preview.mockRejectedValueOnce(new Error("relay down"));
    await handleCliRequestLine(
      JSON.stringify({
        token,
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "accountDeletePreview",
        args: base,
      }),
      token,
      options,
    );
    expect(events).toEqual([
      {
        door: "cli",
        capabilityId: "account.delete.preview",
        outcome: "error",
        durationMs: expect.any(Number),
      },
    ]);

    events.length = 0;
    const controller = new AbortController();
    controller.abort();
    serverAccount.preview.mockRejectedValueOnce(new Error("aborted"));
    await handleCliRequestLine(
      JSON.stringify({
        token,
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "accountDeletePreview",
        args: base,
      }),
      token,
      options,
      controller.signal,
    );
    expect(events).toEqual([]);
  });
});
