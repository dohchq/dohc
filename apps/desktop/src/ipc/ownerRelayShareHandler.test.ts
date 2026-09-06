import { describe, expect, it, vi } from "vitest";
import { createOwnerRelayShareHandler } from "./ownerRelayShareHandler";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";

function harness() {
  const workspace = {
    workspaceId: "workspace",
    attachmentId: Symbol("attachment"),
  };
  let active = true;
  let generation = 1;
  const withWorkspaceOperation = createRendererWorkspaceOperationRunner({
    currentSession: (_sender: string) => ({
      ...workspace,
      generation: 1,
      isCurrent: () => active,
    }),
    withPhysicalOperation: async <Result>(
      _workspaceId: string,
      work: (operation: {
        workspace: typeof workspace;
        state: object;
        signal: AbortSignal;
        assertCurrent(): void;
      }) => Result | Promise<Result>,
    ) =>
      work({
        workspace,
        state: {},
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
  });
  const remoteForWorkspace = vi.fn(async () => ({
    credentials: { token: "account-one" },
    credentialGeneration: generation,
  }));
  const handle = createOwnerRelayShareHandler({
    withWorkspaceOperation,
    remoteForWorkspace,
    credentialGeneration: () => generation,
  });
  const relay = vi.fn(async (_token: string) => "share");
  const write = vi.fn();
  const invoke = (assertWorkspace?: () => void) =>
    handle(
      "sender",
      workspace.workspaceId,
      async (_operation, credentials, session) => {
        const share = await session.run(() => relay(credentials.token));
        write(share);
        return share;
      },
      assertWorkspace,
    );
  return {
    invoke,
    remoteForWorkspace,
    relay,
    write,
    retire: () => {
      active = false;
    },
    switchAccount: () => {
      generation += 1;
    },
  };
}

describe("owner relay share handlers", () => {
  it("refuses a disallowed workspace before credentials, relay work, or storage", async () => {
    const h = harness();
    await expect(
      h.invoke(() => {
        throw new Error("shared view");
      }),
    ).rejects.toThrow("shared view");
    expect(h.remoteForWorkspace).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("does not start a request when workspace ownership cannot authorize credentials", async () => {
    const h = harness();
    h.remoteForWorkspace.mockRejectedValue(new Error("wrong account"));
    await expect(h.invoke()).rejects.toThrow("wrong account");
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each(["retire", "switchAccount"] as const)(
    "rejects %s during credential loading before the relay call",
    async (invalidate) => {
      const h = harness();
      const credentials = Promise.withResolvers<{
        credentials: { token: string };
        credentialGeneration: number;
      }>();
      h.remoteForWorkspace.mockReturnValue(credentials.promise);
      const result = h.invoke();
      h[invalidate]();
      credentials.resolve({
        credentials: { token: "account-one" },
        credentialGeneration: 1,
      });
      await expect(result).rejects.toThrow();
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it.each(["retire", "switchAccount"] as const)(
    "rejects %s during relay work before writing its result",
    async (invalidate) => {
      const h = harness();
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<string>();
      h.relay.mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      const result = h.invoke();
      await started.promise;
      h[invalidate]();
      response.resolve("share");
      await expect(result).rejects.toThrow();
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it("uses the authorized credential snapshot and returns the current result", async () => {
    const h = harness();
    await expect(h.invoke()).resolves.toBe("share");
    expect(h.relay).toHaveBeenCalledWith("account-one");
    expect(h.write).toHaveBeenCalledWith("share");
  });
});
