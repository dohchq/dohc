import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { devToolsEnabled, registerDevToolsIpcHandlers } from "./devToolsIpc";

function harness(enabled: boolean) {
  type Event = { trusted: boolean };
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const forgetWorkspace = vi.fn(async (_workspaceId: string) => undefined);
  const showItemInFolder = vi.fn();
  const relaunch = vi.fn();
  registerDevToolsIpcHandlers<Event>({
    enabled,
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: (event) => {
      if (!event.trusted) throw new Error("untrusted");
    },
    listWorkspaces: () => [
      { workspaceId: "a", rootPath: "/w/a" },
      { workspaceId: "b", rootPath: "/w/b" },
    ],
    forgetWorkspace,
    stateDir: () => "/state",
    showItemInFolder,
    relaunch,
  });
  const invoke = (channel: string, payload?: unknown, trusted = true) =>
    handlers.get(channel)!({ trusted }, payload);
  return { handlers, invoke, forgetWorkspace, showItemInFolder, relaunch };
}

describe("dev tools ipc", () => {
  it("is double-gated on the env flag and an unpackaged build", () => {
    expect(devToolsEnabled({ DOHC_DEV_TOOLS: "1" }, { isPackaged: false })).toBe(true);
    expect(devToolsEnabled({ DOHC_DEV_TOOLS: "1" }, { isPackaged: true })).toBe(false);
    expect(devToolsEnabled({}, { isPackaged: false })).toBe(false);
  });

  it("registers nothing when disabled", () => {
    expect(harness(false).handlers.size).toBe(0);
  });

  it("refuses untrusted senders on every channel", async () => {
    const h = harness(true);
    for (const channel of h.handlers.keys()) {
      await expect(async () => h.invoke(channel, { target: "state-dir" }, false)).rejects.toThrow("untrusted");
    }
  });

  it("forgets every registered workspace and reports the count", async () => {
    const h = harness(true);
    await expect(h.invoke(CHANNELS.devForgetWorkspaces)).resolves.toEqual({ forgot: 2 });
    expect(h.forgetWorkspace.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("reveals the state dir or a registered workspace root", async () => {
    const h = harness(true);
    await h.invoke(CHANNELS.devRevealPath, { target: "state-dir" });
    await h.invoke(CHANNELS.devRevealPath, { target: "workspace", workspaceId: "b" });
    expect(h.showItemInFolder.mock.calls.map(([path]) => path)).toEqual(["/state", "/w/b"]);
    await expect(async () =>
      h.invoke(CHANNELS.devRevealPath, { target: "workspace", workspaceId: "nope" }),
    ).rejects.toThrow("not in the registry");
  });

  it("relaunches on request", async () => {
    const h = harness(true);
    await h.invoke(CHANNELS.devRelaunch);
    expect(h.relaunch).toHaveBeenCalledOnce();
  });
});
