// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PresencePeer, PresenceSnapshot, PresenceTransport } from "../collab/presenceChannel";
import { useAboutConversation } from "./aboutConversation";
import type { ChatPresenceCollaboration } from "./ChatsView";
import { chatTabPath } from "./workbenchState";
import { ChatsView, bridgeMock, channel, dm } from "./ChatsView.testHarness";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { settingsWithAgent, testAgent } from "../../testing/agentSettings";

// What About reads for a conversation tab in one workspace, as JSON:
// "loading" while nothing is published.
function AboutProbe(props: { workspaceId: string; tabPath: string }) {
  const entry = useAboutConversation(props.workspaceId, props.tabPath);
  return (
    <output data-testid={`about-probe-${props.workspaceId}`}>
      {entry === undefined ? "loading" : JSON.stringify(entry)}
    </output>
  );
}

function renderTab(tabPath: string, options: { workspaceId?: string; collaboration?: ChatPresenceCollaboration; userSettings?: DesktopUserSettings } = {}) {
  return render(
    <>
      <ChatsView workspaceId={options.workspaceId ?? "workspace-a"} onOpenFileChat={vi.fn()} onError={vi.fn()}
        variant="page" editorTabPath={tabPath} collaboration={options.collaboration ?? null} userSettings={options.userSettings} />
      <AboutProbe workspaceId="workspace-a" tabPath={tabPath} />
      <AboutProbe workspaceId="workspace-b" tabPath={tabPath} />
    </>,
  );
}

const probe = (workspaceId = "workspace-a") => screen.getByTestId(`about-probe-${workspaceId}`).textContent;
const published = (workspaceId = "workspace-a") => JSON.parse(probe(workspaceId) ?? "") as unknown;

// One presence snapshot for every topic, pushed by the test.
function presenceWith(peers: PresencePeer[]): ChatPresenceCollaboration {
  const snapshot: PresenceSnapshot = { version: 1, peers };
  const transport: PresenceTransport = {
    async publish() { return snapshot; },
    async leave() {},
    poll({ since, signal }) {
      if (since !== snapshot.version) return Promise.resolve(snapshot);
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(snapshot), { once: true }));
    },
  };
  return { transportForScope: () => transport, clientId: "me", displayName: "Me" };
}

const peer = (sessionToken: string, displayName: string, state: unknown): PresencePeer => ({
  faceToken: sessionToken, sessionToken, isSelf: false, displayName, paletteSlot: 1, state, updatedAtMs: 0,
});

describe("a conversation tab tells About what it shows", () => {
  it("publishes a Group with its wire identity, once shares say it is this workspace's own", async () => {
    const tabPath = chatTabPath({ kind: "channel", id: "channel-1" });
    renderTab(tabPath);
    await waitFor(() => expect(published()).toEqual({
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
    await waitFor(() => expect(published()).toEqual({
      kind: "person", name: "Sam Rivera", channelWireId: "wire-dm-1", received: true, present: [],
    }));
  });

  it("publishes an agent's chat under that agent's name, as its tab shows it", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "agent-1", name: "My agent", slug: "agent", kind: "agent", agentId: "default" }),
        channel({ id: "agent-2", name: "Scout", slug: "agent-scout", kind: "agent", agentId: "scout" }),
      ],
      fileThreads: [],
    });
    const settings = settingsWithAgent({ name: "Nova" });
    renderTab(chatTabPath({ kind: "channel", id: "agent-2" }), {
      userSettings: { ...settings, agents: { ...settings.agents, scout: testAgent({ name: "Ranger", hue: "teal" }) } },
    });
    await waitFor(() => expect(published()).toMatchObject({
      kind: "agent", name: "Ranger", channelWireId: "agent-2", received: false,
    }));
  });

  it("leaves the agent out of the faces in its own chat, as the page's header does", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "agent-1", name: "agent", slug: "agent", kind: "agent", agentId: "default" })],
      fileThreads: [],
    });
    const collaboration = presenceWith([
      peer("agent:workspace-a", "Me", { displayName: "Me", agent: true, activity: "working" }),
      peer("sam", "Sam Rivera", { displayName: "Sam Rivera" }),
    ]);
    renderTab(chatTabPath({ kind: "channel", id: "agent-1" }), { collaboration });
    await waitFor(() => {
      const entry = published() as { present?: PresencePeer[] };
      expect(entry.present?.map((face) => face.sessionToken)).toEqual(["sam"]);
    });
  });

  it("keeps the agent in a Group's faces", async () => {
    const collaboration = presenceWith([
      peer("agent:workspace-a", "Me", { displayName: "Me", agent: true, activity: "working" }),
      peer("sam", "Sam Rivera", { displayName: "Sam Rivera" }),
    ]);
    renderTab(chatTabPath({ kind: "channel", id: "channel-1" }), { collaboration });
    await waitFor(() => {
      const entry = published() as { present?: PresencePeer[] };
      expect(entry.present?.map((face) => face.sessionToken)).toEqual(["agent:workspace-a", "sam"]);
    });
  });

  it("says it shows nothing once its Group is gone", async () => {
    renderTab(chatTabPath({ kind: "channel", id: "channel-gone" }));
    await waitFor(() => expect(probe()).toBe('"none"'));
  });

  it("publishes under its own workspace only, and withdraws when it unmounts", async () => {
    const tabPath = chatTabPath({ kind: "channel", id: "channel-1" });
    const view = renderTab(tabPath, { workspaceId: "workspace-b" });
    await waitFor(() => expect(published("workspace-b")).toMatchObject({ kind: "group", name: "general" }));
    expect(probe("workspace-a")).toBe("loading");

    view.unmount();
    render(<AboutProbe workspaceId="workspace-b" tabPath={tabPath} />);
    await act(async () => undefined);
    expect(probe("workspace-b")).toBe("loading");
  });
});
