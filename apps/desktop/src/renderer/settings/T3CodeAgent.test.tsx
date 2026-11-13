// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import type {
  AgentsListeningEvent,
  PersonalAgentsEvent,
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
};
const SIGNED_OUT: T3CodeConnectionState = { canKeep: true, signedInUntilMs: null };
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
  allowDohcInT3Code: vi.fn(async (): Promise<T3CodeConnectionState> => SIGNED_IN),
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

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function renderList(settings: DesktopUserSettings = SETTINGS) {
  const onSave = vi.fn(
    async (next: DesktopUserSettings): Promise<DesktopUserSettingsResult | null> => ({
      settings: next,
      source: "stored",
    }),
  );
  const onError = vi.fn();
  const list = (current: DesktopUserSettings) => (
    <WorkspaceSessionProvider workspaceId="ws-1">
      <AgentList
        workspaceId="ws-1"
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
  return { onSave, onError, rerender: (next: DesktopUserSettings) => rerender(list(next)) };
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
  bridgeMock.readT3CodeConnection.mockResolvedValueOnce({ canKeep: false, signedInUntilMs: null });
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
  // The way to a sign-in code, and what the mode picked there decides.
  expect(allow.getByText(/Sharing & access, then Authorized clients/)).toBeTruthy();
  expect(allow.getByText(/Copy code only/)).toBeTruthy();
  expect(allow.getByText(/A thread with full access needs Full access\./)).toBeTruthy();
  expect(screen.queryByTestId("agent-add-confirm")).toBeNull();

  await userEvent.click(allow.getByRole("button", { name: "Allow dohc in T3 Code" }));
  expect(allow.getByRole("status").textContent).toBe("Waiting for T3 Code");
  await userEvent.click(allow.getByRole("button", { name: "Cancel waiting for T3 Code" }));
  expect(bridgeMock.cancelAllowDohcInT3Code).toHaveBeenCalledOnce();
  // The wait the person cancelled says nothing when it ends.
  await act(async () => first.reject(new Error("The wait was cancelled.")));
  expect(allow.queryByRole("alert")).toBeNull();

  // An ask T3 Code turns down says why, above the button that asks again.
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
  // The row says T3 Code's own word for what the thread is doing.
  expect(within(chief).getByText("Working")).toBeTruthy();
  expect(bridgeMock.listT3CodeThreads).toHaveBeenCalledWith({ projectId: "p-dohc" });
  expect(nameField().value).toBe("Agent");

  // Add with no thread chosen says so, and adds nothing.
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(sheet().getByRole("alert").textContent).toBe("Choose a thread.");
  expect(bridgeMock.readyAgentThread).not.toHaveBeenCalled();

  await userEvent.click(chief);
  expect(sheet().queryByRole("alert")).toBeNull();
  expect(nameField().value).toBe("Chief of Staff: dohc");
  await userEvent.click(threadRow("Issue owner"));
  expect(nameField().value).toBe("Issue owner");
  // A typed name stays when another thread is picked.
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

  // A search with no thread says which words found nothing.
  bridgeMock.listT3CodeThreads.mockResolvedValueOnce(onePage());
  await searchFor("z");
  expect((await sheet().findByTestId("t3-code-threads-empty")).textContent).toBe(
    'No threads match "owz".',
  );
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

  // A list that could not load says so in its place, and reads again.
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
  await userEvent.click(page.getByRole("radio", { name: "Forward right away" }));
  expect(saved().whileBusy).toBe("steer");
  rerender({ ...WITH_CHIEF, agents: { ...SETTINGS.agents, "t3-code": saved() } });
  expect(
    page.getByText("Only your own messages go right away. Other people's wait in line."),
  ).toBeTruthy();

  const note = page.getByRole<HTMLTextAreaElement>("textbox", { name: "Your note" });
  expect(note.maxLength).toBe(4000);
  await userEvent.type(note, "Post decisions here. ");
  // The note saves when focus leaves it, not on each key.
  expect(saved().note).toBeUndefined();
  fireEvent.blur(note);
  expect(saved().note).toBe("Post decisions here.");
  rerender({ ...WITH_CHIEF, agents: { ...SETTINGS.agents, "t3-code": saved() } });
  expect(note.value).toBe("Post decisions here.");

  // Escape keeps the note as it was, and an empty note removes the key.
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
