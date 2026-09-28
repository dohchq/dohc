// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { CUSTOMIZE_TARGETS } from "../settings/customize";
import { useAskAgent } from "./useAskAgent";

const agentChannel = { id: "agent-channel", kind: "agent", name: "Agent" };
const setup = { agentName: "Scout", runnerConfigured: true, runnerEnabled: true, mcpEnabled: false };

function stubBridge(channels: unknown[] = [agentChannel]) {
  const bridge = {
    getUserSettingsFilePath: vi.fn(async () => "/state/settings.json"),
    listChatChannels: vi.fn(async (_input: { workspaceId: string }) => ({ channels })),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  return bridge;
}

function renderAskAgent(overrides: { agentSetup?: typeof setup | null; chatsAvailable?: boolean } = {}) {
  const input = {
    workspaceId: "ws-1",
    agentSetup: overrides.agentSetup === undefined ? setup : overrides.agentSetup,
    chatsAvailable: overrides.chatsAvailable ?? true,
    openChat: vi.fn((_nav: unknown, _prefill: string) => true),
    onOpenChat: vi.fn(),
    onSetUp: vi.fn(),
    reportShellError: vi.fn(),
  };
  const hook = renderHook((props: typeof input) => useAskAgent(props), { initialProps: input });
  return { ...hook, input };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAskAgent", () => {
  it("opens the agent's chat with a request that names the file", async () => {
    stubBridge();
    const { result, input } = renderAskAgent();
    expect(result.current?.ready).toBe(true);

    act(() => result.current?.ask({ kind: "settings", target: CUSTOMIZE_TARGETS.sidebar }));

    await waitFor(() => expect(input.openChat).toHaveBeenCalledOnce());
    const [nav, text] = input.openChat.mock.calls[0]!;
    expect(nav).toEqual({ level: "channel", channel: agentChannel });
    expect(text).toContain('They are the "sidebar" key in my dohc settings file, /state/settings.json.');
    expect(input.onOpenChat).toHaveBeenCalledOnce();
    expect(input.reportShellError).not.toHaveBeenCalled();
  });

  it("reports a missing agent chat with Try again", async () => {
    const bridge = stubBridge([]);
    const { result, input } = renderAskAgent();

    act(() => result.current?.ask({ kind: "app" }));

    await waitFor(() => expect(input.reportShellError).toHaveBeenCalledOnce());
    const [message, , retry] = input.reportShellError.mock.calls[0]!;
    expect(message).toBe("dohc could not find your agent's chat. Check your agent in Settings, then try again.");
    expect(input.openChat).not.toHaveBeenCalled();

    bridge.listChatChannels.mockResolvedValue({ channels: [agentChannel] });
    act(() => retry());
    await waitFor(() => expect(input.openChat).toHaveBeenCalledOnce());
  });

  it("says so when the agent's chat keeps a reply the person has not sent", async () => {
    stubBridge();
    const { result, input } = renderAskAgent();
    input.openChat.mockReturnValueOnce(false);

    act(() => result.current?.ask({ kind: "app" }));

    await waitFor(() => expect(input.reportShellError).toHaveBeenCalledOnce());
    expect(input.reportShellError.mock.calls[0]![0]).toBe(
      "Your agent's chat has a reply you have not sent. Send or clear it, then try again.",
    );
  });

  it("drops an answer for a workspace the shell has left", async () => {
    const bridge = stubBridge();
    const answer = deferred<{ channels: unknown[] }>();
    bridge.listChatChannels.mockReturnValueOnce(answer.promise);
    const { result, input, rerender } = renderAskAgent();

    act(() => result.current?.ask({ kind: "app" }));
    rerender({ ...input, workspaceId: "ws-2" });
    await act(async () => answer.resolve({ channels: [agentChannel] }));

    expect(input.openChat).not.toHaveBeenCalled();
    expect(input.reportShellError).not.toHaveBeenCalled();
  });

  it("offers nothing while chats are off or the agent's setup is unknown", () => {
    stubBridge();
    expect(renderAskAgent({ chatsAvailable: false }).result.current).toBeUndefined();
    expect(renderAskAgent({ agentSetup: null }).result.current).toBeUndefined();
    expect(renderAskAgent({ agentSetup: { ...setup, runnerEnabled: false } }).result.current?.ready).toBe(false);
  });
});
