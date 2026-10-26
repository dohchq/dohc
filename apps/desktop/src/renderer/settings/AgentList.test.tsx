// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ChatDispatchPausedEvent, RunnerSelfTestResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type AgentProblem, type DesktopUserSettings, type DesktopUserSettingsResult } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList, agentListRows } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
const bridgeMock = {
  getUserSettings: vi.fn(async (): Promise<DesktopUserSettingsResult> => ({ settings: DEFAULT_USER_SETTINGS, source: "stored" })),
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
  const { rerender } = render(list());
  return { onSave, onOrder, onNotice, onError, onOpenSettingsFile, rerender: (more: Partial<Parameters<typeof AgentList>[0]>) => rerender(list(more)) };
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
  ]);
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
  ]);
  await act(async () => running.resolve({ ok: true, detail: "self-test ok" }));
  act(() => pausedListener?.({ paused: true }));
  await act(() => retry());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", "Agents are paused. Resume them, then try again."],
  ]);
});

it("checks again from the toast when the check couldn't start", async () => {
  bridgeMock.runnerSelfTest.mockRejectedValueOnce(new Error(""));
  const { onError } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not check Codex.", expect.any(Error), expect.any(Function)));
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
  const second = renderList({ settings: { ...SETTINGS, agents: { default: claude, codex } }, agentProblems: [{ ...BROKEN, position: 0 }] });
  await userEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(second.onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { codex } }, source: "stored", agentProblems: [{ ...BROKEN, position: 0 }] });
  second.onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(second.onOrder).toHaveBeenLastCalledWith(["codex-two", "default", "codex"], expect.any(String)));
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
