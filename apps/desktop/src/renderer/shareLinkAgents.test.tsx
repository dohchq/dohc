// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListRelayShareLinkAgentsResult, RelayShareLinkAgent } from "../ipc/bridgeContract";
import {
  agentDisconnectIdentity,
  useDisconnectedLinkAgents,
  type DisconnectedLinkAgent,
  type ShareRemovalFailure,
  type ShareRemovalNotices,
} from "./shell/useShareRemovalNotices";
import { LINK_AGENTS_FAILED, LinkAgentsList, agentAddressFor, useLinkAgentDisconnects } from "./shareLinkAgents";

const api = vi.hoisted(() => ({
  listRelayShareLinkAgents: vi.fn<(input: unknown) => Promise<ListRelayShareLinkAgentsResult>>(),
  disconnectRelayShareLinkAgent: vi.fn<(input: unknown) => Promise<{ connectionId: string }>>(),
}));
vi.mock("./bridge", () => ({ bridge: () => api }));

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";
const AT_MS = Date.UTC(2026, 10, 9, 10, 30);
// A reported name that opens with a right-to-left override.
const REVERSED_NAME = `${String.fromCodePoint(0x202e)}Claude`;
const LINK = { workspaceId: "ws-1", shareId: "share-1", grantId: "grant-1" };

function agent(connectionId: string, reportedName: string | null = `Agent ${connectionId}`): RelayShareLinkAgent {
  return { connectionId, reportedName, connectedAtMs: AT_MS, lastActionAtMs: AT_MS + 1_000 };
}

function page(agents: RelayShareLinkAgent[], nextCursor: string | null = null): ListRelayShareLinkAgentsResult {
  return { agents, nextCursor };
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

// What the shell's notices were asked to do.
const shell = {
  failed: vi.fn<(failure: ShareRemovalFailure) => void>(),
  agentDisconnected: vi.fn<(agent: DisconnectedLinkAgent) => void>(),
};

type View = {
  // The Share dialog is open, and which time it was opened.
  open: boolean;
  dialog: number;
  // The link tab is shown, so the list is mounted.
  linkTab: boolean;
  revision: number;
};

// The Share dialog's link pane, reduced to its Disconnects and one link's list.
function Dialog(props: { notices: ShareRemovalNotices; disconnected: ReadonlySet<string>; linkTab: boolean; revision: number }) {
  const disconnects = useLinkAgentDisconnects(props.notices, props.disconnected);
  return props.linkTab ? <LinkAgentsList {...LINK} revision={props.revision} disconnects={disconnects} /> : null;
}

// The shell, which outlives each Share dialog.
function Shell(props: View) {
  const [disconnected, agentDisconnected] = useDisconnectedLinkAgents();
  const notices = useMemo<ShareRemovalNotices>(() => ({
    removed: () => {},
    failed: (failure) => shell.failed(failure),
    agentDisconnected: (gone) => {
      shell.agentDisconnected(gone);
      agentDisconnected(gone);
    },
  }), [agentDisconnected]);
  return props.open ? (
    <Dialog key={props.dialog} notices={notices} disconnected={disconnected} linkTab={props.linkTab} revision={props.revision} />
  ) : null;
}

function renderList(revision = 1) {
  let view: View = { open: true, dialog: 1, linkTab: true, revision };
  const rendered = render(<Shell {...view} />);
  const set = (change: Partial<View>) => {
    view = { ...view, ...change };
    rendered.rerender(<Shell {...view} />);
  };
  return { set, rerender: (next: number) => set({ revision: next }), unmount: rendered.unmount };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listRelayShareLinkAgents.mockResolvedValue(page([]));
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
    await act(async () => read.resolve(page([])));
    expect(screen.queryByRole("region")).toBeNull();
    expect(api.listRelayShareLinkAgents).toHaveBeenCalledExactlyOnceWith(LINK);
  });

  it("names each agent as it reported itself, and marks the name as reported", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1", REVERSED_NAME), { ...agent("c2", null), lastActionAtMs: null }]));
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

  it("disables Disconnect while it runs, then takes the agent off and tells the shell", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1"), agent("c2")]));
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
    // The shell takes back any failure an earlier, closed Share dialog filed.
    expect(shell.agentDisconnected).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", grantId: "grant-1", connectionId: "c1" });
    expect(shell.failed).not.toHaveBeenCalled();
  });

  it("hides the list once its last agent is disconnected and no page is left", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1")]));
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });

  it("keeps Show more when every shown agent is disconnected and pages are left", async () => {
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce(page([agent("c1")], "next"))
      .mockResolvedValueOnce(page([agent("c2")]));
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    const list = screen.getByRole("region", { name: "Agents" });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
    await user.click(within(list).getByRole("button", { name: "Show more agents" }));
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith({ ...LINK, cursor: "next" });
    expect(await within(list).findByTestId("share-link-agent-c2")).toBeTruthy();
  });

  it("shows Show more for an empty page that still has a cursor", async () => {
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce(page([], "next"))
      .mockResolvedValueOnce(page([agent("c1")]));
    const user = userEvent.setup();
    renderList();
    const list = await screen.findByRole("region", { name: "Agents" });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
    // No count yet: none is known.
    expect(list.textContent).not.toMatch(/\d/u);
    await user.click(within(list).getByRole("button", { name: "Show more agents" }));
    expect(await within(list).findByTestId("share-link-agent-c1")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Show more agents" })).toBeNull();
  });

  it("says in the agent's row that Disconnect failed, files no notice, and its Disconnect tries again", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1", "Codex"), agent("c2")]));
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
    expect(shell.failed).not.toHaveBeenCalled();

    await user.click(button);
    expect(api.disconnectRelayShareLinkAgent).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    expect(shell.failed).not.toHaveBeenCalled();
    expect(shell.agentDisconnected).toHaveBeenCalledWith({ workspaceId: "ws-1", grantId: "grant-1", connectionId: "c1" });
  });

  it("keeps a Disconnect across leaving the link tab, and shows its failure in place with no notice", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1", "Codex")]));
    const pending = controllable<{ connectionId: string }>();
    api.disconnectRelayShareLinkAgent.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const { set } = renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));

    // Invite by email takes the list away; the dialog stays open.
    set({ linkTab: false });
    expect(screen.queryByRole("region")).toBeNull();
    set({ linkTab: true });
    const button = await screen.findByTestId("share-link-agent-disconnect-c1");
    expect(button.textContent).toBe("Disconnecting…");

    set({ linkTab: false });
    await act(async () => pending.reject(new Error("Relay unavailable")));
    expect(shell.failed).not.toHaveBeenCalled();
    set({ linkTab: true });
    const error = await screen.findByTestId("share-link-agent-error-c1");
    expect(error.textContent).toMatch(/^dohc could not disconnect Codex\./u);
    expect(screen.getByTestId("share-link-agent-disconnect-c1").textContent).toBe("Disconnect");
    expect(shell.failed).not.toHaveBeenCalled();
  });

  it("hands a Disconnect that fails after the dialog closed to the shell, whose Try again drops the agent from a reopened dialog", async () => {
    api.listRelayShareLinkAgents.mockResolvedValue(page([agent("c1", "Codex"), agent("c2")]));
    const pending = controllable<{ connectionId: string }>();
    api.disconnectRelayShareLinkAgent.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const { set } = renderList();
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    set({ open: false });
    const refused = new Error("Relay unavailable");
    await act(async () => pending.reject(refused));
    await waitFor(() => expect(shell.failed).toHaveBeenCalledOnce());
    const failure = shell.failed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      workspaceId: "ws-1",
      message: "dohc could not disconnect Codex.",
      cause: refused,
      identity: agentDisconnectIdentity("grant-1", "c1"),
    });

    // Opened again, the dialog reads the agent the relay still lists.
    set({ open: true, dialog: 2 });
    expect(await screen.findByTestId("share-link-agent-c1")).toBeTruthy();
    expect(screen.queryByTestId("share-link-agent-error-c1")).toBeNull();

    // Try again in Notices succeeds, and the open list drops the agent.
    await act(async () => failure.retry!());
    expect(api.disconnectRelayShareLinkAgent).toHaveBeenLastCalledWith({ ...LINK, connectionId: "c1" });
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    expect(screen.getByTestId("share-link-agent-c2")).toBeTruthy();
    expect(shell.agentDisconnected).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", grantId: "grant-1", connectionId: "c1" });
    expect(shell.failed).toHaveBeenCalledOnce();
  });

  it("says in place that the agents could not be read, with Try again and no notice", async () => {
    api.listRelayShareLinkAgents.mockRejectedValueOnce(new Error("Relay unavailable"));
    const user = userEvent.setup();
    renderList();
    const retry = await screen.findByTestId("share-link-agents-retry-grant-1");
    expect(retry.textContent).toContain(LINK_AGENTS_FAILED);
    // The cause stays out of the list.
    expect(retry.textContent).not.toContain("Relay unavailable");
    expect(shell.failed).not.toHaveBeenCalled();

    api.listRelayShareLinkAgents.mockResolvedValueOnce(page([agent("c1")]));
    await user.click(within(retry).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("share-link-agent-c1")).toBeTruthy();
    expect(screen.queryByTestId("share-link-agents-retry-grant-1")).toBeNull();
  });

  it("reads further pages on request, counts what is still unread, and retries a page in place", async () => {
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce(page([agent("c1")], "next"))
      .mockRejectedValueOnce(new Error("Relay unavailable"))
      .mockResolvedValueOnce(page([agent("c1"), agent("c2")]));
    const user = userEvent.setup();
    renderList();
    const list = await screen.findByRole("region", { name: "Agents" });
    expect(list.textContent).toContain("1+");
    await user.click(within(list).getByRole("button", { name: "Show more agents" }));
    const retry = await within(list).findByTestId("share-link-agents-retry-grant-1");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(retry).getByRole("button", { name: "Try again" }));
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith({ ...LINK, cursor: "next" });
    await screen.findByTestId("share-link-agent-c2");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByRole("button", { name: "Show more agents" })).toBeNull();
    expect(shell.failed).not.toHaveBeenCalled();
  });

  it("holds Show more and Try again while the list is read again", async () => {
    const refresh = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce(page([agent("c1")], "next"))
      .mockReturnValueOnce(refresh.promise);
    const { rerender } = renderList(1);
    const more = await screen.findByRole("button", { name: "Show more agents" });
    rerender(2);
    await waitFor(() => expect(more.hasAttribute("disabled")).toBe(true));
    await act(async () => refresh.resolve(page([agent("c1")], "next")));
    expect(screen.getByRole("button", { name: "Show more agents" }).hasAttribute("disabled")).toBe(false);

    // A page that failed waits the same way.
    const again = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents
      .mockRejectedValueOnce(new Error("Relay unavailable"))
      .mockReturnValueOnce(again.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show more agents" }));
    const retry = await screen.findByTestId("share-link-agents-retry-grant-1");
    rerender(3);
    await waitFor(() => expect(within(retry).getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(true));
    await act(async () => again.resolve(page([agent("c1")])));
    expect(screen.queryByTestId("share-link-agents-retry-grant-1")).toBeNull();
  });

  it.each(["the page", "the read again"])("keeps only the read again when %s answers first", async (first) => {
    const more = controllable<ListRelayShareLinkAgentsResult>();
    const refresh = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents
      .mockResolvedValueOnce(page([agent("c1")], "p2"))
      .mockReturnValueOnce(more.promise)
      .mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    const { rerender } = renderList(1);
    await user.click(await screen.findByRole("button", { name: "Show more agents" }));
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith({ ...LINK, cursor: "p2" });
    rerender(2);
    await waitFor(() => expect(api.listRelayShareLinkAgents).toHaveBeenCalledTimes(3));
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith(LINK);

    const answers = [
      () => more.resolve(page([agent("old-page")], "old-next")),
      () => refresh.resolve(page([agent("c1"), agent("c3")], "r2")),
    ];
    for (const answer of first === "the page" ? answers : [...answers].reverse()) await act(async () => answer());

    const list = screen.getByRole("region", { name: "Agents" });
    expect(within(list).getAllByRole("listitem").map((item) => item.dataset.testid)).toEqual([
      "share-link-agent-c1",
      "share-link-agent-c3",
    ]);
    // Show more continues from the read again's cursor, so no agent is skipped.
    const button = within(list).getByRole("button", { name: "Show more agents" });
    expect(button.hasAttribute("disabled")).toBe(false);
    api.listRelayShareLinkAgents.mockResolvedValueOnce(page([agent("c4")]));
    await user.click(button);
    expect(api.listRelayShareLinkAgents).toHaveBeenLastCalledWith({ ...LINK, cursor: "r2" });
    expect(await within(list).findByTestId("share-link-agent-c4")).toBeTruthy();
  });

  it("drops a read the list has moved past, and a read after it is gone", async () => {
    const stale = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page([agent("fresh")]));
    const { rerender, unmount } = renderList(1);
    rerender(2);
    await screen.findByTestId("share-link-agent-fresh");
    await act(async () => stale.resolve(page([agent("stale")])));
    expect(screen.queryByTestId("share-link-agent-stale")).toBeNull();

    const late = controllable<ListRelayShareLinkAgentsResult>();
    api.listRelayShareLinkAgents.mockReturnValueOnce(late.promise);
    rerender(3);
    unmount();
    await act(async () => late.reject(new Error("late")));
    expect(shell.failed).not.toHaveBeenCalled();
  });

  it("does not bring back an agent a read listed before its Disconnect finished", async () => {
    api.listRelayShareLinkAgents.mockResolvedValueOnce(page([agent("c1"), agent("c2")]));
    const user = userEvent.setup();
    const { rerender } = renderList(1);
    await user.click(await screen.findByTestId("share-link-agent-disconnect-c1"));
    await waitFor(() => expect(screen.queryByTestId("share-link-agent-c1")).toBeNull());
    api.listRelayShareLinkAgents.mockResolvedValueOnce(page([agent("c1"), agent("c2")]));
    rerender(2);
    await waitFor(() => expect(api.listRelayShareLinkAgents).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId("share-link-agent-c1")).toBeNull();
    expect(screen.getByTestId("share-link-agent-c2")).toBeTruthy();
  });
});
