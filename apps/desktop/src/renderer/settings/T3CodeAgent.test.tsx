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
});
afterEach(cleanup);

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
const threadRow = (title: string) => sheet().getByRole("radio", { name: new RegExp(`^${title}`) });
async function chooseT3Code() {
  await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
  await userEvent.click(screen.getByTestId("agent-runs-with-t3-code"));
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
    "This computer cannot encrypt dohc's sign-in to T3 Code, so dohc cannot connect to T3 Code.",
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
  expect(allow.getByText(/A thread with full access needs Full access\./)).toBeTruthy();
  // T3 Code's page takes the mode, so dohc offers no choice of one.
  expect(allow.queryByRole("radio")).toBeNull();
  expect(screen.queryByTestId("agent-add-confirm")).toBeNull();

  await userEvent.click(allow.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(bridgeMock.allowDohcInT3Code).toHaveBeenLastCalledWith({ access: null });
  expect(allow.getByRole("status").textContent).toBe("Waiting for T3 Code");
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
  expect(nameField().value).toBe("Agent");

  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(sheet().getByRole("alert").textContent).toBe("Choose a thread.");
  expect(bridgeMock.readyAgentThread).not.toHaveBeenCalled();

  await userEvent.click(chief);
  expect(sheet().queryByRole("alert")).toBeNull();
  expect(nameField().value).toBe("Chief of Staff: dohc");
  await userEvent.click(threadRow("Issue owner"));
  expect(nameField().value).toBe("Issue owner");
  await userEvent.clear(nameField());
  await userEvent.type(nameField(), "Chief");
  await userEvent.click(chief);
  expect(nameField().value).toBe("Chief");

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
  expect(nameField().value).toBe("Issue owner");

  // The list is gone, so no thread it showed can still be the choice.
  await userEvent.click(screen.getByTestId("agent-runs-with-mcp"));
  await userEvent.click(screen.getByTestId("agent-runs-with-t3-code"));
  const row = await sheet().findByRole("radio", { name: /^Issue owner/ });
  expect(row.getAttribute("aria-checked")).toBe("false");
  expect(nameField().value).toBe("Agent");

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
  expect(page.getByTestId("agent-thread-workspace").textContent).toBe("This workspace");
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

it("does not name the thread the agent left while its save is still on its way", async () => {
  const { row, rerender } = await openChiefPage();
  expect(await row.findByText("Chief of Staff: dohc")).toBeTruthy();
  // Settings show the new thread at once. The save has not landed, so the
  // first answer is still for the thread the agent had.
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

  // The person changes the thread. The save has not landed, so the first
  // answer is still that the old thread is gone. It is not said of the new one.
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

it("changes the thread: readies the picked one, then saves the agent with it and nothing else", async () => {
  const readying = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(readying.promise);
  const { row, onSave, rerender, opener, issue } = await openChangeDialog();
  const box = changeDialog();
  expect(screen.getByRole("dialog", { name: "Change Chief of Staff's thread" })).toBeTruthy();
  expect(
    box.getByText(
      "From now on, dohc forwards to the thread you choose, and the old thread keeps the messages it has.",
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
  await userEvent.click(changeConfirm());
  expect(bridgeMock.changeAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-1",
    agentId: "t3-code",
    threadId: "t-issue",
  });
  // While the thread is readied the button says so, nothing is saved, and the dialog stays.
  expect(changeConfirm().textContent).toBe("Changing…");
  expect(changeConfirm().disabled).toBe(true);
  expect(box.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByTestId("agent-thread-change-dialog")).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();

  await act(async () => readying.resolve());
  expect(onSave).toHaveBeenCalledOnce();
  const saved = onSave.mock.calls[0]![0];
  expect(saved).toEqual(withChief({ thread: { tool: "t3-code", id: "t-issue" } }));
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));

  // The saved agent's row names the new thread.
  bridgeMock.readAgentThread.mockResolvedValueOnce({
    threadId: "t-issue",
    title: "Issue owner",
    closed: false,
  });
  rerender(saved);
  expect(await row.findByText("Issue owner")).toBeTruthy();
});

it("keeps the dialog and the pick when the thread can't be readied, and saves nothing", async () => {
  const refusal =
    "T3 Code refused dohc because this thread runs with a broader mode than dohc was allowed.";
  bridgeMock.changeAgentThread.mockRejectedValueOnce(new Error(refusal));
  const { onSave, issue } = await openChangeDialog();
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  expect((await changeDialog().findByTestId("agent-thread-change-error")).textContent).toBe(
    refusal,
  );
  expect(onSave).not.toHaveBeenCalled();
  expect(issue.getAttribute("aria-checked")).toBe("true");
  expect(changeConfirm().textContent).toBe("Change thread");
  expect(changeConfirm().disabled).toBe(false);
  expect(document.activeElement).toBe(changeConfirm());

  // The same pick goes again from the same button.
  await userEvent.click(changeConfirm());
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0]![0].agents["t3-code"]!.thread).toEqual({
    tool: "t3-code",
    id: "t-issue",
  });
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
});

it("saves nothing for an answer that comes after the window changed workspaces", async () => {
  const readying = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(readying.promise);
  const both = withChief({ workspaces: ["ws-1", "ws-2"] });
  const { onSave, onError, rerender, issue } = await openChangeDialog(both);
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  rerender(both, "ws-2");
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  await act(async () => readying.resolve());
  expect(onSave).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("saves nothing for an answer that comes after the agent's page is gone", async () => {
  const readying = deferred();
  bridgeMock.changeAgentThread.mockReturnValueOnce(readying.promise);
  const { onSave, onError, rerender, issue } = await openChangeDialog();
  await userEvent.click(issue);
  await userEvent.click(changeConfirm());
  // The agent was removed from the settings file.
  rerender(SETTINGS);
  expect(screen.queryByTestId("agent-thread-change-dialog")).toBeNull();
  await act(async () => readying.resolve());
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
      name: "Pick the mode of the thread you want to connect, or more.",
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
  nameField().focus();
  nameField().blur();
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
  expect(allow.getByRole("status").textContent).toBe("Waiting for T3 Code");
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
  expect(access.getByText(/^Allowed with Auto until /)).toBeTruthy();
  await userEvent.click(box.getByRole("button", { name: "Cancel" }));
  expect(await access.findByText(/^Allowed with Full access until /)).toBeTruthy();
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
