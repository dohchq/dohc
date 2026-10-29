// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENTS_RESTRICTED_MESSAGE, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ChatDispatchPausedEvent, RunnerSelfTestResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type AgentProblem, type DesktopUserSettings, type DesktopUserSettingsResult } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList, agentListRows } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
const bridgeMock = {
  getUserSettings: vi.fn(async (): Promise<DesktopUserSettingsResult> => ({ settings: SETTINGS, source: "stored" })),
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: true })),
  setUserSettings: vi.fn(async (payload: { settings: DesktopUserSettings; base: DesktopUserSettings }): Promise<DesktopUserSettingsResult> => (
    { settings: payload.settings, source: "stored" })),
  readChatDispatchPaused: vi.fn(async () => ({ paused: false })),
  onChatDispatchPaused: vi.fn((listener: (event: ChatDispatchPausedEvent) => void) => {
    pausedListener = listener;
    return () => { pausedListener = null; };
  }),
  setChatDispatchPaused: vi.fn(async (_event: ChatDispatchPausedEvent) => undefined),
  runnerSelfTest: vi.fn(async (_payload: { workspaceId: string; agentId: string }): Promise<RunnerSelfTestResult> => ({ ok: true, detail: "Runner self-test passed." })),
  detectAgentTools: vi.fn(async (_payload: { workspaceId: string }): Promise<AgentToolsResult> => ({
    workingDirectory: "C:\\Work",
    tools: [{ tool: "codex", executable: "C:\\Tools\\codex.exe", version: "0.98", auth: "signed-in", probe: "detected" }],
  })),
};
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

const { launch: _launch, ...mcpOnly } = testAgent({ name: "Claude in Terminal", hue: "rose", enabled: false });
const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  agents: {
    default: testAgent({ name: "Claude Code" }),
    codex: testAgent({ name: "Codex", hue: "blue", launch: { tool: "codex", executable: "C:\\Tools\\codex.exe" } }),
    terminal: mcpOnly,
  },
};
const BROKEN: AgentProblem = { id: "codex-two", name: "codex", hue: "teal", position: 1, problem: "Another agent has this name." };

beforeEach(() => {
  vi.clearAllMocks();
  pausedListener = null;
});
afterEach(cleanup);

function renderList(fields: Partial<Parameters<typeof AgentList>[0]> = {}) {
  const onSave = vi.fn(async (settings: DesktopUserSettings): Promise<DesktopUserSettingsResult | null> => ({ settings, source: "stored" }));
  const onError = vi.fn();
  const onOpenSettingsFile = vi.fn();
  const onOrder = vi.fn(async (_order: readonly string[]) => true);
  const onNotice = vi.fn((_message: string, _undo?: () => void) => undefined);
  const list = (more: Partial<Parameters<typeof AgentList>[0]> = {}) => (
    <AgentList workspaceId="ws-1" settings={SETTINGS} config={null} sessionRecorderOn
      onSave={onSave} onOrder={onOrder} onError={onError} onNotice={onNotice} onOpenSettingsFile={onOpenSettingsFile} {...fields} {...more} />
  );
  const { rerender, unmount } = render(list());
  return { onSave, onOrder, onNotice, onError, onOpenSettingsFile, unmount, rerender:(more: Partial<Parameters<typeof AgentList>[0]>) => rerender(list(more)) };
}

const row = (name: string) => screen.getByRole("button", { name: `Rename ${name}` }).closest<HTMLElement>("[data-agent-id]")!;

it("lists the entries dohc could not use in the file's order", () => {
  expect(agentListRows(SETTINGS, [{ ...BROKEN, position: 0 }, { ...BROKEN, id: "last", position: 4 }])
    .map((entry) => entry.kind === "agent" ? entry.agent.id : entry.problem.id))
    .toEqual(["codex-two", "default", "codex", "terminal", "last"]);
});

it("shows each agent with its controls, and an agent you run with no Check and no switch", () => {
  renderList();
  expect(screen.getAllByTestId("agent-row").map((element) => element.dataset.agentId)).toEqual(["default", "codex", "terminal"]);
  const claude = within(row("Claude Code"));
  expect(claude.getByRole("button", { name: "Check" })).toBeTruthy();
  expect(claude.getByRole("switch", { name: "Turn on Claude Code" }).getAttribute("aria-checked")).toBe("true");
  expect(claude.getByRole("button", { name: "Claude Code actions" })).toBeTruthy();
  const terminal = within(row("Claude in Terminal"));
  expect(terminal.getByText("Through MCP")).toBeTruthy();
  expect(terminal.queryByRole("button", { name: "Check" })).toBeNull();
  expect(terminal.queryByRole("switch")).toBeNull();
  expect(terminal.getByRole("button", { name: "Claude in Terminal actions" })).toBeTruthy();
});

it("keeps an entry dohc could not use in its place, with its problem and a way to the file", async () => {
  const { onOpenSettingsFile } = renderList({
    agentProblems: [BROKEN, { id: "Agent B", position: 4, problem: "dohc doesn't use `color`." }],
  });
  const rows = screen.getAllByTestId(/^agent-row/);
  expect(rows.map((element) => element.dataset.agentId)).toEqual(["default", "codex-two", "codex", "terminal", "Agent B"]);
  const broken = within(rows[1]!);
  expect(broken.getByText("codex")).toBeTruthy();
  expect(broken.getByTestId("agent-problem").textContent).toBe("Another agent has this name.");
  expect(broken.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect((broken.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect(broken.queryByRole("button", { name: /actions/ })).toBeNull();
  expect(broken.queryByRole("button", { name: /Remove|Undo/ })).toBeNull();
  await userEvent.click(broken.getByRole("button", { name: "Open settings file" }));
  expect(onOpenSettingsFile).toHaveBeenCalledTimes(1);
  // Without a name the row shows the id, and the key is set in monospace.
  const nameless = within(rows[4]!);
  expect(nameless.getByText("Agent B")).toBeTruthy();
  expect(nameless.getByText("color").tagName).toBe("CODE");
});

it("checks one agent, then says how long its reply took", async () => {
  const answer = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(answer.promise);
  renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex" });
  expect(within(row("Codex")).getByText("Checking")).toBeTruthy();
  // Main runs one runner per workspace, so the other Check waits.
  expect((within(row("Claude Code")).getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => answer.resolve({ ok: true, detail: "Runner self-test passed." }));
  expect(within(row("Codex")).getByText(/^Replied in \d+ s$/)).toBeTruthy();
});

it("says an agent didn't reply, names it in Notices with why and its log, and offers Try again", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({
    ok: false, detail: "Runner self-test timed out after 120 seconds.", logPath: "C:\\Logs\\check.log",
  });
  const { onError } = renderList();
  await userEvent.click(within(row("Claude Code")).getByRole("button", { name: "Check" }));
  expect(await within(row("Claude Code")).findByText("Didn't reply.")).toBeTruthy();
  expect(onError).toHaveBeenCalledWith("Claude Code didn't reply to the check.", undefined, expect.any(Function), [
    ["Cause", "Runner self-test timed out after 120 seconds."],
    ["Log", "C:\\Logs\\check.log"],
  ], "agent-check:ws-1:default");
  await userEvent.click(within(row("Claude Code")).getByRole("button", { name: "Try again" }));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
});

it("checks the agent again from the failed check's toast", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Runner exited before reporting self-test success." });
  const { onError } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  const retry = onError.mock.calls[0]![2] as () => Promise<void>;
  await act(() => retry());
  expect(bridgeMock.runnerSelfTest).toHaveBeenLastCalledWith({ workspaceId: "ws-1", agentId: "codex" });
  expect(within(row("Codex")).getByText(/^Replied in \d+ s$/)).toBeTruthy();

  // While Check can't start, Try again says why, and can be tried again.
  const running = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(running.promise);
  await userEvent.click(within(row("Claude Code")).getByRole("button", { name: "Check" }));
  await act(() => retry());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", "A check is already running. Try again when it finishes."],
  ], "agent-check:ws-1:codex");
  await act(async () => running.resolve({ ok: true, detail: "self-test ok" }));
  act(() => pausedListener?.({ paused: true }));
  await act(() => retry());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", "Agents are paused. Resume them, then try again."],
  ], "agent-check:ws-1:codex");
});

it("checks again from the toast when the check couldn't start", async () => {
  bridgeMock.runnerSelfTest.mockRejectedValueOnce(new Error(""));
  const { onError } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not check Codex.", expect.any(Error), expect.any(Function), undefined, "agent-check:ws-1:codex"));
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
  expect(within(row("Codex")).getByText(/^Replied in \d+ s$/)).toBeTruthy();
});

it("pauses every agent dohc starts that is on, and leaves the rest as they are", async () => {
  renderList({ settings: { ...SETTINGS, agents: { ...SETTINGS.agents, off: testAgent({ name: "Codex off", enabled: false }) } } });
  await userEvent.click(screen.getByRole("button", { name: "Pause all" }));
  expect(bridgeMock.setChatDispatchPaused).toHaveBeenCalledWith({ paused: true });
  act(() => pausedListener?.({ paused: true }));
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(screen.getByTestId("agents-paused").textContent).toBe("Paused until you resume or quit dohc.");
  for (const name of ["Claude Code", "Codex"]) {
    expect(within(row(name)).getByText("Paused")).toBeTruthy();
    expect((within(row(name)).getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);
  }
  // An agent that is off has nothing to pause.
  expect(within(row("Codex off")).queryByText("Paused")).toBeNull();
  expect(within(row("Claude in Terminal")).getByText("Through MCP")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(bridgeMock.setChatDispatchPaused).toHaveBeenLastCalledWith({ paused: false });
});

it("turns an agent off from its switch", async () => {
  const { onSave } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("switch"));
  expect(onSave.mock.calls[0]![0].agents.codex?.enabled).toBe(false);
});

it("renames an agent in place, and refuses a name another agent has", async () => {
  const { onSave } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Rename Codex" }));
  const field = screen.getByRole("textbox", { name: "Name of Codex" });
  await userEvent.clear(field);
  await userEvent.type(field, "claude code");
  expect(screen.getByRole("alert").textContent).toBe("Another agent has this name.");
  await userEvent.keyboard("{Enter}");
  expect(onSave).not.toHaveBeenCalled();
  await userEvent.clear(field);
  await userEvent.type(field, "Codex Work{Enter}");
  expect(onSave.mock.calls[0]![0].agents.codex?.name).toBe("Codex Work");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("shows how dohc starts an agent in its details", async () => {
  renderList();
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
  const details = within(row("Codex")).getByTestId("agent-details");
  expect(await within(details).findByText("Codex 0.98, signed in")).toBeTruthy();
  expect(within(details).getByText("C:\\Tools\\codex.exe")).toBeTruthy();
  expect(within(details).getByText("30 min")).toBeTruthy();
  expect(within(details).getByRole("button", { name: "Use your own command" })).toBeTruthy();
  expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);
  await userEvent.click(within(details).getByRole("button", { name: "Details" }));
  expect(within(row("Codex")).queryByTestId("agent-details")).toBeNull();
});

// An agent's swatches are squares, olive first, and set only that agent's color.
it("sets an agent's color in its details", async () => {
  const { onSave } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
  const color = within(row("Codex")).getByRole("radiogroup", { name: "Color of Codex" });
  const hues = within(color).getAllByRole("radio");
  expect(hues.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Olive", "Rust", "Amber", "Teal", "Blue", "Indigo", "Plum", "Rose"]);
  for (const radio of hues) expect(radio.className).toContain("rounded-md");
  expect(within(color).getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(within(color).getByRole("radio", { name: "Plum" }));
  expect(onSave.mock.lastCall![0]).toEqual({ ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, hue: "plum" } } });
});

const tile = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name: new RegExp(`^${name}`) });

it("says what each tool needs before it can be added", async () => {
  bridgeMock.detectAgentTools.mockResolvedValueOnce({
    workingDirectory: "C:\\Work",
    tools: [
      { tool: "claude", executable: "C:\\Tools\\claude.exe", version: "2.1.300", auth: "signed-out", probe: "detected" },
      { tool: "codex", executable: null, version: null, auth: "unknown", probe: "not-found" },
    ],
  });
  renderList();
  expect(within(tile("Add Claude Code")).getByLabelText("Looking for Claude Code")).toBeTruthy();
  await within(tile("Add Claude Code")).findByText("Sign in first");
  expect(tile("Add Claude Code").disabled).toBe(true);
  expect(within(tile("Add Codex")).getByText("Not found")).toBeTruthy();
  expect(tile("Add Codex").disabled).toBe(true);
  expect(within(tile("Add one you run")).getByText("Through MCP")).toBeTruthy();
  expect(screen.getByText("Runs on this computer. Turn an agent on for one computer per workspace.")).toBeTruthy();
});

it("adds a tool that is ready, on, with an id and name of its own, then checks it", async () => {
  const { onSave } = renderList();
  await within(tile("Add Codex")).findByText("Ready");
  await userEvent.click(tile("Add Codex"));
  const agents = onSave.mock.calls[0]![0].agents;
  expect(Object.keys(agents)).toEqual(["default", "codex", "terminal", "codex-2"]);
  expect(agents["codex-2"]).toMatchObject({
    name: "Codex 2", launch: { tool: "codex", executable: "C:\\Tools\\codex.exe" }, enabled: true, timeoutMinutes: 30,
  });
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex-2" });
});

it("gives the first agent you add the default id", async () => {
  const { onSave } = renderList({ settings: { ...SETTINGS, agents: {} } });
  await within(tile("Add Codex")).findByText("Ready");
  await userEvent.click(tile("Add Codex"));
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["default"]);
});

it("adds an agent you run, off, and opens it on its name", async () => {
  const { onSave, rerender } = renderList();
  await userEvent.click(tile("Add one you run"));
  const saved = onSave.mock.calls[0]![0];
  expect(saved.agents.agent).toEqual({ name: "Agent", hue: expect.any(String), changesFiles: true, enabled: false, timeoutMinutes: 30 });
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
  rerender({ settings: saved });
  expect(screen.getByRole("textbox", { name: "Name of Agent" })).toBeTruthy();
});

it("says on each tile that dohc couldn't look for tools, and looks again from the toast", async () => {
  bridgeMock.detectAgentTools.mockRejectedValueOnce(new Error("probe failed"));
  const { onError } = renderList();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("probe failed", expect.any(Error), expect.any(Function)));
  for (const name of ["Add Claude Code", "Add Codex"]) {
    expect(within(tile(name)).queryByLabelText(/^Looking for/)).toBeNull();
    expect(within(tile(name)).getByText("Couldn't check")).toBeTruthy();
    expect(tile(name).disabled).toBe(true);
  }
  const retry = onError.mock.calls[0]![2] as () => Promise<void>;
  await act(() => retry());
  expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(2);
  expect(within(tile("Add Codex")).getByText("Ready")).toBeTruthy();
  expect(tile("Add Codex").disabled).toBe(false);
  expect(within(tile("Add Claude Code")).getByText("Not found")).toBeTruthy();
});

it("marks the agent automations wake, and moves another one there with Undo", async () => {
  const { onOrder, onNotice } = renderList({ agentProblems: [BROKEN] });
  expect(screen.getAllByTestId("agent-for-automations")).toHaveLength(1);
  expect(within(row("Claude Code")).getByTestId("agent-for-automations").textContent).toBe("For automations");
  // Not on the agent automations already wake, nor on one dohc cannot start.
  for (const name of ["Claude Code", "Claude in Terminal"]) {
    await userEvent.click(screen.getByRole("button", { name: `${name} actions` }));
    expect(screen.queryByRole("menuitem", { name: "Use for automations" })).toBeNull();
    await userEvent.keyboard("{Escape}");
  }
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  expect(screen.getAllByRole("menuitem")[0]!.textContent).toBe("Use for automations");
  await userEvent.click(screen.getByRole("menuitem", { name: "Use for automations" }));
  expect(onOrder).toHaveBeenCalledWith(["codex"]);
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Automations now wake Codex.", expect.any(Function)));
  const { default: claude, codex, terminal } = SETTINGS.agents;
  bridgeMock.getUserSettings.mockResolvedValueOnce({
    settings: { ...SETTINGS, agents: { codex: codex!, default: claude!, terminal: terminal! } }, source: "stored",
    agentProblems: [{ ...BROKEN, position: 2 }],
  });
  onNotice.mock.calls[0]![1]!();
  // Undo puts Codex back after the broken entry it followed.
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["default", "codex-two", "codex", "terminal"], "dohc could not move Codex back."));
});

// The order since the choice stays: Undo moves only the agent it chose.
it("keeps a later automations choice when an earlier one is undone", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const gemini = testAgent({ name: "Gemini", hue: "teal" });
  const { onOrder, onNotice, rerender } = renderList({ settings: { ...SETTINGS, agents: { default: claude, codex, gemini } } });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Use for automations" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Automations now wake Codex.", expect.any(Function)));
  rerender({ settings: { ...SETTINGS, agents: { codex, default: claude, gemini } } });
  await userEvent.click(screen.getByRole("button", { name: "Gemini actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Use for automations" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Automations now wake Gemini.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini, codex, default: claude } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  // Gemini still wakes automations; Codex goes back after Claude Code.
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "default", "codex"], "dohc could not move Codex back."));

  // Claude Code, which Codex followed, was then removed. Codex goes after
  // Gemini rather than in front of it.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini, codex } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "codex"], "dohc could not move Codex back."));
});

it("shows no automations chip while only one agent can be started", () => {
  renderList({ settings: { ...SETTINGS, agents: { default: SETTINGS.agents.default!, terminal: mcpOnly } } });
  expect(screen.queryByTestId("agent-for-automations")).toBeNull();
});

// The order since Remove stays: Undo moves only the agent it puts back.
it("puts a removed agent back after the one it followed, in the order the file has then", async () => {
  const { onOrder, onNotice } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude in Terminal.", expect.any(Function)));
  // Codex was then chosen for automations, so the file starts with it.
  const { default: claude, codex } = SETTINGS.agents;
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { codex: codex!, default: claude! } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledWith(["codex", "terminal", "default"], "dohc brought back Claude in Terminal but could not put it back in its place."));
  expect(Object.keys(bridgeMock.setUserSettings.mock.lastCall![0].settings.agents)).toEqual(["codex", "default", "terminal"]);

  // With both its neighbours gone, it goes behind the agent automations
  // wake, since it wasn't first.
  cleanup();
  const second = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(second.onNotice).toHaveBeenCalled());
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { default: claude! } }, source: "stored" });
  second.onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(second.onOrder).toHaveBeenCalledWith(["default", "terminal"], expect.any(String)));
});

it("puts a removed first agent back in front of the one after it, so a later automations choice stays", async () => {
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const claude = testAgent({ name: "Claude Code" });
  const gemini = testAgent({ name: "Gemini", hue: "teal" });
  const { onOrder, onNotice } = renderList({ settings: { ...SETTINGS, agents: { codex, default: claude, gemini } } });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  // Gemini was then chosen for automations.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini, default: claude } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "codex", "default"], expect.any(String)));

  // With Claude Code removed too, Codex goes behind Gemini, which was
  // chosen after the Remove, rather than first.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "codex"], expect.any(String)));
});

it("gives automations back to the agent that woke them when its Remove is undone at once", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  // Claude in Terminal has no launch, so Claude Code wakes automations.
  const first = renderList({ settings: { ...SETTINGS, agents: { terminal: mcpOnly, default: claude, codex } } });
  await userEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(first.onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { terminal: mcpOnly, codex } }, source: "stored" });
  first.onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(first.onOrder).toHaveBeenLastCalledWith(["terminal", "default", "codex"], expect.any(String)));

  // The same behind an entry dohc can't use.
  cleanup();
  // Main's answer to the save keeps the entry dohc can't use.
  const second = renderList({
    settings: { ...SETTINGS, agents: { default: claude, codex } }, agentProblems: [{ ...BROKEN, position: 0 }],
    onSave: async (settings) => ({ settings, source: "stored", agentProblems: [{ ...BROKEN, position: 0 }] }),
  });
  await userEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(second.onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { codex } }, source: "stored", agentProblems: [{ ...BROKEN, position: 0 }] });
  second.onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(second.onOrder).toHaveBeenLastCalledWith(["codex-two", "default", "codex"], expect.any(String)));
});

it("puts an agent dohc can't start back above the automations agent when its Remove is undone at once", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const { onOrder, onNotice } = renderList({ settings: { ...SETTINGS, agents: { terminal: mcpOnly, default: claude, codex } } });
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude in Terminal.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { default: claude, codex } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["terminal", "default", "codex"], expect.any(String)));
});

// Undo works from the file: an order the same as right after the Remove is
// an exact reversal, even if agents were chosen in between.
it("undoes a Remove exactly when the file is back in the order the Remove left", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const gemini = testAgent({ name: "Gemini", hue: "teal" });
  const { onOrder, onNotice } = renderList({ settings: { ...SETTINGS, agents: { default: claude, codex, gemini } } });
  await userEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  // Gemini, then Codex, were chosen for automations.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { codex, gemini } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["default", "codex", "gemini"], expect.any(String)));
});

it.each([
  ["Claude Code's, then Codex's", [1, 0], [["gemini"], ["default", "gemini"]], [["default", "gemini"], ["codex", "default", "gemini"]]],
  ["Codex's, then Claude Code's", [0, 1], [["gemini"], ["gemini", "codex"]], [["gemini", "codex"], ["gemini", "default", "codex"]]],
] as const)("undoes two Removes, %s, and leaves automations with the agent that held them", async (_case, undos, files, orders) => {
  const agents = { codex: testAgent({ name: "Codex", hue: "blue" }), default: testAgent({ name: "Claude Code" }), gemini: testAgent({ name: "Gemini", hue: "teal" }) };
  const { onOrder, onNotice, rerender } = renderList({ settings: { ...SETTINGS, agents } });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  const { codex: _codex, ...afterCodex } = agents;
  rerender({ settings: { ...SETTINGS, agents: afterCodex } });
  await userEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  for (const [step, undo] of undos.entries()) {
    const file = Object.fromEntries(files[step]!.map((id) => [id, agents[id]]));
    bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: file }, source: "stored" });
    onNotice.mock.calls[undo]![1]!();
    await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(orders[step], expect.any(String)));
  }
});

it("doesn't let Undo of a Remove take automations from the agent chosen since", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const gemini = testAgent({ name: "Gemini", hue: "teal" });
  const { onOrder, onNotice } = renderList({ settings: { ...SETTINGS, agents: { default: claude, codex, gemini } } });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  // Gemini was then chosen for automations, and Claude Code removed.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "codex"], expect.any(String)));
});

it("removes an agent, and Undo puts it back where it was", async () => {
  const { onSave, onOrder, onNotice } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  const saved = onSave.mock.calls[0]![0];
  expect(Object.keys(saved.agents)).toEqual(["default", "terminal"]);
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: saved, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledWith(["default", "codex", "terminal"], expect.any(String)));
  expect(onSave).toHaveBeenCalledOnce();
  // Saved from the file Undo read, so main refuses it if Codex came back since.
  expect(bridgeMock.setUserSettings).toHaveBeenCalledWith({ settings: { ...saved, agents: { ...saved.agents, codex: SETTINGS.agents.codex } }, base: saved });
});

it("says the agent stays when the saved file still lists it", async () => {
  const { onSave, onNotice, onError } = renderList();
  // Another window put Codex back before main saved the removal.
  onSave.mockResolvedValueOnce({ settings: SETTINGS, source: "stored" });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dohc didn't remove Codex because the settings file still lists it."));
  // Or as an entry dohc can't use.
  const { codex: _codex, ...rest } = SETTINGS.agents;
  onSave.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: rest }, source: "stored", agentProblems: [{ ...BROKEN, id: "codex" }] });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  expect(onNotice).not.toHaveBeenCalled();
});

it("leaves an agent that came back after Undo read the file", async () => {
  const { onSave, onOrder, onNotice, onError } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: onSave.mock.calls[0]![0], source: "stored" });
  bridgeMock.setUserSettings.mockRejectedValueOnce(new Error(
    "Error invoking remote method 'desktop:set-user-settings': AgentIdTakenError: dohc didn't add Codex because the settings file changed at the same time.",
  ));
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Undo didn't replace the new Codex, so the one you removed stays removed."));
  expect(onOrder).not.toHaveBeenCalled();
});

const trust = (trusted: boolean | null) => ({ trusted, asking: false, onTrust: vi.fn() });
const checkButton = (name: string) => within(row(name)).getByRole<HTMLButtonElement>("button", { name: /^(Check|Try again)$/ });

it("holds Check back in Restricted Mode with the band's words, and adds an agent without checking it", async () => {
  const restricted = trust(false);
  const { onSave, onError } = renderList({ trust: restricted });
  const band = screen.getByTestId("restricted-agents-state");
  expect(band.textContent).toContain(AGENTS_RESTRICTED_MESSAGE);
  // The band is the card's top strip.
  expect(band.parentElement!.parentElement!.firstElementChild).toBe(band.parentElement);
  expect(checkButton("Codex").disabled).toBe(true);
  expect(checkButton("Codex").title).toBe(AGENTS_RESTRICTED_MESSAGE);
  expect(screen.queryByTestId("agents-check-note")).toBeNull();
  await userEvent.click(within(band).getByRole("button", { name: "Trust workspace" }));
  expect(restricted.onTrust).toHaveBeenCalledOnce();

  await within(tile("Add Codex")).findByText("Ready");
  await userEvent.click(tile("Add Codex"));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toContain("codex-2");
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByText("Didn't reply.")).toBeNull();
  // The switch still works.
  await userEvent.click(within(row("Codex")).getByRole("switch", { name: "Turn on Codex" }));
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("says Restricted Mode holds the check back when an old toast's Try again comes while restricted", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Runner exited before reporting self-test success." });
  const { onError, rerender } = renderList({ trust: trust(true) });
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  rerender({ trust: trust(false) });
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", AGENTS_RESTRICTED_MESSAGE],
  ], "agent-check:ws-1:codex");
});

it("turns Check on once the workspace is trusted, without checking", () => {
  const { rerender } = renderList({ trust: trust(false) });
  rerender({ trust: trust(true) });
  expect(screen.queryByTestId("restricted-agents-state")).toBeNull();
  expect(checkButton("Codex").disabled).toBe(false);
  expect(checkButton("Codex").title).toBe("");
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("holds nothing back while trust is still being read, and Add's passing check takes back the agent's row", async () => {
  const onClearError = vi.fn();
  renderList({ trust: trust(null), onClearError });
  expect(screen.queryByTestId("restricted-agents-state")).toBeNull();
  expect(checkButton("Codex").disabled).toBe(false);
  await within(tile("Add Codex")).findByText("Ready");
  await userEvent.click(tile("Add Codex"));
  await vi.waitFor(() => expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex-2" }));
  await vi.waitFor(() => expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex-2"));
});

it("takes back only that agent's failed check when its check passes, from the row or the toast", async () => {
  bridgeMock.runnerSelfTest
    .mockResolvedValueOnce({ ok: false, detail: "Claude Code timed out." })
    .mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const onClearError = vi.fn();
  const { onError } = renderList({ onClearError });
  await userEvent.click(checkButton("Claude Code"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  expect(onError.mock.calls.map((call) => call[4])).toEqual(["agent-check:ws-1:default", "agent-check:ws-1:codex"]);
  expect(onClearError).not.toHaveBeenCalled();

  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onClearError).toHaveBeenCalledWith("agent-check:ws-1:codex"));
  expect(onClearError).not.toHaveBeenCalledWith("agent-check:ws-1:default");

  // Try again on Claude Code's toast passes, and takes back its own row.
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(onClearError).toHaveBeenLastCalledWith("agent-check:ws-1:default");
  expect(onClearError).toHaveBeenCalledTimes(2);
});

it("takes back a removed agent's failed check, and Undo doesn't bring it back", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const onClearError = vi.fn();
  const { onSave, onError, onNotice, onOrder } = renderList({ onClearError });
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: onSave.mock.calls[0]![0], source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledOnce();
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
});

// Fix P: focus after the card's Trust workspace.
const trustButton = () => within(screen.getByTestId("restricted-agents-state")).getByRole("button", { name: "Trust workspace" });

async function pressTrust(fields: Partial<Parameters<typeof AgentList>[0]> = {}) {
  const onTrust = vi.fn();
  const list = renderList({ trust: { trusted: false, asking: false, onTrust }, ...fields });
  await userEvent.click(trustButton());
  expect(onTrust).toHaveBeenCalledOnce();
  // Main's dialog is open, and the band's button is off. Chromium then
  // moves focus to the body; jsdom keeps it on a disabled button.
  act(() => trustButton().blur());
  list.rerender({ trust: { trusted: false, asking: true, onTrust } });
  return { ...list, onTrust };
}

it("moves focus to the first agent's Check when the card's Trust workspace trusts the workspace", async () => {
  const { rerender, onTrust } = await pressTrust();
  rerender({ trust: { trusted: true, asking: false, onTrust } });
  expect(document.activeElement).toBe(checkButton("Claude Code"));
});

it("moves focus to the first Add tile it can when there are no agents", async () => {
  const empty = { ...SETTINGS, agents: {} };
  const { rerender, onTrust } = await pressTrust({ settings: empty });
  await within(tile("Add Codex")).findByText("Ready");
  rerender({ trust: { trusted: true, asking: false, onTrust } });
  expect(document.activeElement).toBe(tile("Add Codex"));
});

it("puts focus back on Trust workspace when the person cancels main's dialog", async () => {
  const { rerender, onTrust } = await pressTrust();
  expect(document.activeElement).toBe(document.body);
  rerender({ trust: { trusted: false, asking: false, onTrust } });
  expect(document.activeElement).toBe(trustButton());
});

it("leaves focus alone when trust comes from somewhere else, or the person moved on", async () => {
  const { rerender } = renderList({ trust: trust(false) });
  rerender({ trust: trust(true) });
  expect(document.activeElement).toBe(document.body);

  cleanup();
  const pressed = await pressTrust();
  const toggle = within(row("Codex")).getByRole("switch", { name: "Turn on Codex" });
  act(() => toggle.focus());
  pressed.rerender({ trust: { trusted: true, asking: false, onTrust: pressed.onTrust } });
  expect(document.activeElement).toBe(toggle);
});

// Fix P: a check that ends after the panel closes still reports.
it("takes back the notice, or files it, when a check ends after the panel closed", async () => {
  const first = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(first.promise);
  const onClearError = vi.fn();
  const passed = renderList({ onClearError });
  await userEvent.click(checkButton("Codex"));
  passed.unmount();
  await act(async () => first.resolve({ ok: true, detail: "ok" }));
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");

  const second = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(second.promise);
  const failed = renderList();
  await userEvent.click(checkButton("Codex"));
  failed.unmount();
  await act(async () => second.resolve({ ok: false, detail: "Codex timed out." }));
  await vi.waitFor(() => expect(failed.onError).toHaveBeenCalledWith("Codex didn't reply to the check.", undefined, expect.any(Function), [
    ["Cause", "Codex timed out."],
  ], "agent-check:ws-1:codex"));
});

// Fix P: Remove during a check.
it("files no notice for a check that fails after its agent was removed", async () => {
  const answer = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(answer.promise);
  const onClearError = vi.fn();
  const { onSave, onError, onNotice } = renderList({ onClearError });
  await userEvent.click(checkButton("Codex"));
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: onSave.mock.calls[0]![0], source: "stored" });
  await act(async () => answer.resolve({ ok: false, detail: "Configure a runner command first." }));
  await vi.waitFor(() => expect(bridgeMock.getUserSettings).toHaveBeenCalledOnce());
  await act(async () => undefined);
  expect(onError).not.toHaveBeenCalled();
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");
});

it("files no notice when the agent was removed in a later panel, and files it when the file can't be read", async () => {
  const answer = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(answer.promise);
  const first = renderList();
  await userEvent.click(checkButton("Codex"));
  first.unmount();
  const { codex: _codex, ...rest } = SETTINGS.agents;
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: rest }, source: "stored" });
  await act(async () => answer.resolve({ ok: false, detail: "Configure a runner command first." }));
  await vi.waitFor(() => expect(bridgeMock.getUserSettings).toHaveBeenCalledOnce());
  await act(async () => undefined);
  expect(first.onError).not.toHaveBeenCalled();

  // Guard: an unreadable file still reports.
  bridgeMock.runnerSelfTest.mockRejectedValueOnce(new Error(""));
  bridgeMock.getUserSettings.mockRejectedValueOnce(new Error("busy"));
  const second = renderList();
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(second.onError).toHaveBeenCalledWith(
    "dohc could not check Codex.", expect.any(Error), expect.any(Function), undefined, "agent-check:ws-1:codex"));
});

it("files a failed check when the file reads back recovered, or lists the agent as an entry dohc can't use", async () => {
  const { codex, ...rest } = SETTINGS.agents;
  bridgeMock.runnerSelfTest
    .mockResolvedValueOnce({ ok: false, detail: "Codex timed out." })
    .mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: rest }, source: "recovered" });
  const { onError } = renderList();
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

  bridgeMock.getUserSettings.mockResolvedValueOnce({
    settings: { ...SETTINGS, agents: rest }, source: "stored", agentProblems: [{ ...BROKEN, id: "codex", name: codex!.name }],
  });
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
});

// Fix P: a Try again kept after the panel closed.
it("asks main whether the workspace is restricted when a closed panel's Try again runs", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const { onError, unmount } = renderList({ trust: trust(true) });
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  unmount();
  bridgeMock.readWorkspaceTrust.mockResolvedValueOnce({ workspaceId: "ws-1", trusted: false });
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", AGENTS_RESTRICTED_MESSAGE],
  ], "agent-check:ws-1:codex");
});

it("checks from a closed panel's Try again once the workspace was trusted elsewhere", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const onClearError = vi.fn();
  const { onError, unmount, rerender } = renderList({ trust: trust(true), onClearError });
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  // The panel last saw Restricted Mode, then closed; the workspace was trusted elsewhere.
  rerender({ trust: trust(false), onClearError });
  unmount();
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");
});

it("asks main whether agents are paused when a closed panel's Try again runs", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const { onError, unmount } = renderList();
  await userEvent.click(checkButton("Codex"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  unmount();
  bridgeMock.readChatDispatchPaused.mockResolvedValueOnce({ paused: true });
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", "Agents are paused. Resume them, then try again."],
  ], "agent-check:ws-1:codex");
});

it("starts one check for a double click, without asking main first", async () => {
  const answer = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(answer.promise);
  renderList();
  await userEvent.dblClick(checkButton("Codex"));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(bridgeMock.readWorkspaceTrust).not.toHaveBeenCalled();
  await act(async () => answer.resolve({ ok: true, detail: "ok" }));
});
