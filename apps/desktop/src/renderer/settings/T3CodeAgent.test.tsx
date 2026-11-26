// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import type {
  AgentsListeningEvent,
  PersonalAgentsEvent,
  T3CodeAccess,
  T3CodeConnectionState,
  T3CodeProjectList,
  T3CodeThreadPage,
} from "../../ipc/bridgeContract";
import {
  DEFAULT_USER_SETTINGS,
  type AgentSettings,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { AgentList } from "./AgentList";

const SIGNED_IN: T3CodeConnectionState = {
  canKeep: true,
  signedInUntilMs: Date.UTC(2099, 11, 13, 12),
  access: null,
  canAllowHere: false,
};
const SIGNED_OUT: T3CodeConnectionState = {
  canKeep: true,
  signedInUntilMs: null,
  access: null,
  canAllowHere: false,
};
const thread = (id: string, title: string, status: string | null = null) => ({
  id,
  title,
  status,
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const onePage = (...threads: T3CodeThreadPage["threads"]): T3CodeThreadPage => ({
  threads,
  nextCursor: null,
});

type ThreadsPayload = { projectId: string; titleContains?: string; cursor?: number };
const bridgeMock = {
  getUserSettings: vi.fn(async (): Promise<DesktopUserSettingsResult> => ({
    settings: SETTINGS,
    source: "stored",
  })),
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    trusted: true,
  })),
  readChatDispatchPaused: vi.fn(async () => ({ paused: false })),
  onChatDispatchPaused: vi.fn(() => () => {}),
  listChatChannels: vi.fn(async () => ({ channels: [], fileThreads: [] })),
  readAgentsListening: vi.fn(async (): Promise<AgentsListeningEvent> => ({ agentIds: [] })),
  onAgentsListening: vi.fn(() => () => {}),
  readPersonalAgents: vi.fn(async (): Promise<PersonalAgentsEvent> => ({ accounts: [] })),
  onPersonalAgents: vi.fn(() => () => {}),
  detectAgentTools: vi.fn(async (): Promise<AgentToolsResult> => ({
    workingDirectory: "C:\\Work",
    tools: [],
  })),
  readT3CodeConnection: vi.fn(async (): Promise<T3CodeConnectionState> => SIGNED_IN),
  allowDohcInT3Code: vi.fn(
    async (_payload: { access: T3CodeAccess | null }): Promise<T3CodeConnectionState> => SIGNED_IN,
  ),
  cancelAllowDohcInT3Code: vi.fn(async () => undefined),
  listT3CodeProjects: vi.fn(async (): Promise<T3CodeProjectList> => ({
    projects: [
      { id: "p-dohc", title: "dohc" },
      { id: "p-garage", title: "garage" },
    ],
  })),
  listT3CodeThreads: vi.fn(async (_payload: ThreadsPayload): Promise<T3CodeThreadPage> =>
    onePage(thread("t-chief", "Chief of Staff: dohc", "Working"), thread("t-issue", "Issue owner")),
  ),
  startT3CodeThread: vi.fn(
    async (_payload: {
      projectId: string;
      title: string;
      requestId: string;
    }): Promise<{ threadId: string }> => ({ threadId: "t-new" }),
  ),
  readyAgentThread: vi.fn(
    async (_payload: {
      workspaceId: string;
      agentId: string;
      name: string;
      threadId: string;
    }): Promise<void> => undefined,
  ),
  readAgentThread: vi.fn(
    async (_payload: {
      workspaceId: string;
      agentId: string;
    }): Promise<
      { threadId: string; title: string; closed: boolean } | { threadId: string; problem: string }
    > => ({
      threadId: "t-chief",
      title: "Chief of Staff: dohc",
      closed: false,
    }),
  ),
  openAgentThread: vi.fn(
    async (_payload: { workspaceId: string; agentId: string }): Promise<void> => undefined,
  ),
  changeAgentThread: vi.fn(
    async (_payload: { workspaceId: string; agentId: string; threadId: string }): Promise<void> =>
      undefined,
  ),
  setAgentThreadWorkspace: vi.fn(
    async (_payload: { workspaceId: string; agentId: string; on: boolean }): Promise<void> =>
      undefined,
  ),
};
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  agents: { default: testAgent({ name: "Claude Code" }) },
};
const { launch: _launch, ...withoutLaunch } = testAgent({ name: "Chief of Staff", hue: "plum" });
const CHIEF: AgentSettings = {
  ...withoutLaunch,
  thread: { tool: "t3-code", id: "t-chief" },
  workspaces: ["ws-1"],
};
const WITH_CHIEF: DesktopUserSettings = {
  ...SETTINGS,
  agents: { ...SETTINGS.agents, "t3-code": CHIEF },
};

beforeEach(() => {
  vi.clearAllMocks();
  // A test that fails before it uses up an answer it queued must not hand it to the next test.
  bridgeMock.readT3CodeConnection.mockReset();
  bridgeMock.allowDohcInT3Code.mockReset();
  bridgeMock.changeAgentThread.mockReset();
  bridgeMock.setAgentThreadWorkspace.mockReset();
  bridgeMock.startT3CodeThread.mockReset();
  bridgeMock.startT3CodeThread.mockResolvedValue({ threadId: "t-new" });
});
afterEach(cleanup);

// The switch for the workspace the window shows, on the page of an agent with a thread.
const workspaceSwitch = (page: ReturnType<typeof within>) =>
  page.getByRole("switch", { name: "Forward messages from this workspace to Chief of Staff" });

function renderList(settings: DesktopUserSettings = SETTINGS) {
  const onSave = vi.fn(
    async (next: DesktopUserSettings): Promise<DesktopUserSettingsResult | null> => ({
      settings: next,
      source: "stored",
    }),
  );
  const onError = vi.fn();
  const list = (current: DesktopUserSettings, workspaceId = "ws-1") => (
    <WorkspaceSessionProvider workspaceId={workspaceId}>
      <AgentList
        workspaceId={workspaceId}
        workspaceName="Trip"
        settings={current}
        config={null}
        sessionRecorderOn
        onSave={onSave}
        onOrder={async () => true}
        onError={onError}
        onOpenSettingsFile={() => undefined}
      />
    </WorkspaceSessionProvider>
  );
  const { rerender } = render(list(settings));
  return {
    onSave,
    onError,
    rerender: (next: DesktopUserSettings, workspaceId?: string) =>
      rerender(list(next, workspaceId)),
  };
}

const sheet = () => within(screen.getByTestId("agent-add-sheet"));
const nameField = () => sheet().getByRole<HTMLInputElement>("textbox", { name: "Name" });
// The name the second page says the agent is added under.
const addedName = () => sheet().getByTestId("agent-add-summary-name").textContent;
const threadRow = (title: string) => sheet().getByRole("radio", { name: new RegExp(`^${title}`) });
async function chooseT3Code(name?: string) {
  await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
  if (name !== undefined) {
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), name);
  }
  await userEvent.click(screen.getByTestId("agent-runs-with-t3-code"));
  await userEvent.click(sheet().getByRole("button", { name: "Next" }));
}
const searchFor = (text: string) =>
  userEvent.type(sheet().getByRole("searchbox", { name: "Find a thread by title" }), text);

it("offers no Add when this computer cannot encrypt dohc's sign-in to T3 Code", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce({
    canKeep: false,
    signedInUntilMs: null,
    access: null,
    canAllowHere: false,
  });
  renderList();
  await chooseT3Code();
  expect((await sheet().findByTestId("t3-code-cannot-keep")).textContent).toBe(
    "This computer cannot encrypt the sign-in, so dohc cannot connect to T3 Code.",
  );
  expect(screen.queryByTestId("agent-add-confirm")).toBeNull();
  expect(screen.queryByTestId("t3-code-allow-start")).toBeNull();
  expect(bridgeMock.listT3CodeProjects).not.toHaveBeenCalled();
});

it("asks T3 Code to allow dohc, and Cancel or closing the sheet ends the wait", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValue(SIGNED_OUT);
  const first = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(first.promise);
  renderList();
  await chooseT3Code();
  const allow = within(await sheet().findByTestId("t3-code-allow"));
  expect(allow.getByText(/Sharing & access, then Authorized clients/)).toBeTruthy();
  expect(allow.getByText(/Copy code only/)).toBeTruthy();
  expect(allow.getByText(/A thread with Full access needs Full access\./)).toBeTruthy();
  // T3 Code's page takes the mode, so dohc offers no choice of one.
  expect(allow.queryByRole("radio")).toBeNull();
  expect(screen.queryByTestId("agent-add-confirm")).toBeNull();

  await userEvent.click(allow.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenLastCalledWith({ access: null });
  expect(allow.getByRole("status").textContent).toBe("Waiting for T3 Code…");
  await userEvent.click(allow.getByRole("button", { name: "Cancel waiting for T3 Code" }));
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledOnce();
  await act(async () => first.reject(new Error("The wait was cancelled.")));
  expect(allow.queryByRole("alert")).toBeNull();

  bridgeMock.allowDohcInT3Code.mockRejectedValueOnce(new Error("You declined dohc in T3 Code."));
  await userEvent.click(allow.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect((await allow.findByRole("alert")).textContent).toBe("You declined dohc in T3 Code.");

  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(deferred<T3CodeConnectionState>().promise);
  await userEvent.click(allow.getByRole("button", { name: "Allow dohc in T3 Code" }));
  await userEvent.click(sheet().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("agent-add-sheet")).toBeNull();
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledTimes(2);
  bridgeMock.readT3CodeConnection.mockResolvedValue(SIGNED_IN);
});

it("shows the person's threads once T3 Code allows dohc", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(SIGNED_OUT);
  renderList();
  await chooseT3Code();
  await userEvent.click(await sheet().findByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(await sheet().findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(screen.getByTestId("agent-add-confirm")).toBeTruthy();
});

it("connects the picked thread, named after it unless the person typed a name", async () => {
  const { onSave } = renderList();
  await chooseT3Code();
  const chief = await sheet().findByRole("radio", { name: /^Chief of Staff: dohc/ });
  expect(within(chief).getByText("Working")).toBeTruthy();
  expect(bridgeMock.listT3CodeThreads).toHaveBeenCalledWith({ projectId: "p-dohc" });
  expect(addedName()).toBe("Agent");

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(sheet().getByRole("alert").textContent).toBe("Choose a thread.");
  expect(bridgeMock.readyAgentThread).not.toHaveBeenCalled();

  await userEvent.click(chief);
  expect(sheet().queryByRole("alert")).toBeNull();
  expect(addedName()).toBe("Chief of Staff: dohc");
  await userEvent.click(threadRow("Issue owner"));
  expect(addedName()).toBe("Issue owner");
  // Back to the name keeps the thread picked.
  await userEvent.click(sheet().getByRole("button", { name: "Back" }));
  expect(nameField().value).toBe("Issue owner");
  await userEvent.clear(nameField());
  await userEvent.type(nameField(), "Chief");
  await userEvent.click(sheet().getByRole("button", { name: "Next" }));
  expect(threadRow("Issue owner").getAttribute("aria-checked")).toBe("true");
  await userEvent.click(chief);
  expect(addedName()).toBe("Chief");

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  // The thread is readied under the id the agent gets, before it is saved.
  expect(bridgeMock.readyAgentThread).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    name: "Chief",
    threadId: "t-chief",
  });
  const added = onSave.mock.calls[0]![0].agents["t3-code"]!;
  expect(added).toMatchObject({
    name: "Chief",
    enabled: true,
    thread: { tool: "t3-code", id: "t-chief" },
    workspaces: ["ws-1"],
  });
  expect(added.launch).toBeUndefined();
  await waitFor(() => expect(screen.queryByTestId("agent-add-sheet")).toBeNull());
});

it("forgets the picked thread when the person leaves T3 Code and comes back", async () => {
  renderList();
  await chooseT3Code();
  await userEvent.click(await sheet().findByRole("radio", { name: /^Issue owner/ }));
  expect(addedName()).toBe("Issue owner");

  // The list is gone, so no thread it showed can still be the choice.
  await userEvent.click(sheet().getByRole("button", { name: "Back" }));
  await userEvent.click(screen.getByTestId("agent-runs-with-mcp"));
  await userEvent.click(screen.getByTestId("agent-runs-with-t3-code"));
  await userEvent.click(sheet().getByRole("button", { name: "Next" }));
  const row = await sheet().findByRole("radio", { name: /^Issue owner/ });
  expect(row.getAttribute("aria-checked")).toBe("false");
  expect(addedName()).toBe("Agent");

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(sheet().getByRole("alert").textContent).toBe("Choose a thread.");
  expect(bridgeMock.readyAgentThread).not.toHaveBeenCalled();
});

it("saves nothing when the thread can't be readied, and says why in the sheet", async () => {
  const refusal =
    "T3 Code refused dohc because this thread runs with a broader mode than dohc was allowed.";
  const readying = deferred();
  bridgeMock.readyAgentThread.mockReturnValueOnce(readying.promise);
  const { onSave } = renderList();
  await chooseT3Code();
  await userEvent.click(await sheet().findByRole("radio", { name: /^Issue owner/ }));
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  const confirm = screen.getByTestId<HTMLButtonElement>("agent-add-confirm");
  expect(confirm.textContent).toBe("Adding…");
  expect(confirm.disabled).toBe(true);
  await act(async () => readying.reject(new Error(refusal)));
  expect(sheet().getByRole("alert").textContent).toBe(refusal);
  expect(onSave).not.toHaveBeenCalled();
  expect(confirm.textContent).toBe("Add agent");
  expect(confirm.disabled).toBe(false);
});

it("starts a new thread named after the agent, once however often Add is pressed, and connects it", async () => {
  const starting = deferred<{ threadId: string }>();
  bridgeMock.startT3CodeThread
    .mockRejectedValueOnce(new Error("T3 Code is not running on this computer."))
    .mockReturnValueOnce(starting.promise);
  const { onSave } = renderList();
  await chooseT3Code("Planner");
  const fresh = await sheet().findByRole("radio", { name: /^New thread/ });
  // The new thread takes the agent's name.
  expect(within(fresh).getByText("Planner")).toBeTruthy();
  await sheet().findByRole("radio", { name: /^Issue owner/ });
  await userEvent.click(fresh);
  expect(fresh.getAttribute("aria-checked")).toBe("true");
  expect(addedName()).toBe("Planner");

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect((await sheet().findByRole("alert")).textContent).toBe(
    "T3 Code is not running on this computer.",
  );
  expect(bridgeMock.readyAgentThread).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(screen.getByTestId("agent-add-confirm").textContent).toBe("Adding…");
  await act(async () => starting.resolve({ threadId: "t-new" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  // Both tries name one start, so T3 Code starts one thread for them.
  const [first, second] = bridgeMock.startT3CodeThread.mock.calls.map(([payload]) => payload);
  expect(first).toEqual({ projectId: "p-dohc", title: "Planner", requestId: second!.requestId });
  expect(bridgeMock.readyAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    name: "Planner",
    threadId: "t-new",
  });
  expect(onSave.mock.calls[0]![0].agents["t3-code"]).toMatchObject({
    name: "Planner",
    thread: { tool: "t3-code", id: "t-new" },
    workspaces: ["ws-1"],
  });
});

it("keeps an older search's late answer out of the list", async () => {
  const older = deferred<T3CodeThreadPage>();
  const newer = deferred<T3CodeThreadPage>();
  renderList();
  await chooseT3Code();
  await sheet().findByRole("radio", { name: /^Issue owner/ });
  bridgeMock.listT3CodeThreads.mockReturnValueOnce(older.promise);
  await searchFor("o");
  await waitFor(() =>
    expect(bridgeMock.listT3CodeThreads).toHaveBeenLastCalledWith({
      projectId: "p-dohc",
      titleContains: "o",
    }),
  );
  bridgeMock.listT3CodeThreads.mockReturnValueOnce(newer.promise);
  await searchFor("w");
  await waitFor(() =>
    expect(bridgeMock.listT3CodeThreads).toHaveBeenLastCalledWith({
      projectId: "p-dohc",
      titleContains: "ow",
    }),
  );
  await act(async () => newer.resolve(onePage(thread("t-owner", "Release owner"))));
  expect(threadRow("Release owner")).toBeTruthy();
  await act(async () => older.resolve(onePage(thread("t-old", "Host checks"))));
  expect(sheet().queryByRole("radio", { name: /^Host checks/ })).toBeNull();
  expect(sheet().getAllByRole("radio", { name: /owner/ })).toHaveLength(1);

  bridgeMock.listT3CodeThreads.mockResolvedValueOnce(onePage());
  await searchFor("z");
  expect((await sheet().findByTestId("t3-code-threads-empty")).textContent).toBe(
    'No threads match "owz".',
  );
});

it("takes no pick from a list the search is about to replace", async () => {
  renderList();
  await chooseT3Code();
  await sheet().findByRole("radio", { name: /^Issue owner/ });
  const list = screen.getByTestId("t3-code-threads");
  expect(list.hasAttribute("inert")).toBe(false);

  // The person types. Until the search goes, the list they see is the old one.
  const answer = deferred<T3CodeThreadPage>();
  bridgeMock.listT3CodeThreads.mockReturnValueOnce(answer.promise);
  fireEvent.change(sheet().getByRole("searchbox", { name: "Find a thread by title" }), {
    target: { value: "owner" },
  });
  expect(list.hasAttribute("inert")).toBe(true);

  // The search went, and its list can be picked from, while it loads and after.
  await waitFor(() =>
    expect(bridgeMock.listT3CodeThreads).toHaveBeenLastCalledWith({
      projectId: "p-dohc",
      titleContains: "owner",
    }),
  );
  expect(list.hasAttribute("inert")).toBe(false);
  await act(async () => answer.resolve(onePage(thread("t-owner", "Release owner"))));
  await userEvent.click(threadRow("Release owner"));
  expect(threadRow("Release owner").getAttribute("aria-checked")).toBe("true");
});

it("loads the next page of a project's threads, and another project's from its first", async () => {
  bridgeMock.listT3CodeThreads.mockResolvedValueOnce({
    threads: [thread("t-1", "First thread")],
    nextCursor: 50,
  });
  renderList();
  await chooseT3Code();
  await userEvent.click(await sheet().findByRole("button", { name: "Show more" }));
  expect(bridgeMock.listT3CodeThreads).toHaveBeenLastCalledWith({
    projectId: "p-dohc",
    cursor: 50,
  });
  expect(await sheet().findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(threadRow("First thread")).toBeTruthy();
  expect(sheet().queryByRole("button", { name: "Show more" })).toBeNull();

  bridgeMock.listT3CodeThreads.mockRejectedValueOnce(new Error("T3 Code is not running."));
  await userEvent.selectOptions(sheet().getByRole("combobox", { name: "Project" }), "garage");
  const retry = within(await sheet().findByTestId("t3-code-threads-retry"));
  expect(retry.getByText("T3 Code is not running.")).toBeTruthy();
  await userEvent.click(retry.getByRole("button", { name: "Try again" }));
  expect(await sheet().findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(bridgeMock.listT3CodeThreads).toHaveBeenLastCalledWith({ projectId: "p-garage" });
});

it("lists an agent with a thread by its tool, on or off, and never as Through MCP", async () => {
  const { rerender } = renderList(WITH_CHIEF);
  const state = () =>
    within(screen.getByRole("button", { name: "Chief of Staff" })).getByTestId("agent-state")
      .textContent;
  expect(state()).toBe("T3 Code·On");
  rerender({
    ...WITH_CHIEF,
    agents: { ...SETTINGS.agents, "t3-code": { ...CHIEF, enabled: false } },
  });
  expect(state()).toBe("T3 Code·Off");
  rerender({
    ...WITH_CHIEF,
    agents: { ...SETTINGS.agents, "t3-code": { ...CHIEF, workspaces: ["ws-2"] } },
  });
  expect(state()).toBe("T3 Code·Not in this workspace");
});

it("saves the forwarding switch, what a message does while the thread works, and the note", async () => {
  const { onSave, rerender } = renderList(WITH_CHIEF);
  await userEvent.click(screen.getByRole("button", { name: "Chief of Staff" }));
  const page = within(screen.getByTestId("agent-page"));
  expect(page.getByTestId("agent-page-subtitle").textContent).toBe(
    "@ChiefofStaff·Thread in T3 Code",
  );
  expect(page.queryByTestId("agent-connect")).toBeNull();
  expect(page.queryByText("Through MCP")).toBeNull();
  expect((await page.findByText(/^Allowed until /)).textContent).toMatch(/2099/);
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("true");
  expect(page.getByTestId("agent-thread-workspace").textContent).toBe(
    "Forward from this workspace",
  );
  const saved = () => onSave.mock.lastCall![0].agents["t3-code"]!;

  await userEvent.click(page.getByRole("switch", { name: "Forward messages to Chief of Staff" }));
  expect(saved().enabled).toBe(false);

  expect(page.getByRole("radio", { name: "Wait in line" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await userEvent.click(page.getByRole("radio", { name: "Go right away" }));
  expect(saved().whileBusy).toBe("steer");
  rerender({ ...WITH_CHIEF, agents: { ...SETTINGS.agents, "t3-code": saved() } });
  expect(
    page.getByText("Only your own messages go right away. Other people's wait in line."),
  ).toBeTruthy();

  const note = page.getByRole<HTMLTextAreaElement>("textbox", { name: "Your note" });
  expect(note.maxLength).toBe(4000);
  await userEvent.type(note, "Post decisions here. ");
  expect(saved().note).toBeUndefined();
  fireEvent.blur(note);
  expect(saved().note).toBe("Post decisions here.");
  rerender({ ...WITH_CHIEF, agents: { ...SETTINGS.agents, "t3-code": saved() } });
  expect(note.value).toBe("Post decisions here.");

  const saves = onSave.mock.calls.length;
  await userEvent.type(note, " More{Escape}");
  expect(note.value).toBe("Post decisions here.");
  expect(onSave).toHaveBeenCalledTimes(saves);
  await userEvent.clear(note);
  fireEvent.blur(note);
  expect(Object.hasOwn(saved(), "note")).toBe(false);
  expect(saved().whileBusy).toBe("steer");
});

it("offers Allow on the page when T3 Code no longer allows dohc, and reports a failed ask", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(SIGNED_OUT);
  bridgeMock.allowDohcInT3Code.mockRejectedValueOnce(new Error("T3 Code is not running."));
  const { onError } = renderList(WITH_CHIEF);
  await userEvent.click(screen.getByRole("button", { name: "Chief of Staff" }));
  const page = within(screen.getByTestId("agent-page"));
  expect(await page.findByText("Not allowed")).toBeTruthy();
  await userEvent.click(page.getByRole("button", { name: "Allow dohc in T3 Code" }));
  await waitFor(() =>
    expect(onError).toHaveBeenCalledWith(
      "T3 Code is not running.",
      expect.any(Error),
      expect.any(Function),
    ),
  );
  await userEvent.click(page.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(await page.findByText(/^Allowed until /)).toBeTruthy();
});

const withChief = (fields: Partial<AgentSettings>): DesktopUserSettings => ({
  ...WITH_CHIEF,
  agents: { ...SETTINGS.agents, "t3-code": { ...CHIEF, ...fields } },
});
async function openChiefPage(settings: DesktopUserSettings = WITH_CHIEF) {
  const rendered = renderList(settings);
  await userEvent.click(screen.getByRole("button", { name: "Chief of Staff" }));
  const page = within(screen.getByTestId("agent-page"));
  return { ...rendered, page, row: within(page.getByTestId("agent-page-thread")) };
}
const changeDialog = () => within(screen.getByTestId("agent-thread-change-dialog"));
const changeConfirm = () => screen.getByTestId<HTMLButtonElement>("agent-thread-change-confirm");
// The page with the dialog open and the project's threads listed.
async function openChangeDialog(settings?: DesktopUserSettings) {
  const opened = await openChiefPage(settings);
  await opened.row.findByText("Chief of Staff: dohc");
  const opener = opened.page.getByRole("button", { name: "Change thread" });
  await userEvent.click(opener);
  await changeDialog().findByRole("radio", { name: /^Issue owner/ });
  return { ...opened, opener, issue: changeDialog().getByRole("radio", { name: /^Issue owner/ }) };
}

it("names the agent's thread by its title, and says when T3 Code has closed it", async () => {
  bridgeMock.readAgentThread.mockResolvedValueOnce({
    threadId: "t-chief",
    title: "Release owner",
    closed: true,
  });
  // The thread is read for an agent that is off too.
  const { page, row } = await openChiefPage(withChief({ enabled: false }));
  expect(await row.findByText("Release owner")).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
  });
  expect(page.getByTestId("agent-page-thread-closed").textContent).toBe(
    "This thread is archived or settled in T3 Code.",
  );
});

it("says why the thread could not be read, beside the way to change it, and reads it again", async () => {
  const gone = "This thread is no longer in T3 Code.";
  bridgeMock.readAgentThread.mockRejectedValueOnce(new Error(gone));
  const { page, row, onError } = await openChiefPage();
  const retry = within(await row.findByTestId("agent-page-thread-retry"));
  expect(retry.getByText(gone)).toBeTruthy();
  expect(onError).toHaveBeenCalledWith(gone, expect.any(Error), expect.any(Function));
  expect(page.getByRole("button", { name: "Change thread" })).toBeTruthy();

  await userEvent.click(retry.getByRole("button", { name: "Try again" }));
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  expect(row.queryByTestId("agent-page-thread-retry")).toBeNull();
  // A thread that takes work says nothing more.
  expect(page.queryByTestId("agent-page-thread-closed")).toBeNull();
});

it("reads the thread again when the agent is saved with another one, and only then", async () => {
  const { row, rerender } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  rerender(withChief({ whileBusy: "steer" }));
  expect(bridgeMock.readAgentThread).toHaveBeenCalledOnce();

  const reading = deferred<{ threadId: string; title: string; closed: boolean }>();
  bridgeMock.readAgentThread.mockReturnValueOnce(reading.promise);
  rerender(withChief({ thread: { tool: "t3-code", id: "t-issue" } }));
  // The thread it left is not shown as the one it has.
  expect(row.queryByText("Chief of Staff: dohc")).toBeNull();
  expect(row.getByLabelText("Reading the thread")).toBeTruthy();
  await act(async () =>
    reading.resolve({ threadId: "t-issue", title: "Issue owner", closed: false }),
  );
  expect(row.getByText("Issue owner")).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledTimes(2);
});

it("does not name the thread the agent left when an answer for it comes after the settings changed", async () => {
  const { row, rerender } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  // The settings name the new thread. The first answer is still for the
  // thread the agent had.
  bridgeMock.readAgentThread
    .mockResolvedValueOnce({ threadId: "t-chief", title: "Chief of Staff: dohc", closed: true })
    .mockResolvedValueOnce({ threadId: "t-issue", title: "Issue owner", closed: false });
  rerender(withChief({ thread: { tool: "t3-code", id: "t-issue" } }));

  await waitFor(() => expect(bridgeMock.readAgentThread).toHaveBeenCalledTimes(2));
  // Neither the old title nor what was said of the old thread is shown for the new one.
  expect(row.queryByText("Chief of Staff: dohc")).toBeNull();
  expect(screen.queryByTestId("agent-page-thread-closed")).toBeNull();
  expect(row.getByLabelText("Reading the thread")).toBeTruthy();

  expect(await row.findByText("Issue owner", undefined, { timeout: 3_000 })).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledTimes(3);
});

it("says what T3 Code said of the agent's thread, and never of the thread it left", async () => {
  const gone = "This thread is no longer in T3 Code.";
  // The agent's thread is gone from T3 Code: the reason to change it.
  bridgeMock.readAgentThread.mockResolvedValueOnce({ threadId: "t-chief", problem: gone });
  const { row, rerender, onError } = await openChiefPage();
  expect(within(await row.findByTestId("agent-page-thread-retry")).getByText(gone)).toBeTruthy();
  expect(onError).toHaveBeenCalledWith(gone, expect.any(Error), expect.any(Function));

  // The settings name another thread. The first answer is still that the old
  // thread is gone. It is not said of the new one.
  bridgeMock.readAgentThread
    .mockResolvedValueOnce({ threadId: "t-chief", problem: gone })
    .mockResolvedValueOnce({ threadId: "t-issue", title: "Issue owner", closed: false });
  rerender(withChief({ thread: { tool: "t3-code", id: "t-issue" } }));
  await waitFor(() => expect(bridgeMock.readAgentThread).toHaveBeenCalledTimes(2));
  expect(row.queryByTestId("agent-page-thread-retry")).toBeNull();
  expect(row.getByLabelText("Reading the thread")).toBeTruthy();

  expect(await row.findByText("Issue owner", undefined, { timeout: 3_000 })).toBeTruthy();
  expect(row.queryByTestId("agent-page-thread-retry")).toBeNull();
});

it("reads the thread once T3 Code allows dohc, and says nothing of it before", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(SIGNED_OUT);
  const { page, row, onError } = await openChiefPage();
  expect(await page.findByText("Not allowed")).toBeTruthy();
  // The page already says why, so the row asks T3 Code nothing and repeats nothing.
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();
  expect(row.queryByTestId("agent-page-thread-retry")).toBeNull();
  expect(row.queryByLabelText("Reading the thread")).toBeNull();
  expect(onError).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledOnce();
});

it("opens the agent's thread in T3 Code, and reports when it could not", async () => {
  const stopped = "T3 Code is not running on this computer.";
  bridgeMock.openAgentThread.mockRejectedValueOnce(new Error(stopped));
  const { page, onError } = await openChiefPage(withChief({ enabled: false }));
  await userEvent.click(page.getByRole("button", { name: "Open in T3 Code" }));
  expect(bridgeMock.openAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
  });
  await waitFor(() =>
    expect(onError).toHaveBeenCalledWith(stopped, expect.any(Error), expect.any(Function)),
  );
  // The notice's Try again opens the thread again, and a thread that opens reports nothing.
  const reports = onError.mock.calls.length;
  await act(async () => {
    await (onError.mock.lastCall![2] as () => Promise<void>)();
  });
  expect(bridgeMock.openAgentThread).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledTimes(reports);
});

const ISSUE = withChief({ thread: { tool: "t3-code", id: "t-issue" } });
const issueThread = { threadId: "t-issue", title: "Issue owner", closed: false };

it("changes the thread in main, saves nothing itself, and names the new thread once the settings have it", async () => {
  const changing = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(changing.promise);
  const { row, onSave, rerender, opener, issue } = await openChangeDialog();
  const box = changeDialog();
  expect(screen.getByRole("dialog", { name: "Change Chief of Staff's thread" })).toBeTruthy();
  expect(
    box.getByText(
      "dohc will forward new messages to the thread you choose. The old thread keeps its existing messages.",
    ),
  ).toBeTruthy();
  // Focus starts on the first field, and nothing is picked yet.
  expect(document.activeElement).toBe(box.getByRole("combobox", { name: "Project" }));
  expect(changeConfirm().disabled).toBe(true);

  // The thread the agent already has is no change, and the dialog says so.
  await userEvent.click(box.getByRole("radio", { name: /^Chief of Staff: dohc/ }));
  expect(changeConfirm().disabled).toBe(true);
  expect(box.getByTestId("agent-thread-change-same").textContent).toBe(
    "This is already Chief of Staff's thread.",
  );
  fireEvent.submit(screen.getByTestId("agent-thread-change-dialog"));
  expect(bridgeMock.changeAgentThread).not.toHaveBeenCalled();

  await userEvent.click(issue);
  expect(box.queryByTestId("agent-thread-change-same")).toBeNull();
  // Two presses before the window draws again ask main once.
  act(() => {
    changeConfirm().click();
    changeConfirm().click();
  });
  expect(bridgeMock.changeAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    threadId: "t-issue",
  });
  // While main changes the thread the button says so, and the dialog stays.
  expect(changeConfirm().textContent).toBe("Changing…");
  expect(changeConfirm().disabled).toBe(true);
  expect(box.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByTestId("agent-thread-change-dialog")).toBeTruthy();

  // Main answers before its settings reach this window. The dialog closes,
  // and the row names the thread the settings here still have.
  await act(async () => changing.resolve());
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(row.getByText("Chief of Staff: dohc")).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledOnce();

  // Main's settings arrive, and the row names the new thread.
  bridgeMock.readAgentThread.mockResolvedValueOnce(issueThread);
  rerender(ISSUE);
  expect(await row.findByText("Issue owner")).toBeTruthy();
  // Main saved the thread. This window saved nothing.
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps the Change thread dialog as it is when main's settings arrive before its answer", async () => {
  const changing = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(changing.promise);
  const { row, onSave, rerender, issue } = await openChangeDialog();
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  bridgeMock.readAgentThread.mockResolvedValueOnce(issueThread);
  rerender(ISSUE);
  // The settings name the picked thread because of this change, so the dialog
  // does not say the thread is already the agent's.
  expect(changeConfirm().textContent).toBe("Changing…");
  expect(changeDialog().queryByTestId("agent-thread-change-same")).toBeNull();

  await act(async () => changing.resolve());
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  expect(await row.findByText("Issue owner")).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps the dialog and the pick when main could not change the thread, and asks again", async () => {
  const refusal =
    "T3 Code refused dohc because this thread runs with a broader mode than dohc was allowed.";
  bridgeMock.changeAgentThread.mockRejectedValueOnce(new Error(refusal));
  const { onSave, onError, issue } = await openChangeDialog();
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  expect((await changeDialog().findByTestId("agent-thread-change-error")).textContent).toBe(
    refusal,
  );
  // The dialog is still open, so it says why itself, and files no notice.
  expect(onError).not.toHaveBeenCalled();
  expect(issue.getAttribute("aria-checked")).toBe("true");
  expect(changeConfirm().textContent).toBe("Change thread");
  expect(changeConfirm().disabled).toBe(false);
  expect(document.activeElement).toBe(changeConfirm());

  // The same pick goes again from the same button.
  await userEvent.click(changeConfirm());
  await waitFor(() => expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull());
  expect(bridgeMock.changeAgentThread).toHaveBeenCalledTimes(2);
  expect(bridgeMock.changeAgentThread).toHaveBeenLastCalledWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    threadId: "t-issue",
  });
  expect(onSave).not.toHaveBeenCalled();
});

it("changes nothing for a thread change's answer that comes after the Thread row is gone", async () => {
  const changing = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(changing.promise);
  const { onSave, onError, rerender, issue } = await openChangeDialog();
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  // Another window turned this workspace off, and the row went with its dialog.
  rerender(ELSEWHERE);
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  const checks = bridgeMock.readT3CodeConnection.mock.calls.length;
  await act(async () => changing.resolve());
  // A dialog that closes checks T3 Code again. One that is gone checks nothing.
  expect(bridgeMock.readT3CodeConnection).toHaveBeenCalledTimes(checks);
  expect(onSave).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("asks T3 Code to allow dohc before a thread can be picked, and the page learns of it", async () => {
  bridgeMock.readT3CodeConnection
    .mockResolvedValueOnce(SIGNED_OUT)
    .mockResolvedValueOnce(SIGNED_OUT);
  const { page, row } = await openChiefPage();
  expect(await page.findByText("Not allowed")).toBeTruthy();
  await userEvent.click(page.getByRole("button", { name: "Change thread" }));
  const box = changeDialog();
  const allow = await box.findByRole("button", { name: "Allow dohc in T3 Code" });
  // Until T3 Code allows dohc there is nothing to change to, and focus is on the ask.
  expect(screen.queryByTestId("agent-thread-change-confirm")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(allow));

  await userEvent.click(allow);
  expect(await box.findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(changeConfirm().disabled).toBe(true);
  await waitFor(() =>
    expect(document.activeElement).toBe(box.getByRole("combobox", { name: "Project" })),
  );

  await userEvent.click(box.getByRole("button", { name: "Cancel" }));
  expect(await page.findByText(/^Allowed until /)).toBeTruthy();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
});

it("closes the dialog on Escape with nothing changed, and returns focus to Change thread", async () => {
  const { onSave, opener, issue } = await openChangeDialog();
  await userEvent.click(issue);
  // The arrows move the pick, and Escape leaves from anywhere in the dialog.
  await userEvent.keyboard("{ArrowUp}");
  expect(issue.getAttribute("aria-checked")).toBe("false");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(bridgeMock.changeAgentThread).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});

// Where dohc can make its own sign-in code, allowing it is one decision in dohc.
const HERE_SIGNED_OUT: T3CodeConnectionState = { ...SIGNED_OUT, canAllowHere: true };
const allowedHere = (access: T3CodeAccess | null): T3CodeConnectionState => ({
  ...SIGNED_IN,
  access,
  canAllowHere: true,
});
const checked = (radio: HTMLElement) => radio.getAttribute("aria-checked") === "true";

it("allows dohc in dohc with the mode the person picks, and the threads follow", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(HERE_SIGNED_OUT);
  const allowing = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(allowing.promise);
  renderList();
  await chooseT3Code();
  const allow = within(await sheet().findByTestId("t3-code-allow"));
  // No browser opens, so nothing here is about T3 Code's page or its sign-in code.
  expect(allow.queryByTestId("t3-code-allow-steps")).toBeNull();
  expect(allow.queryByText(/sign-in code/)).toBeNull();
  expect(allow.getByText("dohc creates its own sign-in in T3 Code.")).toBeTruthy();
  expect(
    allow.getByRole("radiogroup", {
      name: "Choose a mode at or above the thread you want to connect.",
    }),
  ).toBeTruthy();
  // T3 Code's own names and words, from the mode that asks most to the one that never asks.
  expect(allow.getAllByRole("radio").map((radio) => [radio.textContent, checked(radio)])).toEqual([
    ["SupervisedAsk before commands and file changes.", false],
    ["Auto-accept editsAuto-approve edits, ask before other actions.", false],
    ["AutoSupported providers approve routine actions; others still ask.", false],
    ["Full accessAllow commands and edits without prompts.", false],
  ]);
  expect(
    allow.getByRole("radio", {
      name: "Full access",
      description: "Allow commands and edits without prompts.",
    }),
  ).toBeTruthy();

  // Nothing is picked for the person, and nothing is asked until they pick.
  const start = allow.getByTestId<HTMLButtonElement>("t3-code-allow-start");
  expect(start.textContent).toBe("Allow dohc in T3 Code");
  await userEvent.click(start);
  expect(allow.getByRole("alert").textContent).toBe("Pick a mode.");
  expect(document.activeElement).toBe(allow.getByRole("radio", { name: "Supervised" }));
  expect(bridgeMock.allowDohcInT3Code).not.toHaveBeenCalled();

  // The arrows move the pick, as in any group of radios.
  await userEvent.keyboard("{ArrowDown}");
  expect(checked(allow.getByRole("radio", { name: "Auto-accept edits" }))).toBe(true);
  expect(document.activeElement).toBe(allow.getByRole("radio", { name: "Auto-accept edits" }));
  expect(allow.queryByRole("alert")).toBeNull();
  expect(start.textContent).toBe("Allow with Auto-accept edits");
  await userEvent.click(allow.getByRole("radio", { name: "Full access" }));
  expect(start.textContent).toBe("Allow with Full access");

  await userEvent.click(start);
  expect(start.textContent).toBe("Allowing…");
  expect(start.disabled).toBe(true);
  // The choice holds still while dohc asks with it, and a second press asks nothing more.
  expect(allow.getByTestId("t3-code-allow-modes").hasAttribute("inert")).toBe(true);
  fireEvent.click(start);
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenCalledExactlyOnceWith({ access: "full-access" });
  expect(screen.queryByTestId("agent-add-confirm")).toBeNull();

  await act(async () => allowing.resolve(allowedHere("full-access")));
  expect(await sheet().findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(screen.getByTestId("agent-add-confirm")).toBeTruthy();
  expect(sheet().queryByTestId("t3-code-allow")).toBeNull();
});

it("keeps the pick when dohc could not sign itself in, and offers T3 Code's page with its steps", async () => {
  const failed = "dohc could not make its own sign-in code in T3 Code.";
  // As the window receives it: the class and the code go before the words.
  const cannotAllowHere = () => new Error(`T3CodeError [cannot-allow-here]: ${failed}`);
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(HERE_SIGNED_OUT);
  const asking = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(asking.promise);
  renderList();
  await chooseT3Code();
  const allow = within(await sheet().findByTestId("t3-code-allow"));
  const onPage = () => allow.queryByRole("button", { name: "Allow on T3 Code's page" });
  const auto = allow.getByRole("radio", { name: "Auto" });
  expect(onPage()).toBeNull();
  await userEvent.click(auto);
  await userEvent.click(allow.getByRole("button", { name: "Allow with Auto" }));
  // Chromium takes focus from a button that turns disabled. jsdom leaves it
  // there, and only a field that can take focus can give it up.
  const hiddenName = screen.getByTestId<HTMLInputElement>("agent-add-name");
  hiddenName.focus();
  hiddenName.blur();
  expect(document.activeElement).toBe(document.body);
  await act(async () => asking.reject(cannotAllowHere()));

  expect((await allow.findByTestId("t3-code-allow-error")).textContent).toBe(failed);
  const start = allow.getByRole<HTMLButtonElement>("button", { name: "Allow with Auto" });
  expect(checked(auto)).toBe(true);
  expect(start.disabled).toBe(false);
  expect(document.activeElement).toBe(start);
  // The steps are for T3 Code's page, so they wait until the person goes there.
  expect(allow.queryByTestId("t3-code-allow-steps")).toBeNull();

  const waiting = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(waiting.promise);
  await userEvent.click(onPage()!);
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenLastCalledWith({ access: null });
  expect(within(allow.getByTestId("t3-code-allow-steps")).getByText(/Copy code only/)).toBeTruthy();
  expect(allow.getByRole("status").textContent).toBe("Waiting for T3 Code…");
  expect(allow.queryByRole("alert")).toBeNull();

  // Cancel ends the wait, and an answer that comes after it does not allow dohc.
  await userEvent.click(allow.getByRole("button", { name: "Cancel waiting for T3 Code" }));
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledOnce();
  await act(async () => waiting.resolve(allowedHere(null)));
  expect(sheet().queryByTestId("t3-code-thread-search")).toBeNull();
  expect(allow.queryByRole("status")).toBeNull();
  expect(allow.getByTestId("t3-code-allow-steps")).toBeTruthy();
  expect(checked(auto)).toBe(true);

  // The same pick goes again from the same button, and the page is still offered.
  bridgeMock.allowDohcInT3Code.mockRejectedValueOnce(cannotAllowHere());
  await userEvent.click(allow.getByRole("button", { name: "Allow with Auto" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenLastCalledWith({ access: "auto" });
  expect((await allow.findByTestId("t3-code-allow-error")).textContent).toBe(failed);

  await userEvent.click(onPage()!);
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenLastCalledWith({ access: null });
  expect(await sheet().findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  expect(screen.getByTestId("agent-add-confirm")).toBeTruthy();
});

it("ends the ask in dohc when the sheet closes, and reports nothing for its late answer", async () => {
  bridgeMock.readT3CodeConnection
    .mockResolvedValueOnce(HERE_SIGNED_OUT)
    .mockResolvedValueOnce(HERE_SIGNED_OUT);
  const allowing = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(allowing.promise);
  const { onError } = renderList();
  await chooseT3Code();
  const allow = within(await sheet().findByTestId("t3-code-allow"));
  await userEvent.click(allow.getByRole("radio", { name: "Supervised" }));
  await userEvent.click(allow.getByRole("button", { name: "Allow with Supervised" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenCalledExactlyOnceWith({
    access: "approval-required",
  });

  await userEvent.click(sheet().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("agent-add-sheet")).toBeNull();
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledOnce();
  await act(async () => allowing.reject(new Error("The sign-in to T3 Code was cancelled.")));
  expect(onError).not.toHaveBeenCalled();

  // The sheet opens again on the choice, with nothing picked and no failure.
  await chooseT3Code();
  const again = within(await sheet().findByTestId("t3-code-allow"));
  expect(again.queryByRole("alert")).toBeNull();
  expect(again.getAllByRole("radio").some(checked)).toBe(false);
  expect(again.queryByRole("button", { name: "Allow on T3 Code's page" })).toBeNull();
});

it("names the mode dohc has on the agent's page, and allows again with another one", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(allowedHere("auto"));
  const allowing = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(allowing.promise);
  const { page, onError } = await openChiefPage();
  const access = within(page.getByTestId("agent-thread-access"));
  expect((await access.findByText(/^Allowed with Auto until /)).textContent).toMatch(/2099$/);
  const again = () => within(page.getByTestId("t3-code-allow-again"));
  const opener = () => again().getByRole("button", { name: "Allow again" });

  // The choice opens in place on the mode dohc has, and Cancel leaves it as it was.
  await userEvent.click(opener());
  expect(again().getAllByRole("radio").filter(checked)).toEqual([
    again().getByRole("radio", { name: "Auto" }),
  ]);
  expect(document.activeElement).toBe(again().getByRole("radio", { name: "Auto" }));
  expect(again().getByTestId("t3-code-allow-start").textContent).toBe("Allow with Auto");
  expect(again().queryByText(/sign-in code/)).toBeNull();
  await userEvent.click(again().getByRole("button", { name: "Cancel" }));
  expect(again().queryByRole("radio")).toBeNull();
  expect(document.activeElement).toBe(opener());
  expect(bridgeMock.allowDohcInT3Code).not.toHaveBeenCalled();

  await userEvent.click(opener());
  await userEvent.click(again().getByRole("radio", { name: "Full access" }));
  await userEvent.click(again().getByRole("button", { name: "Allow with Full access" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenCalledExactlyOnceWith({ access: "full-access" });
  expect(again().getByTestId<HTMLButtonElement>("t3-code-allow-start").textContent).toBe(
    "Allowing…",
  );
  // Until T3 Code answers, the page says what dohc has now.
  expect(access.getByText(/^Allowed with Auto until /)).toBeTruthy();

  await act(async () => allowing.resolve(allowedHere("full-access")));
  expect(access.getByText(/^Allowed with Full access until /)).toBeTruthy();
  expect(again().queryByRole("radio")).toBeNull();
  expect(document.activeElement).toBe(opener());
  expect(onError).not.toHaveBeenCalled();
});

it("names on the agent's page the mode the person allowed again in the Change thread dialog", async () => {
  // The page itself allowed dohc with Auto, so it holds that answer.
  bridgeMock.readT3CodeConnection.mockResolvedValue(HERE_SIGNED_OUT);
  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("auto"));
  const { page } = await openChiefPage();
  const access = within(page.getByTestId("agent-thread-access"));
  await userEvent.click(await page.findByRole("radio", { name: "Auto" }));
  await userEvent.click(page.getByRole("button", { name: "Allow with Auto" }));
  await access.findByText(/^Allowed with Auto until /);
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("auto"));
  await userEvent.click(page.getByRole("button", { name: "Change thread" }));
  const box = changeDialog();
  await userEvent.click(await box.findByRole("button", { name: "Allow again" }));
  // Allowing again says the sign-in dohc has stays in T3 Code, and what Full access adds.
  expect(box.getByTestId("t3-code-allow-earlier").textContent).toMatch(/revoke it there/);
  expect(box.queryByTestId("t3-code-allow-full-access")).toBeNull();
  await userEvent.click(box.getByRole("radio", { name: "Full access" }));
  expect(box.getByTestId("t3-code-allow-full-access").textContent).toMatch(
    /settings and write to source control/,
  );

  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("full-access"));
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("full-access"));
  await userEvent.click(box.getByRole("button", { name: "Allow with Full access" }));
  expect(await box.findByRole("button", { name: "Allow again" })).toBeTruthy();
  // The page, which read what dohc had before the dialog opened, reads it again.
  // Until that read is in, it says what it last knew, and never "Not allowed".
  expect(access.getByText(/^Allowed with Auto until /)).toBeTruthy();
  const reading = deferred<T3CodeConnectionState>();
  bridgeMock.readT3CodeConnection.mockReturnValueOnce(reading.promise);
  await userEvent.click(box.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(bridgeMock.readT3CodeConnection).toHaveBeenCalledTimes(3));
  expect(access.getByText(/^Allowed with Auto until /)).toBeTruthy();
  await act(async () => reading.resolve(allowedHere("full-access")));
  expect(await access.findByText(/^Allowed with Full access until /)).toBeTruthy();
});

it("keeps a newer answer on the agent's page when an older read comes in after it", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("auto"));
  const { page } = await openChiefPage();
  const access = within(page.getByTestId("agent-thread-access"));
  await access.findByText(/^Allowed with Auto until /);
  // Closing the dialog starts a read, which is slow to answer.
  await userEvent.click(page.getByRole("button", { name: "Change thread" }));
  const box = changeDialog();
  await box.findByRole("button", { name: "Allow again" });
  const reading = deferred<T3CodeConnectionState>();
  bridgeMock.readT3CodeConnection.mockReturnValueOnce(reading.promise);
  await userEvent.click(box.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(bridgeMock.readT3CodeConnection).toHaveBeenCalledTimes(3));

  // Meanwhile the person allows again on the page, with more.
  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("full-access"));
  await userEvent.click(page.getByRole("button", { name: "Allow again" }));
  await userEvent.click(page.getByRole("radio", { name: "Full access" }));
  await userEvent.click(page.getByRole("button", { name: "Allow with Full access" }));
  await access.findByText(/^Allowed with Full access until /);

  // The read was made before that, and says what dohc had then.
  await act(async () => reading.resolve(allowedHere("auto")));
  expect(access.getByText(/^Allowed with Full access until /)).toBeTruthy();
  expect(access.queryByText(/^Allowed with Auto until /)).toBeNull();
});

it("keeps what the agent's page knows when one of two reads is dropped for the other", async () => {
  // The page itself allowed dohc with Auto, over a first read that said it was not allowed.
  bridgeMock.readT3CodeConnection.mockResolvedValue(HERE_SIGNED_OUT);
  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("auto"));
  const { page } = await openChiefPage();
  const access = within(page.getByTestId("agent-thread-access"));
  await userEvent.click(await page.findByRole("radio", { name: "Auto" }));
  await userEvent.click(page.getByRole("button", { name: "Allow with Auto" }));
  await access.findByText(/^Allowed with Auto until /);
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("auto"));

  // Closing the dialog twice starts two reads, and the second replaces the first.
  const closeDialog = async (reading: Promise<T3CodeConnectionState>, reads: number) => {
    await userEvent.click(page.getByRole("button", { name: "Change thread" }));
    await changeDialog().findByRole("button", { name: "Allow again" });
    bridgeMock.readT3CodeConnection.mockReturnValueOnce(reading);
    await userEvent.click(changeDialog().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(bridgeMock.readT3CodeConnection).toHaveBeenCalledTimes(reads));
  };
  const first = deferred<T3CodeConnectionState>();
  const second = deferred<T3CodeConnectionState>();
  await closeDialog(first.promise, 3);
  await closeDialog(second.promise, 5);

  // The dropped read ends, and the page still says what it knew.
  await act(async () => first.resolve(allowedHere("full-access")));
  expect(access.getByText(/^Allowed with Auto until /)).toBeTruthy();
  expect(page.queryByText("Not allowed")).toBeNull();
  await act(async () => second.resolve(allowedHere("full-access")));
  expect(await access.findByText(/^Allowed with Full access until /)).toBeTruthy();
});

it("does not bring back an answer a later read replaced, when the window changes workspaces", async () => {
  // The page itself allowed dohc with Auto.
  bridgeMock.readT3CodeConnection.mockResolvedValue(HERE_SIGNED_OUT);
  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("auto"));
  const both = withChief({ workspaces: ["ws-1", "ws-2"] });
  const { page, rerender } = await openChiefPage(both);
  const access = within(page.getByTestId("agent-thread-access"));
  await userEvent.click(await page.findByRole("radio", { name: "Auto" }));
  await userEvent.click(page.getByRole("button", { name: "Allow with Auto" }));
  await access.findByText(/^Allowed with Auto until /);

  // dohc now has Full access, and the page's read after the dialog says so.
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("full-access"));
  await userEvent.click(page.getByRole("button", { name: "Change thread" }));
  await changeDialog().findByRole("button", { name: "Allow again" });
  await userEvent.click(changeDialog().getByRole("button", { name: "Cancel" }));
  await access.findByText(/^Allowed with Full access until /);

  // The window shows another workspace, whose read is slow to answer.
  const reads = bridgeMock.readT3CodeConnection.mock.calls.length;
  const reading = deferred<T3CodeConnectionState>();
  bridgeMock.readT3CodeConnection.mockReturnValue(reading.promise);
  rerender(both, "ws-2");
  await waitFor(() =>
    expect(bridgeMock.readT3CodeConnection.mock.calls.length).toBeGreaterThan(reads),
  );
  const shown = within(screen.getByTestId("agent-page"));
  expect(shown.queryByText(/^Allowed with Auto until /)).toBeNull();
  await act(async () => reading.resolve(allowedHere("full-access")));
  expect(await shown.findByText(/^Allowed with Full access until /)).toBeTruthy();
  expect(shown.queryByText(/^Allowed with Auto until /)).toBeNull();
});

it("says only until when, for a sign-in the person allowed on T3 Code's page", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(allowedHere(null));
  const { page } = await openChiefPage();
  const access = within(page.getByTestId("agent-thread-access"));
  expect((await access.findByText(/^Allowed until /)).textContent).toMatch(/2099$/);
  expect(access.queryByText(/with/)).toBeNull();
  // dohc does not know the mode, so the choice opens with nothing picked.
  await userEvent.click(page.getByRole("button", { name: "Allow again" }));
  const again = within(page.getByTestId("t3-code-allow-again"));
  expect(again.getAllByRole("radio").some(checked)).toBe(false);
  expect(document.activeElement).toBe(again.getByRole("radio", { name: "Supervised" }));
  expect(again.getByTestId("t3-code-allow-start").textContent).toBe("Allow dohc in T3 Code");
});

it("says on the agent's page why dohc could not sign itself in, beside the pick, and files no notice", async () => {
  const stopped = "T3 Code is not running on this computer.";
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce(HERE_SIGNED_OUT);
  bridgeMock.allowDohcInT3Code.mockRejectedValueOnce(new Error(stopped));
  const { page, row, onError } = await openChiefPage();
  expect(await page.findByText("Not allowed")).toBeTruthy();
  const allow = within(page.getByTestId("t3-code-allow"));
  await userEvent.click(allow.getByRole("radio", { name: "Full access" }));
  await userEvent.click(allow.getByRole("button", { name: "Allow with Full access" }));
  expect((await allow.findByTestId("t3-code-allow-error")).textContent).toBe(stopped);
  expect(onError).not.toHaveBeenCalled();
  // T3 Code's page cannot open while T3 Code is not running, so it is not offered.
  expect(allow.queryByRole("button", { name: "Allow on T3 Code's page" })).toBeNull();

  // The same pick goes again, and the page then reads the thread.
  bridgeMock.allowDohcInT3Code.mockResolvedValueOnce(allowedHere("full-access"));
  await userEvent.click(allow.getByRole("button", { name: "Allow with Full access" }));
  expect(await page.findByText(/^Allowed with Full access until /)).toBeTruthy();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  expect(page.queryByTestId("t3-code-allow-error")).toBeNull();
});

it("changes nothing for an answer that comes after the window changed workspaces", async () => {
  bridgeMock.readT3CodeConnection.mockResolvedValue(allowedHere("auto"));
  const allowing = deferred<T3CodeConnectionState>();
  bridgeMock.allowDohcInT3Code.mockReturnValueOnce(allowing.promise);
  const both = withChief({ workspaces: ["ws-1", "ws-2"] });
  const { page, rerender, onError } = await openChiefPage(both);
  await page.findByText(/^Allowed with Auto until /);
  await userEvent.click(page.getByRole("button", { name: "Allow again" }));
  await userEvent.click(page.getByRole("radio", { name: "Full access" }));
  await userEvent.click(page.getByRole("button", { name: "Allow with Full access" }));

  rerender(both, "ws-2");
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledOnce();
  await act(async () => allowing.resolve(allowedHere("full-access")));
  // The other workspace's page says what dohc read for it, not the late answer.
  const shown = within(screen.getByTestId("agent-page"));
  expect(await shown.findByText(/^Allowed with Auto until /)).toBeTruthy();
  expect(shown.queryByText(/Full access until/)).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});

it("starts the Change thread dialog on the choice of mode when dohc is not allowed", async () => {
  bridgeMock.readT3CodeConnection
    .mockResolvedValueOnce(HERE_SIGNED_OUT)
    .mockResolvedValueOnce(HERE_SIGNED_OUT);
  const { page } = await openChiefPage();
  expect(await page.findByText("Not allowed")).toBeTruthy();
  await userEvent.click(page.getByRole("button", { name: "Change thread" }));
  const box = changeDialog();
  // The button waits for a mode, so focus starts on the choice.
  const supervised = await box.findByRole("radio", { name: "Supervised" });
  await waitFor(() => expect(document.activeElement).toBe(supervised));
  expect(screen.queryByTestId("agent-thread-change-confirm")).toBeNull();

  await userEvent.keyboard("{End}");
  await userEvent.click(box.getByRole("button", { name: "Allow with Full access" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenCalledExactlyOnceWith({ access: "full-access" });
  expect(await box.findByRole("radio", { name: /^Issue owner/ })).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(box.getByRole("combobox", { name: "Project" })),
  );
});

// An agent's thread gets a workspace's messages only once the person turns
// that workspace on (ADR 0016). Here the agent forwards from ws-2, and the
// window shows ws-1.
const ELSEWHERE = withChief({ workspaces: ["ws-2"] });
const askDialog = () => within(screen.getByTestId("agent-workspace-dialog"));
const askConfirm = () => screen.getByTestId<HTMLButtonElement>("agent-workspace-confirm");
// The page of an agent in a workspace it may not forward from, which has no Thread row.
async function openChiefPageIn(settings: DesktopUserSettings) {
  const rendered = renderList(settings);
  await userEvent.click(screen.getByRole("button", { name: "Chief of Staff" }));
  return { ...rendered, page: within(screen.getByTestId("agent-page")) };
}
// The same page with the ask open.
async function openAsk(settings: DesktopUserSettings = ELSEWHERE) {
  const opened = await openChiefPageIn(settings);
  const turnOn = workspaceSwitch(opened.page);
  await userEvent.click(turnOn);
  return { ...opened, turnOn };
}

it("offers no thread, Open or Change in a workspace the agent does not forward from", async () => {
  const { page, onError } = await openChiefPageIn(ELSEWHERE);
  // T3 Code allows dohc, which is when a page that forwards from here reads the thread.
  expect(await page.findByText(/^Allowed until /)).toBeTruthy();
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();
  expect(page.queryByTestId("agent-page-thread")).toBeNull();
  expect(page.queryByRole("button", { name: "Open in T3 Code" })).toBeNull();
  expect(page.queryByRole("button", { name: "Change thread" })).toBeNull();
  expect(onError).not.toHaveBeenCalled();

  // The page says why, on the row with the switch that changes it.
  expect(page.getByTestId("agent-thread-workspace").textContent).toBe(
    "Forward from this workspaceIts thread gets no messages from this workspace.",
  );
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("false");

  // What does not depend on this workspace stays.
  expect(page.getByRole("switch", { name: "Forward messages to Chief of Staff" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Allow again" })).toBeTruthy();
  expect(page.getByRole("radio", { name: "Wait in line" })).toBeTruthy();
  expect(page.getByRole("textbox", { name: "Your note" })).toBeTruthy();
});

it("asks before a workspace's messages go to the thread, and says what the thread then holds", async () => {
  const { page, turnOn, onSave } = await openAsk();
  const dialog = screen.getByRole("dialog", {
    name: "Forward messages from Trip to Chief of Staff?",
  });
  const holds =
    "dohc will forward messages from this workspace to Chief of Staff's thread, which also holds messages from 1 other workspace.";
  const appears =
    "What the thread learns in one workspace can appear in what it posts in another, where other people can read it.";
  expect(askDialog().getByText(holds)).toBeTruthy();
  expect(askDialog().getByText(appears)).toBeTruthy();
  // A screen reader reads both sentences after the title.
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toBe(
    holds + appears,
  );
  expect(askConfirm().textContent).toBe("Forward from this workspace");
  expect(document.activeElement).toBe(askConfirm());
  // Nothing has taken effect.
  expect(bridgeMock.setAgentThreadWorkspace).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  expect(turnOn.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(askDialog().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(turnOn));
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("false");
  expect(bridgeMock.setAgentThreadWorkspace).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();
});

it("counts the other workspaces in the ask, and says when the agent's forwarding is off", async () => {
  const { rerender } = await openAsk(withChief({ workspaces: ["ws-2", "ws-3"] }));
  expect(
    askDialog().getByText(
      "dohc will forward messages from this workspace to Chief of Staff's thread, which also holds messages from 2 other workspaces.",
    ),
  ).toBeTruthy();
  // An agent that forwards from no workspace has a thread that held some before.
  rerender(withChief({ workspaces: [], enabled: false }));
  expect(
    askDialog().getByText(
      "Once Forward messages is on, dohc will forward messages from this workspace to Chief of Staff's thread, which keeps every message it already has from any workspace.",
    ),
  ).toBeTruthy();
});

const HERE_TOO = withChief({ workspaces: ["ws-2", "ws-1"] });

it("turns a workspace on in main, saves nothing itself, and shows the thread once the settings have it", async () => {
  const telling = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(telling.promise);
  const { page, onSave, rerender } = await openAsk();
  // Two presses before the window draws again ask main once.
  act(() => {
    askConfirm().click();
    askConfirm().click();
  });
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    on: true,
  });
  // While main turns it on the button says so, and the dialog stays.
  expect(askConfirm().textContent).toBe("Turning on…");
  expect(askConfirm().disabled).toBe(true);
  expect(askDialog().getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(
    true,
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByTestId("agent-workspace-dialog")).toBeTruthy();

  // Main answers before its settings reach this window. The ask closes, and
  // the page shows what the settings here still say.
  await act(async () => telling.resolve());
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("false");
  expect(page.queryByTestId("agent-page-thread")).toBeNull();
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();

  // Main's settings arrive, and the page is one of a workspace the agent forwards from.
  rerender(HERE_TOO);
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("true");
  expect(await page.findByText("Chief of Staff: dohc")).toBeTruthy();
  expect(page.getByRole("button", { name: "Open in T3 Code" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Change thread" })).toBeTruthy();
  expect(page.getByTestId("agent-thread-workspace").textContent).toBe(
    "Forward from this workspace",
  );
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledOnce();
  // Main saved the workspace. This window saved nothing.
  expect(onSave).not.toHaveBeenCalled();
});

it("shows the thread only once the ask has closed, when main's settings arrive before its answer", async () => {
  const telling = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(telling.promise);
  const { page, onSave, rerender } = await openAsk();
  await userEvent.click(askConfirm());
  rerender(HERE_TOO);
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("true");
  expect(askConfirm().textContent).toBe("Turning on…");
  expect(page.queryByTestId("agent-page-thread")).toBeNull();
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();

  await act(async () => telling.resolve());
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  expect(await page.findByText("Chief of Staff: dohc")).toBeTruthy();
  expect(bridgeMock.readAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
  });
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps the ask open when main could not turn the workspace on, says why, and asks again", async () => {
  const stopped = "T3 Code is not running on this computer.";
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(new Error(stopped));
  const { page, onSave, onError } = await openAsk();
  await userEvent.click(askConfirm());
  expect((await askDialog().findByTestId("agent-workspace-error")).textContent).toBe(stopped);
  expect(askDialog().getByRole("alert").textContent).toBe(stopped);
  // The ask is still open, so it says why itself, and files no notice.
  expect(onError).not.toHaveBeenCalled();
  expect(workspaceSwitch(page).getAttribute("aria-checked")).toBe("false");
  expect(bridgeMock.readAgentThread).not.toHaveBeenCalled();
  expect(askConfirm().textContent).toBe("Forward from this workspace");
  expect(askConfirm().disabled).toBe(false);
  expect(document.activeElement).toBe(askConfirm());

  // A save that failed in main is said in the same place.
  const unsaved = "dohc did not save settings.";
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(new Error(unsaved));
  await userEvent.click(askConfirm());
  expect((await askDialog().findByTestId("agent-workspace-error")).textContent).toBe(unsaved);
  expect(screen.getByTestId("agent-workspace-dialog")).toBeTruthy();

  // The same button asks again, and the reason goes while it does.
  const telling = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(telling.promise);
  await userEvent.click(askConfirm());
  expect(askDialog().queryByTestId("agent-workspace-error")).toBeNull();
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledTimes(3);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenLastCalledWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    on: true,
  });
  await act(async () => telling.resolve());
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("says in its own words that the thread could not be told, when the error says nothing", async () => {
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(undefined);
  await openAsk();
  await userEvent.click(askConfirm());
  expect((await askDialog().findByTestId("agent-workspace-error")).textContent).toBe(
    "dohc could not tell Chief of Staff's thread about this workspace.",
  );
});

it("leaves another workspace's ask open when an earlier ask's answer comes late", async () => {
  const telling = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(telling.promise);
  // The agent forwards from neither workspace the window shows here.
  const neither = withChief({ workspaces: ["ws-3"] });
  const { onSave, onError, rerender } = await openAsk(neither);
  await userEvent.click(askConfirm());
  // The window now shows ws-2, and the ask went with ws-1.
  rerender(neither, "ws-2");
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  await userEvent.click(workspaceSwitch(within(screen.getByTestId("agent-page"))));
  expect(askConfirm().textContent).toBe("Forward from this workspace");

  // The answer was for ws-1. The ask for ws-2 is still open, with nothing asked of main.
  await act(async () => telling.resolve());
  expect(screen.getByTestId("agent-workspace-dialog")).toBeTruthy();
  expect(askConfirm().disabled).toBe(false);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("turns a workspace off in main without asking, and saves nothing itself", async () => {
  const saving = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(saving.promise);
  const { page, row, onSave, onError, rerender } = await openChiefPage(
    withChief({ workspaces: ["ws-2", "ws-1", "ws-3"] }),
  );
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  const toggle = workspaceSwitch(page);
  expect(page.queryByTestId("switch-busy")).toBeNull();
  // Two presses before the window draws again ask main once.
  act(() => {
    toggle.click();
    toggle.click();
  });
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    on: false,
  });
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();
  // The switch moves at the press and holds still until main answers.
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.getAttribute("aria-busy")).toBe("true");
  expect(page.getByTestId("switch-busy")).toBeTruthy();
  // A press while it runs asks main nothing more, and does not ask to turn it on.
  await userEvent.click(toggle);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();

  // Main's settings arrive, and then its answer.
  rerender(withChief({ workspaces: ["ws-2", "ws-3"] }));
  expect(toggle.getAttribute("aria-busy")).toBe("true");
  await act(async () => saving.resolve());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.getAttribute("aria-busy")).toBeNull();
  expect(page.queryByTestId("switch-busy")).toBeNull();
  // The page is then one of a workspace the agent does not forward from.
  expect(page.queryByTestId("agent-page-thread")).toBeNull();
  expect(page.queryByRole("button", { name: "Change thread" })).toBeNull();
  expect(page.getByTestId("agent-thread-workspace").textContent).toBe(
    "Forward from this workspaceIts thread gets no messages from this workspace.",
  );
  expect(onSave).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();

  // Turning it on again asks again.
  await userEvent.click(toggle);
  expect(screen.getByTestId("agent-workspace-dialog")).toBeTruthy();
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledOnce();
});

it("shows what the settings say once main has answered a turn-off, before its settings arrive", async () => {
  const { page, row, rerender } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  const toggle = workspaceSwitch(page);
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-busy")).toBeNull());
  // The settings here still have the workspace, and the page shows them.
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(page.getByTestId("agent-page-thread")).toBeTruthy();

  rerender(withChief({ workspaces: [] }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(page.queryByTestId("agent-page-thread")).toBeNull();
});

it("reports a workspace main could not turn off, with a Try again, and the switch reads on", async () => {
  const unsaved = "dohc did not save settings.";
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(new Error(unsaved));
  const { page, row, onSave, onError } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  const toggle = workspaceSwitch(page);
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      unsaved,
      expect.any(Error),
      expect.any(Function),
    ),
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.getAttribute("aria-busy")).toBeNull();
  expect(page.getByTestId("agent-page-thread")).toBeTruthy();
  expect(screen.queryByTestId("agent-workspace-dialog")).toBeNull();

  // The notice's Try again asks main again. An error that says nothing gets the page's words.
  const tryAgain = () => (onError.mock.lastCall![2] as () => Promise<void>)();
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(undefined);
  await act(tryAgain);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledTimes(2);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenLastCalledWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    on: false,
  });
  expect(onError).toHaveBeenLastCalledWith(
    "dohc could not stop forwarding from this workspace to Chief of Staff.",
    undefined,
    expect.any(Function),
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  // A Try again that works reports nothing more.
  await act(tryAgain);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(2);
  expect(onSave).not.toHaveBeenCalled();
});

const BOTH = withChief({ workspaces: ["ws-1", "ws-2"] });

it("reports nothing for a turn-off's answer that comes after the window changed workspaces", async () => {
  const saving = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(saving.promise);
  const { page, row, onError, rerender } = await openChiefPage(BOTH);
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  await userEvent.click(workspaceSwitch(page));
  // The window now shows ws-2, which the agent forwards from too.
  rerender(BOTH, "ws-2");
  const shown = () => workspaceSwitch(within(screen.getByTestId("agent-page")));
  expect(shown().getAttribute("aria-checked")).toBe("true");
  expect(shown().getAttribute("aria-busy")).toBeNull();

  await act(async () =>
    saving.reject(new Error("Nothing was changed because this window changed workspaces.")),
  );
  expect(onError).not.toHaveBeenCalled();
  expect(shown().getAttribute("aria-checked")).toBe("true");
  // The switch of ws-2 asks main about ws-2.
  await userEvent.click(shown());
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenLastCalledWith({
    workspaceId: "ws-2",
    agentId: "t3-code",
    on: false,
  });
});

it("reports nothing for a turn-off's answer that comes after the agent's page is gone", async () => {
  const saving = deferred();
  bridgeMock.setAgentThreadWorkspace.mockReturnValueOnce(saving.promise);
  const { page, row, onError, rerender } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  await userEvent.click(workspaceSwitch(page));
  // The agent was removed from the settings file.
  rerender(SETTINGS);
  expect(screen.queryByTestId("agent-page")).toBeNull();
  await act(async () => saving.reject(new Error("This agent is no longer in Settings.")));
  expect(onError).not.toHaveBeenCalled();
});

it("asks main nothing from a failed turn-off's Try again once the window shows another workspace", async () => {
  bridgeMock.setAgentThreadWorkspace.mockRejectedValueOnce(
    new Error("dohc did not save settings."),
  );
  const { page, row, onError, rerender } = await openChiefPage(BOTH);
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  await userEvent.click(workspaceSwitch(page));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  const tryAgain = onError.mock.lastCall![2] as () => Promise<void>;

  rerender(BOTH, "ws-2");
  await act(tryAgain);
  expect(bridgeMock.setAgentThreadWorkspace).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledOnce();
});

it("says in the Change thread dialog how many other workspaces get the new thread", async () => {
  const { rerender } = await openChangeDialog(withChief({ workspaces: ["ws-1", "ws-2"] }));
  const others = () => changeDialog().queryByTestId("agent-thread-change-workspaces");
  expect(others()!.textContent).toBe(
    "The thread you choose gets messages from this workspace and 1 other workspace.",
  );
  // A screen reader reads it with the dialog's first sentence.
  const dialog = screen.getByRole("dialog", { name: "Change Chief of Staff's thread" });
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toMatch(
    /existing messages\.The thread you choose gets messages from this workspace and 1 other workspace\.$/,
  );
  rerender(withChief({ workspaces: ["ws-3", "ws-1", "ws-2"] }));
  expect(others()!.textContent).toBe(
    "The thread you choose gets messages from this workspace and 2 other workspaces.",
  );
  // An agent that forwards from this workspace alone has nothing more to say.
  rerender(WITH_CHIEF);
  expect(others()).toBeNull();
});
