import { describe, expect, it, vi } from "vitest";
import { CLI_PROTOCOL_VERSION, cliTransportResponseSchema } from "@dohc/cli/protocol";
import { handleCliRequestLine, type CliServerOptions } from "./cliServer";

const token = "a".repeat(64);
const server = "https://dohc.example.test";
const preview = {
  email: "ice@dohc.dev", server, workspaces: [], workspacesElsewhere: 0,
  storedBytes: 0, ownedShareCount: 0, heldGrantCount: 0, previewToken: "expiry.digest.signature",
};

function options(serverAccount?: CliServerOptions["serverAccount"]) {
  const listWorkspaces = vi.fn(() => []);
  const openWorkspace = vi.fn(async () => { throw new Error("no workspace"); });
  const value: CliServerOptions = {
    stateDir: "unused", listWorkspaces, openWorkspace,
    // Account verbs never reach chat; the collaborator stays unused.
    chatWrites: {} as CliServerOptions["chatWrites"],
    localUserDisplayName: () => "Ice", localPersonId: () => "person", agentRunDepth: () => 0,
    dispatchedAgentRun: () => false,
    agentRunWorkspace: () => undefined,
    ...(serverAccount ? { serverAccount } : {}),
  };
  return { value, listWorkspaces, openWorkspace };
}

async function send(verb: string, args: Record<string, unknown>, serverOptions: CliServerOptions) {
  const line = await handleCliRequestLine(JSON.stringify({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args }), token, serverOptions);
  return cliTransportResponseSchema.parse(JSON.parse(line) as unknown);
}

describe("CLI account verbs", () => {
  it("preview and delete outside any workspace, through the app's account client", async () => {
    const deleted = { ok: true as const, finished: true, email: "ice@dohc.dev", server, disconnectError: null };
    const account = { preview: vi.fn(async () => preview), delete: vi.fn(async () => deleted) };
    const o = options(account);
    const base = { cwd: "/not/a/workspace", actor: "agent" };

    await expect(send("accountDeletePreview", base, o.value)).resolves.toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: true, result: preview });
    await expect(send("accountDelete", { ...base, server, previewToken: preview.previewToken, password: "secret" }, o.value))
      .resolves.toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: true, result: deleted });

    expect(account.delete).toHaveBeenCalledWith({ server, previewToken: preview.previewToken, password: "secret" });
    expect(o.listWorkspaces).not.toHaveBeenCalled();
    expect(o.openWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a delete without a password before the account client runs", async () => {
    const account = { preview: vi.fn(async () => preview), delete: vi.fn(async () => ({ ok: true as const, finished: true, email: "e", server, disconnectError: null })) };
    const response = await send("accountDelete", { cwd: "/", actor: "human", server, previewToken: "t", password: "" }, options(account).value);
    expect(response).toMatchObject({ ok: false, error: "dohc: invalid CLI request" });
    expect(account.delete).not.toHaveBeenCalled();
  });

  it("keeps the password out of a failure", async () => {
    const account = { preview: vi.fn(async () => preview), delete: vi.fn(async () => { throw new Error("dohc could not reach this server."); }) };
    const response = await send("accountDelete", { cwd: "/", actor: "human", server, previewToken: "t", password: "secret" }, options(account).value);
    expect(response).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: "dohc: dohc could not reach this server." });
  });
});
