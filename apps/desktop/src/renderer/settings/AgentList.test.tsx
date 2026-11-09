// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENTS_RESTRICTED_MESSAGE, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { AgentsListeningEvent, ChatDispatchPausedEvent, RunnerSelfTestResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type AgentProblem, type DesktopUserSettings, type DesktopUserSettingsResult } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList, agentListRows } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
let listeningListener: ((event: AgentsListeningEvent) => void) | null = null;
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
  readAgentsListening: vi.fn(async (_payload: Record<string, never>): Promise<AgentsListeningEvent> => ({ agentIds: [] })),
  onAgentsListening: vi.fn((listener: (event: AgentsListeningEvent) => void) => {
    listeningListener = listener;
    return () => { listeningListener = null; };
  }),
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
  listeningListener = null;
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
  expect(claude.getByRole("switch", { name: "Claude Code" }).getAttribute("aria-checked")).toBe("true");
  expect(claude.getByRole("button", { name: "Claude Code actions" })).toBeTruthy();
  const terminal = within(row("Claude in Terminal"));
  expect(terminal.getByText("Through MCP")).toBeTruthy();
  expect(terminal.queryByRole("button", { name: "Check" })).toBeNull();
  expect(terminal.queryByRole("switch")).toBeNull();
  expect(terminal.getByRole("button", { name: "Claude in Terminal actions" })).toBeTruthy();
});

it("says under each name what starts the agent and where it stands", () => {
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  renderList({ settings: codexOff });
  const state = (agent: string) => within(row(agent)).getByTestId("agent-state").textContent;
  expect(state("Claude Code")).toBe("Your command·Not checked");
  // Off says only its tool; the switch shows it off.
  expect(state("Codex")).toBe("Codex");
  expect(state("Claude in Terminal")).toBe("Through MCP");
});

it("names an agent's switch by the agent, says what a click does, and dims a row that's off", () => {
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  const { rerender } = renderList({ settings: codexOff });
  const on = within(row("Claude Code")).getByRole("switch", { name: "Claude Code" });
  expect(on.getAttribute("aria-checked")).toBe("true");
  expect(on.title).toBe("Turn off Claude Code");
  // Read after the name, so it leaves the name out.
  expect(on.getAttribute("aria-description")).toBe("Turn off");
  const off = within(row("Codex")).getByRole("switch", { name: "Codex" });
  expect(off.getAttribute("aria-checked")).toBe("false");
  expect(off.title).toBe("Turn on Codex");
  expect(off.getAttribute("aria-description")).toBe("Turn on");
  // The off row's name and mark go muted; the on row keeps its ink.
  const name = (agent: string) => within(row(agent)).getByRole("button", { name: `Rename ${agent}` });
  const mark = (agent: string) => row(agent).querySelector(`span[title="${agent}"]`)!;
  expect(name("Codex").className).toContain("text-muted");
  expect(name("Codex").className).not.toContain("text-ink");
  expect(mark("Codex").getAttribute("class")).toContain("opacity-50");
  expect(name("Claude Code").className).toContain("text-ink");
  expect(mark("Claude Code").getAttribute("class")).not.toContain("opacity-50");

  rerender({ settings: SETTINGS });
  const turnedOn = within(row("Codex")).getByRole("switch", { name: "Codex" });
  expect(turnedOn.getAttribute("aria-checked")).toBe("true");
  expect(turnedOn.title).toBe("Turn off Codex");
  expect(name("Codex").className).toContain("text-ink");
  expect(mark("Codex").getAttribute("class")).not.toContain("opacity-50");
});

it("keeps an entry dohc could not use in its place, with its problem and a way to the file", async () => {
  const { onOpenSettingsFile } = renderList({
    agentProblems: [BROKEN, { id: "Agent B", position: 4, problem: "dohc doesn't use `color`." }],
  });
  const rows = screen.getAllByTestId(/^agent-row/);
  // An entry dohc could not use stays among the agents dohc starts.
  expect(rows.map((element) => element.dataset.agentId)).toEqual(["default", "codex-two", "codex", "Agent B", "terminal"]);
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
  const nameless = within(rows[3]!);
  expect(nameless.getByText("Agent B")).toBeTruthy();
  expect(nameless.getByText("color").tagName).toBe("CODE");
});

it("checks one agent, then says how long its reply took", async () => {
  const answer = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(answer.promise);
  const { rerender } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex" });
  expect(within(row("Codex")).getByText("Checking")).toBeTruthy();
  // Main runs one runner per workspace, so the other Check waits.
  expect((within(row("Claude Code")).getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => answer.resolve({ ok: true, detail: "Runner self-test passed." }));
  expect(within(row("Codex")).getByText(/^Replied in \d+ s$/)).toBeTruthy();
  // While agents are paused, an agent that is off keeps the check it ran,
  // and one that is on says Paused.
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  rerender({ settings: codexOff });
  act(() => pausedListener?.({ paused: true }));
  expect(within(row("Codex")).getByTestId("agent-state").textContent).toMatch(/^Codex·Replied in \d+ s$/);
  expect(within(row("Claude Code")).getByTestId("agent-state").textContent).toBe("Your command·Paused");
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

it("says an agent replied as Agent when its reply wasn't the check's", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({
    ok: false, unconfirmed: true, detail: "Codex's Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in Codex's details.", logPath: "C:\\Logs\\check.log",
  });
  const { onError } = renderList();
  await userEvent.click(within(row("Codex")).getByRole("button", { name: "Check" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledWith("Codex replied as Agent.", undefined, expect.any(Function), [
    ["Cause", "Codex's Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in Codex's details."],
    ["Log", "C:\\Logs\\check.log"],
  ], "agent-check:ws-1:codex");
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

const ids = (testId: string) => within(screen.getByTestId(testId)).queryAllByTestId("agent-row").map((element) => element.dataset.agentId);

it("puts the agents dohc starts and the agents you run in sections of their own, with Pause all on the first", () => {
  renderList();
  const started = within(screen.getByTestId("agents-started"));
  const yours = within(screen.getByTestId("agents-yours"));
  expect(started.getByRole("heading", { name: "Started by dohc" })).toBeTruthy();
  expect(yours.getByRole("heading", { name: "You run on this computer" })).toBeTruthy();
  expect(ids("agents-started")).toEqual(["default", "codex"]);
  expect(ids("agents-yours")).toEqual(["terminal"]);
  expect(started.getByRole("button", { name: "Pause all" })).toBeTruthy();
  expect(yours.queryByRole("button", { name: "Pause all" })).toBeNull();
  // The Add tiles for tools stay with the agents dohc starts.
  expect(started.getByRole("button", { name: /^Add Codex/ })).toBeTruthy();
  expect(yours.queryByRole("button", { name: /^Add Codex/ })).toBeNull();
  // Each agent you run has its own Copy MCP config; the page has none of its own.
  expect(screen.getAllByRole("button", { name: "Copy MCP config" })).toHaveLength(1);
  expect(within(row("Claude in Terminal")).getByRole("button", { name: "Copy MCP config" })).toBeTruthy();
});

it("shows Pause all only while there is an agent dohc starts", () => {
  renderList({ settings: { ...SETTINGS, agents: { terminal: mcpOnly } } });
  expect(screen.queryByRole("button", { name: "Pause all" })).toBeNull();
  expect(ids("agents-yours")).toEqual(["terminal"]);
});

it("copies an MCP config that runs dohc's MCP server as the agent you run", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  renderList({ config: { command: "dohc-mcp", args: ["--workspace", "Trip", "--home", "Home"], workspacePath: "Trip", home: "Home" } });
  await user.click(within(row("Claude in Terminal")).getByRole("button", { name: "Copy MCP config" }));
  expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({
    mcpServers: { dohc: { command: "dohc-mcp", args: ["--workspace", "Trip", "--home", "Home", "--agent-id", "terminal"] } },
  });
  writeText.mockRestore();
});

it("can't copy an MCP config the workspace doesn't have, and says why", () => {
  renderList({ config: { unavailable: true, message: "dohc's MCP server isn't installed." } });
  expect((within(row("Claude in Terminal")).getByRole("button", { name: "Copy MCP config" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByTestId("agents-yours")).getByTestId("mcp-unavailable").textContent).toBe("dohc's MCP server isn't installed.");
});

it("says an agent you run is listening while it waits for messages, and Through MCP once the wait ends", async () => {
  bridgeMock.readAgentsListening.mockResolvedValueOnce({ agentIds: ["terminal"] });
  renderList();
  await vi.waitFor(() => expect(within(row("Claude in Terminal")).getByTestId("agent-state").textContent).toBe("Listening"));
  act(() => listeningListener?.({ agentIds: [] }));
  expect(within(row("Claude in Terminal")).getByTestId("agent-state").textContent).toBe("Through MCP");
  act(() => listeningListener?.({ agentIds: ["terminal"] }));
  expect(within(row("Claude in Terminal")).getByTestId("agent-state").textContent).toBe("Listening");
  // An agent dohc starts never reads as listening.
  act(() => listeningListener?.({ agentIds: ["terminal", "codex"] }));
  expect(within(row("Codex")).queryByText("Listening")).toBeNull();
});

it("takes a pushed answer over the first read of who is listening", async () => {
  const read = deferred<AgentsListeningEvent>();
  bridgeMock.readAgentsListening.mockReturnValueOnce(read.promise);
  renderList();
  act(() => listeningListener?.({ agentIds: [] }));
  await act(async () => read.resolve({ agentIds: ["terminal"] }));
  expect(within(row("Claude in Terminal")).getByTestId("agent-state").textContent).toBe("Through MCP");
});

it("adds an agent you run as Agent, then Agent 2, each off, in the next free color, with nothing to check", async () => {
  const teal = { ...SETTINGS, appearance: { ...SETTINGS.appearance, yourColor: "teal" as const } };
  const { onSave, rerender } = renderList({ settings: teal });
  await userEvent.click(screen.getByRole("button", { name: /^Add an agent you run/ }));
  const first = onSave.mock.calls[0]![0];
  expect(Object.keys(first.agents)).toEqual(["default", "codex", "terminal", "agent"]);
  // Olive, blue and rose are the agents', teal is yours, so plum is next.
  expect(first.agents.agent).toEqual({ name: "Agent", hue: "plum", changesFiles: true, enabled: false, timeoutMinutes: 30 });
  expect(first.agents.agent).not.toHaveProperty("launch");
  rerender({ settings: first });
  expect(ids("agents-yours")).toEqual(["terminal", "agent"]);
  expect(within(row("Agent")).getByTestId("agent-state").textContent).toBe("Through MCP");
  await userEvent.click(screen.getByRole("button", { name: /^Add an agent you run/ }));
  expect(onSave.mock.calls[1]![0].agents["agent-2"]).toMatchObject({ name: "Agent 2", hue: "rust", enabled: false });
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("gives an agent you run Rename, Details and Remove, and says in Details what it reaches", async () => {
  renderList();
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Details", "Remove"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
  const details = within(within(row("Claude in Terminal")).getByTestId("agent-details"));
  expect(details.getByText("Reaches every workspace dohc opens on this computer.")).toBeTruthy();
  expect(details.getByRole("radiogroup", { name: "Color of Claude in Terminal" })).toBeTruthy();
  expect(details.queryByText("Stops after")).toBeNull();
});

it("removes an agent you run, and Undo puts it back in its section", async () => {
  const { onSave, onNotice, onOrder } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude in Terminal.", expect.any(Function)));
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["default", "codex"]);
  const { default: claude, codex } = SETTINGS.agents;
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { default: claude!, codex: codex! } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledWith(["default", "codex", "terminal"], expect.any(String)));
  expect(bridgeMock.setUserSettings.mock.lastCall![0].settings.agents.terminal).toEqual(mcpOnly);
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

it("keeps a tool's profile when its command is saved as shown, and adds your own flags to it", async () => {
  const { onSave } = renderList();
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
  const details = within(row("Codex"));
  await userEvent.click(details.getByRole("button", { name: "Use your own command" }));
  const field = details.getByRole<HTMLInputElement>("textbox", { name: "Command that starts Codex" });
  expect(field.value).toBe("C:\\Tools\\codex.exe");
  expect(details.getByText("dohc adds its reply tool and sandbox. The conversation arrives through stdin. Flags you add apply only to runs you start, and can change what dohc adds.")).toBeTruthy();
  await userEvent.type(field, "x", { initialSelectionStart: field.value.length, initialSelectionEnd: field.value.length });
  expect(field.value).toBe("C:\\Tools\\codex.exex");
  expect(details.getByText("dohc runs this command as typed. The conversation arrives through stdin.")).toBeTruthy();
  await userEvent.keyboard("{Backspace}{Enter}");
  expect(onSave).not.toHaveBeenCalled();
  await userEvent.click(details.getByRole("button", { name: "Use your own command" }));
  const again = details.getByRole<HTMLInputElement>("textbox", { name: "Command that starts Codex" });
  await userEvent.type(again, " --model o3{Enter}", { initialSelectionStart: again.value.length, initialSelectionEnd: again.value.length });
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave.mock.calls[0]![0].agents.codex?.launch).toEqual({ tool: "codex", executable: "C:\\Tools\\codex.exe", arguments: ["--model", "o3"] });
});

it("shows a tool's program with your own flags as its command", async () => {
  renderList({ settings: { ...SETTINGS, agents: { ...SETTINGS.agents,
    codex: testAgent({ name: "Codex", hue: "blue", launch: { tool: "codex", executable: "C:\\Tools\\codex.exe", arguments: ["--model", "o3"] } }) } } });
  await userEvent.click(screen.getByRole("button", { name: "Codex actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
  const details = within(row("Codex"));
  expect(await details.findByText("Codex 0.98, signed in")).toBeTruthy();
  expect(details.getByText("C:\\Tools\\codex.exe --model o3")).toBeTruthy();
  expect(details.queryByText("Program")).toBeNull();
  expect(details.getByRole("button", { name: "Change the command that starts Codex" })).toBeTruthy();
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
      { tool: "claude", executable: "C:\\Tools\\claude.exe", version: "2.1.317", auth: "signed-out", probe: "detected" },
      { tool: "codex", executable: null, version: null, auth: "unknown", probe: "not-found" },
    ],
  });
  renderList();
  expect(within(tile("Add Claude Code")).getByLabelText("Looking for Claude Code")).toBeTruthy();
  await within(tile("Add Claude Code")).findByText("Sign in first");
  expect(tile("Add Claude Code").disabled).toBe(true);
  expect(within(tile("Add Codex")).getByText("Not found")).toBeTruthy();
  expect(tile("Add Codex").disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /^Add one you run/ })).toBeNull();
  expect(screen.getByText("Runs on this computer. Turn an agent on for one computer per workspace.")).toBeTruthy();
});

// Codex can run without a saved login, through CODEX_API_KEY or another model
// provider, so a sign-in dohc can't read still lets you add it.
it("says Codex is ready when dohc can't tell whether it is signed in", async () => {
  bridgeMock.detectAgentTools.mockResolvedValueOnce({
    workingDirectory: "C:\\Work",
    tools: [{ tool: "codex", executable: "C:\\Tools\\codex.exe", version: "0.98", auth: "unknown", probe: "detected" }],
  });
  renderList();
  await within(tile("Add Codex")).findByText("Ready");
  expect(tile("Add Codex").disabled).toBe(false);
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

it("never gives an agent you run the default id, which Chats sets up as one dohc starts", async () => {
  const { onSave } = renderList({ settings: { ...SETTINGS, agents: {} } });
  await userEvent.click(screen.getByRole("button", { name: /^Add an agent you run/ }));
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["agent"]);
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
  await userEvent.click(within(row("Codex")).getByRole("switch", { name: "Codex" }));
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

it("moves focus to the Agents heading when trust turns on nothing", async () => {
  bridgeMock.detectAgentTools.mockResolvedValueOnce({ workingDirectory: "C:\\Work", tools: [] });
  const { rerender, onTrust } = await pressTrust({ settings: { ...SETTINGS, agents: {} } });
  await within(tile("Add Codex")).findByText("Not found");
  rerender({ trust: { trusted: true, asking: false, onTrust } });
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
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
  const toggle = within(row("Codex")).getByRole("switch", { name: "Codex" });
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
