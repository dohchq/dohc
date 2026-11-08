// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListRelayShareLinkAgentsResult, RelayShareLinkAgent } from "../ipc/bridgeContract";
import type { ShareRemovalFailure } from "./shell/useShareRemovalNotices";
import { LINK_AGENTS_FAILED, LinkAgentsList, agentAddressFor, disconnectIdentity } from "./shareLinkAgents";

const api = vi.hoisted(() => ({
  listRelayShareLinkAgents: vi.fn<(input: unknown) => Promise<ListRelayShareLinkAgentsResult>>(),
  disconnectRelayShareLinkAgent: vi.fn<(input: unknown) => Promise<{ connectionId: string }>>(),
}));
vi.mock("./bridge", () => ({ bridge: () => api }));

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";
const AT_MS = Date.UTC(2026, 10, 9, 10, 30);
// A reported name that opens with a right-to-left override.
const REVERSED_NAME = `${String.fromCodePoint(0x202e)}Claude`;

function agent(connectionId: string, reportedName: string | null = `Agent ${connectionId}`): RelayShareLinkAgent {
  return { connectionId, reportedName, connectedAtMs: AT_MS, lastActionAtMs: AT_MS + 1_000 };
}

function controllable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// The shell's notices, as the Share dialog hands them on.
const notices = {
  removed: vi.fn(),
  failed: vi.fn<(failure: ShareRemovalFailure) => void>(),
  resolved: vi.fn<(success: { workspaceId: string; identity: string }) => void>(),
};

function renderList(revision = 1) {
  const list = (next: number) => (
    <LinkAgentsList workspaceId="ws-1" shareId="share-1" grantId="grant-1" revision={next} notices={notices} />
  );
  const view = render(list(revision));
  return { rerender: (next: number) => view.rerender(list(next)), unmount: view.unmount };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listRelayShareLinkAgents.mockResolvedValue({ agents: [], nextCursor: null });
  api.disconnectRelayShareLinkAgent.mockImplementation(async (input) => ({ connectionId: (input as { connectionId: string }).connectionId }));
});

afterEach(() => cleanup());

describe("agentAddressFor", () => {
  it("is the link's own origin at /mcp/s/<secret>", () => {
    expect(agentAddressFor(`https://share.dohc.test/s/#${SECRET}`)).toBe(`https://share.dohc.test/mcp/s/${SECRET}`);
    expect(agentAddressFor(`http://127.0.0.1:4318/s/#${SECRET}`)).toBe(`http://127.0.0.1:4318/mcp/s/${SECRET}`);
  });

  it("is nothing for a URL that is not a share link", () => {
    for (const url of [
      "not a url",
      "https://relay.test/share/link-secret",
      `https://share.dohc.test/x/#${SECRET}`,
      `https://share.dohc.test/s/?next=1#${SECRET}`,
      `https://user:pass@share.dohc.test/s/#${SECRET}`,
      `javascript:alert(1)//s/#${SECRET}`,
      "https://share.dohc.test/s/#short",
      `https://share.dohc.test/s/#${SECRET}x`,
      "https://share.dohc.test/s/",
    ]) {
      expect(agentAddressFor(url), url).toBeNull();
    }
  });
});

describe("LinkAgentsList", () => {
  it("shows nothing while the first read is pending, or when the link has no agents", async () => {
    const read = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents.mockReturnValueOnce(read.promise);
    renderList();
    expect(screen.queryByRole("region")).toBeNull();
    await act(async () => read.resolve({ agents: [], nextCursor: null }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(api.listRelayShareLinkAgents).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", shareId: "share-1", grantId: "grant-1" });
  });

  it("names each agent as it reported itself, and marks the name as reported", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue({
      agents: [agent("c1", REVERSED_NAME), { ...agent("c2", null), lastActionAtMs: null }],
      nextCursor: null,
    });
    renderList();
    const list = await screen.findByRole("region", { name: "Agents" });
    const named = within(list).getByTestId("share-link-agent-c1");
    // The reported name is isolated, so its direction cannot reorder the note.
    expect(named.querySelector("bdi")?.textContent).toBe(REVERSED_NAME);
    expect(named.textContent).toContain("Name reported by the agent");
    expect(named.textContent).toContain("Last action");
    const unnamed = within(list).getByTestId("share-link-agent-c2");
    expect(unnamed.querySelector("bdi")?.textContent).toBe("Agent");
    expect(unnamed.textContent).toContain("The agent reported no name");
    expect(unnamed.textContent).toContain("Signed in");
    // The avatar is the link agent's square, and only decoration.
    expect(named.querySelector("[data-link-agent]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("disables Disconnect while it runs, then takes the agent off and takes back any old failure", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue({ agents: [agent("c1"), agent("c2")], nextCursor: null });
    const pending = controllable<{ connectionId: string }>();
    api.disconnectRelayShareLinkAgent.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    renderList();
    const button = await screen.findByTestId("share-link-agent-disconnect-c1");
    await user.click(button);
    expect(button.textContent).toBe("Disconnecting…");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("share-link-agent-disconnect-c2").hasAttribute("disabled")).toBe(false);
    await act(async () => pending.resolve({ connectionId: "c1" }));
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    expect(screen.getByTestId("share-link-agent-c2")).toBeTruthy();
    // A failure filed from an earlier, closed Share dialog goes with it.
    expect(notices.resolved).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", identity: disconnectIdentity("grant-1", "c1") });
    expect(notices.failed).not.toHaveBeenCalled();
  });

  it("hides the list once its last agent is disconnected", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue({ agents: [agent("c1")], nextCursor: null });
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });

  it("says in the agent's row that Disconnect failed, files no notice, and its Disconnect tries again", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue({ agents: [agent("c1", "Codex"), agent("c2")], nextCursor: null });
    api.disconnectRelayShareLinkAgent.mockRejectedValueOnce(new Error("Relay unavailable"));
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    const error = await screen.findByTestId("share-link-agent-error-c1");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toMatch(/^dohc could not disconnect Codex\./u);
    expect(within(screen.getByTestId("share-link-agent-c1")).getByTestId("share-link-agent-error-c1")).toBe(error);
    expect(screen.queryByTestId("share-link-agent-error-c2")).toBeNull();
    const button = screen.getByTestId("share-link-agent-disconnect-c1");
    expect(button.textContent).toBe("Disconnect");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(notices.failed).not.toHaveBeenCalled();

    await user.click(button);
    expect(api.disconnectRelayShareLinkAgent).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    expect(notices.failed).not.toHaveBeenCalled();
    expect(notices.resolved).toHaveBeenCalledWith({ workspaceId: "ws-1", identity: disconnectIdentity("grant-1", "c1") });
  });

  it("hands a Disconnect that fails after the dialog closed to the shell, with Try again", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue({ agents: [agent("c1", "Codex")], nextCursor: null });
    const pending = controllable<{ connectionId: string }>();
    api.disconnectRelayShareLinkAgent.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const { unmount } = renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    unmount();
    const refused = new Error("Relay unavailable");
    await act(async () => pending.reject(refused));
    await waitFor(() => expect(notices.failed).toHaveBeenCalledOnce());
    const failure = notices.failed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      workspaceId: "ws-1",
      message: "dohc could not disconnect Codex.",
      cause: refused,
      identity: disconnectIdentity("grant-1", "c1"),
    });

    // Try again runs Disconnect again, with no list to update.
    act(() => failure.retry!());
    expect(api.disconnectRelayShareLinkAgent).toHaveBeenLastCalledWith({ workspaceId: "ws-1", shareId: "share-1", grantId: "grant-1", connectionId: "c1" });
    await waitFor(() => expect(notices.resolved).toHaveBeenCalledWith({ workspaceId: "ws-1", identity: disconnectIdentity("grant-1", "c1") }));
  });

  it("says in place that the agents could not be read, with Try again and no notice", async () => {
    api.listRelayShareLinkAgents.mockRejectedValueOnce(new Error("Relay unavailable"));
    const user = userEvent.setup();
    renderList();
    const retry = await screen.findByTestId("share-link-agents-retry-grant-1");
    expect(retry.textContent).toContain(LINK_AGENTS_FAILED);
    // The cause stays out of the list.
    expect(retry.textContent).not.toContain("Relay unavailable");
    expect(notices.failed).not.toHaveBeenCalled();

    api.listRelayShareLinkAgents.mockResolvedValueOnce({ agents: [agent("c1")], nextCursor: null });
    await user.click(within(retry).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("share-link-agent-c1")).toBeTruthy();
    expect(screen.queryByTestId("share-link-agents-retry-grant-1")).toBeNull();
  });

  it("reads further pages on request, counts what is still unread, and retries a page in place", async () => {
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce({ agents: [agent("c1")], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("Relay unavailable"))
      .mockResolvedValueOnce({ agents: [agent("c1"), agent("c2")], nextCursor: null });
    const user = userEvent.setup();
    renderList();
    const list = await screen.findByRole("region", { name: "Agents" });
    expect(list.textContent).toContain("1+");
    await user.click(within(list).getByRole("button", { name: "Show more agents" }));
    const retry = await within(list).findByTestId("share-link-agents-retry-grant-1");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(retry).getByRole("button", { name: "Try again" }));
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith({ workspaceId: "ws-1", shareId: "share-1", grantId: "grant-1", cursor: "next" });
    await screen.findByTestId("share-link-agent-c2");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByRole("button", { name: "Show more agents" })).toBeNull();
    expect(notices.failed).not.toHaveBeenCalled();
  });

  it("drops a read the list has moved past, and a read after it is gone", async () => {
    const stale = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ agents: [agent("fresh")], nextCursor: null });
    const { rerender, unmount } = renderList(1);
    rerender(2);
    await screen.findByTestId("share-link-agent-fresh");
    await act(async () => stale.resolve({ agents: [agent("stale")], nextCursor: null }));
    expect(screen.queryByTestId("share-link-agent-stale")).toBeNull();

    const late = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents.mockReturnValueOnce(late.promise);
    rerender(3);
    unmount();
    await act(async () => late.reject(new Error("late")));
    expect(notices.failed).not.toHaveBeenCalled();
  });

  it("does not bring back an agent a read listed before its Disconnect finished", async () => {
    api.listRelayShareLinkAgents.mockResolvedValueOnce({ agents: [agent("c1"), agent("c2")], nextCursor: null });
    const user = userEvent.setup();
    const { rerender } = renderList(1);
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    api.listRelayShareLinkAgents.mockResolvedValueOnce({ agents: [agent("c1"), agent("c2")], nextCursor: null });
    rerender(2);
    await waitFor(() => expect(api.listRelayShareLinkAgents).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId("share-link-agent-c1")).toBeNull();
    expect(screen.getByTestId("share-link-agent-c2")).toBeTruthy();
  });
});
