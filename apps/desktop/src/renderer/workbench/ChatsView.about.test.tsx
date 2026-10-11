// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAboutConversation } from "./aboutConversation";
import { chatTabPath } from "./workbenchState";
import { ChatsView, bridgeMock, channel, dm } from "./ChatsView.testHarness";

// What About reads for a conversation tab, as JSON: undefined while loading.
function AboutProbe(props: { workspaceId: string; tabPath: string }) {
  const entry = useAboutConversation(props.workspaceId, props.tabPath);
  return <output data-testid="about-probe">{entry === undefined ? "loading" : JSON.stringify(entry)}</output>;
}

function renderTab(tabPath: string, workspaceId = "workspace-a") {
  return render(
    <>
      <ChatsView workspaceId={workspaceId} onOpenFileChat={vi.fn()} onError={vi.fn()} variant="page" editorTabPath={tabPath} />
      <AboutProbe workspaceId="workspace-a" tabPath={tabPath} />
    </>,
  );
}

const probe = () => screen.getByTestId("about-probe").textContent;

describe("a conversation tab tells About what it shows", () => {
  it("publishes a Group with its wire identity, once shares say it is this workspace's own", async () => {
    const tabPath = chatTabPath({ kind: "channel", id: "channel-1" });
    renderTab(tabPath);
    await waitFor(() => expect(JSON.parse(probe() ?? "")).toEqual({
      kind: "group", name: "general", channelWireId: "channel-1", received: false, present: [],
    }));
  });

  it("publishes a person's direct message, read through their share", async () => {
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [dm({ role: "participant", shareId: "share-dm", peerLabel: "Sam Rivera" })],
    });
    const tabPath = chatTabPath({ kind: "dm", id: dm().channelId });
    renderTab(tabPath);
    await waitFor(() => expect(JSON.parse(probe() ?? "")).toEqual({
      kind: "person", name: "Sam Rivera", channelWireId: "wire-dm-1", received: true, present: [],
    }));
  });

  it("publishes the agent's chat under the tab's name", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "agent-1", name: "agent", slug: "agent", kind: "agent" })],
      fileThreads: [],
    });
    renderTab(chatTabPath({ kind: "channel", id: "agent-1" }));
    await waitFor(() => expect(JSON.parse(probe() ?? "")).toMatchObject({
      kind: "agent", name: "My agent", channelWireId: "agent-1", received: false,
    }));
  });

  it("says it shows nothing once its Group is gone", async () => {
    renderTab(chatTabPath({ kind: "channel", id: "channel-gone" }));
    await waitFor(() => expect(probe()).toBe('"none"'));
  });

  it("publishes under its own workspace only, and withdraws when it unmounts", async () => {
    const tabPath = chatTabPath({ kind: "channel", id: "channel-1" });
    const other = renderTab(tabPath, "workspace-b");
    await waitFor(() => expect(bridgeMock.listChannelThreads).toHaveBeenCalled());
    expect(probe()).toBe("loading");
    other.unmount();

    const view = renderTab(tabPath);
    await waitFor(() => expect(probe()).not.toBe("loading"));
    view.rerender(<AboutProbe workspaceId="workspace-a" tabPath={tabPath} />);
    expect(probe()).toBe("loading");
  });
});
