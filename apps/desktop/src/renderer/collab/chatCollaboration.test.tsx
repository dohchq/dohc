// @vitest-environment jsdom
import { useMemo } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPresenceCollaboration } from "../workbench/ChatsView";
import { buildChatCollaboration } from "./chatCollaboration";
import { PresenceFaces } from "./PresenceIndicators";
import { usePresence } from "./usePresence";

// MU-C5 — the collaboration construction + the workspace-switch no-repaint
// invariant, exercised through the REAL IPC presence transport (mocked bridge).

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

describe("buildChatCollaboration", () => {
  it("returns null when signed out (dormant, byte-identical solo Chats)", () => {
    expect(
      buildChatCollaboration({ connected: false, workspaceId: "ws-a", clientId: "me" }),
    ).toBeNull();
  });

  it("returns null when connected but the relay URL is missing", () => {
    expect(
      buildChatCollaboration({ connected: true, workspaceId: "ws-a", clientId: "me" }),
    ).toBeNull();
  });

  it("builds a per-scope transport factory when signed in with a relay", () => {
    const collaboration = buildChatCollaboration({
      connected: true,
      relayUrl: "https://relay.example",
      email: "  ada@x.com  ",
      workspaceId: "ws-a",
      clientId: "device-1",
    });
    expect(collaboration).not.toBeNull();
    expect(collaboration?.clientId).toBe("device-1");
    // Display name comes from the email, trimmed.
    expect(collaboration?.displayName).toBe("ada@x.com");
    // The factory yields a real transport for either scope kind.
    const wsTransport = collaboration?.transportForScope({ kind: "workspace", workspaceId: "ws-a" });
    expect(typeof wsTransport?.publish).toBe("function");
    expect(typeof wsTransport?.poll).toBe("function");
    expect(typeof wsTransport?.leave).toBe("function");
    const shareTransport = collaboration?.transportForScope({ kind: "share", shareId: "share-1" });
    expect(typeof shareTransport?.publish).toBe("function");
  });

  it("falls back to 'You' when no email is present", () => {
    const collaboration = buildChatCollaboration({
      connected: true,
      relayUrl: "https://relay.example",
      workspaceId: "ws-a",
      clientId: "device-1",
    });
    expect(collaboration?.displayName).toBe("You");
  });
});

// ---------------------------------------------------------------------------
// Workspace-switch no-repaint invariant (AGENTS.md, non-negotiable): a slow
// presence response for workspace A must NEVER repaint workspace B after a
// switch. Driven end-to-end through the IPC transport: rebuilding the
// collaboration per workspace tears the old transport down (abort → cancel),
// and a late-resolving poll for A is dropped.
// ---------------------------------------------------------------------------

const bridgeMock = {
  presencePublish: vi.fn(),
  presencePoll: vi.fn(),
  presenceCancel: vi.fn(),
};

interface PollControl {
  scope: { kind: string; workspaceId?: string };
  resolve: (result: unknown) => void;
}
const pollControls = new Map<string, PollControl>();
const cancelledPollIds: string[] = [];

beforeEach(() => {
  pollControls.clear();
  cancelledPollIds.length = 0;
  bridgeMock.presencePublish
    .mockReset()
    .mockResolvedValue({ ok: true, snapshot: { version: 0, peers: [] } });
  bridgeMock.presencePoll.mockReset().mockImplementation(
    (payload: { scope: PollControl["scope"]; pollId: string }) =>
      new Promise((resolve) => {
        pollControls.set(payload.pollId, { scope: payload.scope, resolve });
      }),
  );
  bridgeMock.presenceCancel.mockReset().mockImplementation(async ({ pollId }: { pollId: string }) => {
    cancelledPollIds.push(pollId);
    return undefined;
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness(props: {
  collaboration: ChatPresenceCollaboration | null;
  topic: string;
  workspaceId: string;
}) {
  // Mirror ChatsView: the workspace scope is resolved through the factory at
  // call time and memoized per (collaboration, workspaceId), so a switch tears
  // the old transport down.
  const transport = useMemo(
    () =>
      props.collaboration?.transportForScope({
        kind: "workspace",
        workspaceId: props.workspaceId,
      }) ?? null,
    [props.collaboration, props.workspaceId],
  );
  const { others } = usePresence({
    enabled: props.collaboration !== null,
    transport,
    topic: props.topic,
    clientId: props.collaboration?.clientId ?? "",
    displayName: props.collaboration?.displayName ?? "",
  });
  return (
    <div>
      <PresenceFaces others={others} />
      <span data-testid="count">{others.length}</span>
    </div>
  );
}

function pollIdForWorkspace(workspaceId: string): string {
  for (const [pollId, control] of pollControls) {
    if (control.scope.workspaceId === workspaceId) return pollId;
  }
  throw new Error(`no poll registered for ${workspaceId}`);
}

describe("workspace-switch no-repaint (through the IPC transport)", () => {
  it("aborts the old workspace's poll and drops its late response after a switch", async () => {
    const collabA = buildChatCollaboration({
      connected: true,
      relayUrl: "https://relay.example",
      email: "a@x.com",
      workspaceId: "ws-a",
      clientId: "me",
    });
    const view = render(
      <Harness collaboration={collabA} topic="chat:channel:1" workspaceId="ws-a" />,
    );
    await flush();
    // A registered exactly one poll, scoped to ws-a.
    const pollIdA = pollIdForWorkspace("ws-a");

    // Switch to workspace B: the collaboration is rebuilt per workspace, so the
    // transport changes and usePresence tears the A channel down.
    const collabB = buildChatCollaboration({
      connected: true,
      relayUrl: "https://relay.example",
      email: "a@x.com",
      workspaceId: "ws-b",
      clientId: "me",
    });
    view.rerender(
      <Harness collaboration={collabB} topic="chat:channel:1" workspaceId="ws-b" />,
    );
    await flush();

    // The switch aborted A's in-flight poll over IPC (abort → presenceCancel).
    expect(cancelledPollIds).toContain(pollIdA);
    const pollIdB = pollIdForWorkspace("ws-b");
    expect(pollIdB).not.toBe(pollIdA);

    // A SLOW response for the old workspace A now arrives with a ghost peer…
    act(() => {
      pollControls.get(pollIdA)?.resolve({
        ok: true,
        snapshot: {
          version: 1,
          peers: [{ userId: "ghost", clientId: "cg", state: { displayName: "Ghost" }, updatedAtMs: 0 }],
        },
      });
    });
    await flush();
    // …and it must NEVER repaint B: no ghost, still zero others.
    expect(screen.queryByLabelText("Ghost is here")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("0");

    // B's own presence still works: a real B peer renders.
    act(() => {
      pollControls.get(pollIdB)?.resolve({
        ok: true,
        snapshot: {
          version: 1,
          peers: [
            { userId: "me", clientId: "me", state: { displayName: "a@x.com" }, updatedAtMs: 0 },
            { userId: "bob", clientId: "cb", state: { displayName: "Bob" }, updatedAtMs: 0 },
          ],
        },
      });
    });
    await flush();
    expect(screen.getByLabelText("Bob is here")).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("1"); // self filtered out
  });
});
