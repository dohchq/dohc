// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENTS_RESTRICTED_MESSAGE, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type {
  AgentsListeningEvent,
  ChatDispatchPausedEvent,
  PersonalAgent,
  PersonalAgentChange,
  PersonalAgentChangeResult,
  PersonalAgentsAccount,
  PersonalAgentsEvent,
  RunnerSelfTestResult,
} from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type AgentProblem, type DesktopUserSettings, type DesktopUserSettingsResult } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList, agentListRows } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
let listeningListener: ((event: AgentsListeningEvent) => void) | null = null;
let personalListener: ((event: PersonalAgentsEvent) => void) | null = null;
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
  readPersonalAgents: vi.fn(async (_payload: { refresh: boolean }): Promise<PersonalAgentsEvent> => ({ accounts: [] })),
  onPersonalAgents: vi.fn((listener: (event: PersonalAgentsEvent) => void) => {
    personalListener = listener;
    return () => { personalListener = null; };
  }),
  changePersonalAgent: vi.fn(async (_payload: { accountKey: string; agentId: string; change: PersonalAgentChange }): Promise<PersonalAgentChangeResult> => (
    { ok: true, personalAgents: { accounts: [] } })),
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
  personalListener = null;
});
afterEach(cleanup);

function renderList(fields: Partial<Parameters<typeof AgentList>[0]> = {}) {
  const onSave = vi.fn(async (settings: DesktopUserSettings): Promise<DesktopUserSettingsResult | null> => ({ settings, source: "stored" }));
  const onError = vi.fn();
  const onOpenSettingsFile = vi.fn();
  const onOrder = vi.fn(async (_order: readonly string[]) => true);
  const onNotice = vi.fn((_message: string, _undo?: () => void) => undefined);
  const list = (more: Partial<Parameters<typeof AgentList>[0]> = {}) => (
    <AgentList workspaceId="ws-1" workspaceName="Trip" settings={SETTINGS} config={null} sessionRecorderOn
      onSave={onSave} onOrder={onOrder} onError={onError} onNotice={onNotice} onOpenSettingsFile={onOpenSettingsFile} {...fields} {...more} />
  );
  const { rerender, unmount } = render(list());
  return { onSave, onOrder, onNotice, onError, onOpenSettingsFile, unmount, rerender:(more: Partial<Parameters<typeof AgentList>[0]>) => rerender(list(more)) };
}

// The list's row for an agent, which opens its page.
const row = (name: string) => {
  const found = screen.queryAllByTestId("agent-row").find((element) => element.getAttribute("aria-label") === name);
  if (!found) throw new Error(`No row for ${name}`);
  return found;
};
const page = () => within(screen.getByTestId("agent-page"));
const state = (name: string) => within(row(name)).getByTestId("agent-state").textContent;

// Opens an agent's page from the list, going back first from another agent's page.
async function openAgent(name: string) {
  const open = screen.queryByTestId("agent-page");
  if (open?.getAttribute("aria-label") === name) return page();
  if (open) await userEvent.click(screen.getByTestId("agent-back"));
  await userEvent.click(row(name));
  return page();
}
async function back() {
  await userEvent.click(screen.getByTestId("agent-back"));
}
async function chooseAction(name: string, action: string) {
  await openAgent(name);
  await userEvent.click(screen.getByRole("button", { name: `${name} actions` }));
  await userEvent.click(screen.getByRole("menuitem", { name: action }));
}
const checkButton = () => page().getByRole<HTMLButtonElement>("button", { name: /^(Send test|Try again)$/ });
async function check(name: string) {
  await openAgent(name);
  await userEvent.click(checkButton());
}

const sheet = () => within(screen.getByTestId("agent-add-sheet"));
const runsWith = (id: "claude" | "codex" | "mcp" | "link") => screen.getByTestId<HTMLButtonElement>(`agent-runs-with-${id}`);
async function openAdd() {
  await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
  return sheet();
}
async function addAgent(id: "codex" | "mcp") {
  await openAdd();
  if (id === "codex") await within(runsWith("codex")).findByText("Ready");
  await userEvent.click(runsWith(id));
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
}

it("lists the entries dohc could not use in the file's order", () => {
  expect(agentListRows(SETTINGS, [{ ...BROKEN, position: 0 }, { ...BROKEN, id: "last", position: 4 }])
    .map((entry) => entry.kind === "agent" ? entry.agent.id : entry.problem.id))
    .toEqual(["codex-two", "default", "codex", "terminal", "last"]);
});

it("lists every agent as a row that opens its page, and back returns to its row", async () => {
  renderList();
  expect(screen.getAllByTestId("agent-row").map((element) => element.dataset.agentId)).toEqual(["default", "codex", "terminal"]);
  // The list has no per-agent controls; each lives on the agent's page.
  expect(screen.queryByTestId("agent-check")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  const claude = await openAgent("Claude Code");
  expect(document.activeElement).toBe(screen.getByTestId("agent-back"));
  expect(claude.getByRole("button", { name: "Send test" })).toBeTruthy();
  expect(claude.getByRole("switch", { name: "Run Claude Code on this computer" }).getAttribute("aria-checked")).toBe("true");
  expect(claude.getByRole("button", { name: "Claude Code actions" })).toBeTruthy();
  expect(screen.queryByTestId("agent-row")).toBeNull();
  await back();
  expect(document.activeElement).toBe(row("Claude Code"));
  const terminal = await openAgent("Claude in Terminal");
  expect(terminal.getByText("Through MCP")).toBeTruthy();
  expect(terminal.queryByRole("button", { name: "Send test" })).toBeNull();
  expect(terminal.queryByRole("switch")).toBeNull();
  expect(terminal.getByRole("button", { name: "Copy MCP config" })).toBeTruthy();
});

it("says under each name what starts the agent and where it stands", () => {
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  renderList({ settings: codexOff });
  expect(state("Claude Code")).toBe("Your command·On");
  expect(state("Codex")).toBe("Codex·Off");
  expect(state("Claude in Terminal")).toBe("Through MCP");
});

it("names an agent's switch by the agent, says what a click does, and dims a row that's off", async () => {
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  const { rerender } = renderList({ settings: codexOff });
  // The off row's name and mark go muted; the on row keeps its ink.
  const name = (agent: string) => within(row(agent)).getAllByText(agent)[0]!;
  const mark = (agent: string) => row(agent).querySelector(`span[title="${agent}"]`)!;
  expect(name("Codex").className).toContain("text-muted");
  expect(name("Codex").className).not.toContain("text-ink");
  expect(mark("Codex").getAttribute("class")).toContain("opacity-50");
  expect(name("Claude Code").className).toContain("text-ink");
  expect(mark("Claude Code").getAttribute("class")).not.toContain("opacity-50");

  const on = (await openAgent("Claude Code")).getByRole("switch", { name: "Run Claude Code on this computer" });
  expect(on.getAttribute("aria-checked")).toBe("true");
  expect(on.title).toBe("Turn off Claude Code");
  // Read after the name, so it leaves the name out.
  expect(on.getAttribute("aria-description")).toBe("Turn off");
  const off = (await openAgent("Codex")).getByRole("switch", { name: "Run Codex on this computer" });
  expect(off.getAttribute("aria-checked")).toBe("false");
  expect(off.title).toBe("Turn on Codex");
  expect(off.getAttribute("aria-description")).toBe("Turn on");

  rerender({ settings: SETTINGS });
  const turnedOn = page().getByRole("switch", { name: "Run Codex on this computer" });
  expect(turnedOn.getAttribute("aria-checked")).toBe("true");
  expect(turnedOn.title).toBe("Turn off Codex");
  await back();
  expect(name("Codex").className).toContain("text-ink");
  expect(mark("Codex").getAttribute("class")).not.toContain("opacity-50");
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
  // It has no page to open, nothing to switch and nothing to remove.
  expect(rows[1]!.tagName).not.toBe("BUTTON");
  expect(broken.queryByRole("switch")).toBeNull();
  expect(broken.queryByRole("button", { name: /actions|Remove|Undo/ })).toBeNull();
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
  const { rerender } = renderList();
  await check("Codex");
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex" });
  expect(page().getByText("Checking")).toBeTruthy();
  await back();
  expect(state("Codex")).toBe("Codex·Checking");
  // Main runs one runner per workspace, so the other agent's test waits.
  await openAgent("Claude Code");
  expect(checkButton().disabled).toBe(true);
  await act(async () => answer.resolve({ ok: true, detail: "Runner self-test passed." }));
  await openAgent("Codex");
  expect(page().getByText(/^Replied in \d+ s$/)).toBeTruthy();
  // While agents are paused, an agent that is off keeps the check it ran,
  // and one that is on says Paused.
  await back();
  const codexOff = { ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, enabled: false } } };
  rerender({ settings: codexOff });
  act(() => pausedListener?.({ paused: true }));
  expect(state("Codex")).toMatch(/^Codex·Replied in \d+ s$/);
  expect(state("Claude Code")).toBe("Your command·Paused");
});

it("says an agent didn't reply, names it in Notices with why and its log, and offers Try again", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({
    ok: false, detail: "Runner self-test timed out after 120 seconds.", logPath: "C:\\Logs\\check.log",
  });
  const { onError } = renderList();
  await check("Claude Code");
  expect(await page().findByText("Didn't reply.")).toBeTruthy();
  expect(onError).toHaveBeenCalledWith("Claude Code didn't reply to the check.", undefined, expect.any(Function), [
    ["Cause", "Runner self-test timed out after 120 seconds."],
    ["Log", "C:\\Logs\\check.log"],
  ], "agent-check:ws-1:default");
  await userEvent.click(page().getByRole("button", { name: "Try again" }));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
});

it("says an agent replied as Agent when its reply wasn't the check's", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({
    ok: false, unconfirmed: true, detail: "Codex's Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in Codex's details.", logPath: "C:\\Logs\\check.log",
  });
  const { onError } = renderList();
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledWith("Codex replied as Agent.", undefined, expect.any(Function), [
    ["Cause", "Codex's Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in Codex's details."],
    ["Log", "C:\\Logs\\check.log"],
  ], "agent-check:ws-1:codex");
});

it("checks the agent again from the failed check's toast", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Runner exited before reporting self-test success." });
  const { onError } = renderList();
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  const retry = onError.mock.calls[0]![2] as () => Promise<void>;
  await act(() => retry());
  expect(bridgeMock.runnerSelfTest).toHaveBeenLastCalledWith({ workspaceId: "ws-1", agentId: "codex" });
  expect(page().getByText(/^Replied in \d+ s$/)).toBeTruthy();

  // While a check can't start, Try again says why, and can be tried again.
  const running = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(running.promise);
  await check("Claude Code");
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
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not check Codex.", expect.any(Error), expect.any(Function), undefined, "agent-check:ws-1:codex"));
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
  expect(page().getByText(/^Replied in \d+ s$/)).toBeTruthy();
});

it("pauses every agent dohc starts that is on, and leaves the rest as they are", async () => {
  renderList({ settings: { ...SETTINGS, agents: { ...SETTINGS.agents, off: testAgent({ name: "Codex off", enabled: false }) } } });
  await userEvent.click(screen.getByRole("button", { name: "Pause all agents" }));
  expect(bridgeMock.setChatDispatchPaused).toHaveBeenCalledWith({ paused: true });
  act(() => pausedListener?.({ paused: true }));
  expect(screen.getByRole("button", { name: "Resume agents" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("agents-paused").textContent).toBe("Paused until you resume or quit dohc.");
  expect(state("Claude Code")).toBe("Your command·Paused");
  expect(state("Codex")).toBe("Codex·Paused");
  // An agent that is off has nothing to pause.
  expect(state("Codex off")).toBe("Your command·Off");
  expect(state("Claude in Terminal")).toBe("Through MCP");
  const codex = await openAgent("Codex");
  expect(checkButton().disabled).toBe(true);
  expect(codex.getByText("Paused")).toBeTruthy();
  expect(codex.getByTestId("agents-check-note").textContent).toBe("Agents are paused. Resume them, then try again.");
  await back();
  await userEvent.click(screen.getByRole("button", { name: "Resume agents" }));
  expect(bridgeMock.setChatDispatchPaused).toHaveBeenLastCalledWith({ paused: false });
});

const ids = () => screen.queryAllByTestId("agent-row").map((element) => element.dataset.agentId);

it("puts every agent in one list, with Pause and Add agent beside the title", () => {
  renderList();
  expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
  expect(ids()).toEqual(["default", "codex", "terminal"]);
  expect(screen.getByRole("button", { name: "Pause all agents" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Add agent" })).toHaveLength(1);
  // An MCP config is on its agent's page, not on the list.
  expect(screen.queryByRole("button", { name: "Copy MCP config" })).toBeNull();
});

it("shows Pause only while there is an agent dohc starts, and says when there are no agents", async () => {
  const { rerender } = renderList({ settings: { ...SETTINGS, agents: { terminal: mcpOnly } } });
  expect(screen.queryByRole("button", { name: "Pause all agents" })).toBeNull();
  expect(ids()).toEqual(["terminal"]);
  rerender({ settings: { ...SETTINGS, agents: {} } });
  // It says so once it knows you have no personal agents either.
  expect((await screen.findByTestId("agents-empty")).textContent).toBe("No agents yet.");
});

it("copies an MCP config that runs dohc's MCP server as the agent you run", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  renderList({ config: { command: "dohc-mcp", args: ["--workspace", "Trip", "--home", "Home"], workspacePath: "Trip", home: "Home" } });
  await user.click(row("Claude in Terminal"));
  const expected = { mcpServers: { dohc: { command: "dohc-mcp", args: ["--workspace", "Trip", "--home", "Home", "--agent-id", "terminal"] } } };
  expect(JSON.parse(page().getByTestId("mcp-config").textContent!)).toEqual(expected);
  await user.click(page().getByRole("button", { name: "Copy MCP config" }));
  expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(expected);
  writeText.mockRestore();
});

it("can't copy an MCP config the workspace doesn't have, and says why", async () => {
  renderList({ config: { unavailable: true, message: "dohc's MCP server isn't installed." } });
  const terminal = await openAgent("Claude in Terminal");
  expect((terminal.getByRole("button", { name: "Copy MCP config" }) as HTMLButtonElement).disabled).toBe(true);
  expect(terminal.getByTestId("mcp-unavailable").textContent).toBe("dohc's MCP server isn't installed.");
});

it("says an agent you run is listening while it waits for messages, and Through MCP once the wait ends", async () => {
  bridgeMock.readAgentsListening.mockResolvedValueOnce({ agentIds: ["terminal"] });
  renderList();
  await vi.waitFor(() => expect(state("Claude in Terminal")).toBe("Listening"));
  act(() => listeningListener?.({ agentIds: [] }));
  expect(state("Claude in Terminal")).toBe("Through MCP");
  act(() => listeningListener?.({ agentIds: ["terminal"] }));
  expect(state("Claude in Terminal")).toBe("Listening");
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
  expect(state("Claude in Terminal")).toBe("Through MCP");
});

it("marks this workspace's changes as one agent's from that agent's page", async () => {
  const onToggle = vi.fn();
  const two = { ...SETTINGS, agents: { ...SETTINGS.agents, cursor: { ...mcpOnly, name: "Cursor", hue: "teal" as const } } };
  const { rerender } = renderList({ settings: two, run: { activeRun: null, busy: false, onToggle } });
  const terminal = await openAgent("Claude in Terminal");
  expect(terminal.getByText("Mark changes as Claude in Terminal's")).toBeTruthy();
  expect(terminal.getByTestId("mcp-status").dataset.state).toBe("stopped");
  await userEvent.click(terminal.getByRole("button", { name: "Start run" }));
  expect(onToggle).toHaveBeenCalledWith("terminal");

  rerender({ settings: two, run: { activeRun: { id: "run-1", agentId: "terminal" }, busy: false, onToggle } });
  expect(page().getByTestId("mcp-status").dataset.state).toBe("running");
  expect(page().getByRole("button", { name: "Stop run" })).toBeTruthy();
  await back();
  expect(state("Claude in Terminal")).toBe("Marking changes");
  // Another agent's page says whose run is on, and can stop it.
  const cursor = await openAgent("Cursor");
  expect(cursor.getByTestId("mcp-status").textContent).toBe("Running as Claude in Terminal");
  expect(cursor.getByTestId("mcp-status").dataset.state).toBe("other");
  rerender({ settings: two, run: { activeRun: { id: "run-1", agentId: "terminal" }, busy: true, onToggle } });
  expect((page().getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(true);
  // An agent dohc starts has no run of its own.
  await openAgent("Codex");
  expect(page().queryByTestId("mcp-enable-toggle")).toBeNull();
});

it("stops a run for an agent the list doesn't show from the list", async () => {
  const onToggle = vi.fn();
  const { rerender } = renderList({ run: { activeRun: { id: "run-1", agentId: "dohc-mcp" }, busy: false, onToggle } });
  await userEvent.click(within(screen.getByTestId("agent-run-unlisted")).getByRole("button", { name: "Stop run" }));
  expect(onToggle).toHaveBeenCalledWith("dohc-mcp");
  // A listed agent's run is stopped from its page instead.
  rerender({ run: { activeRun: { id: "run-1", agentId: "terminal" }, busy: false, onToggle } });
  expect(screen.queryByTestId("agent-run-unlisted")).toBeNull();
});

it("adds an agent you run as Agent, then Agent 2, each off, in the next free color, with nothing to check", async () => {
  const teal = { ...SETTINGS, appearance: { ...SETTINGS.appearance, yourColor: "teal" as const } };
  const { onSave, rerender } = renderList({ settings: teal });
  await openAdd();
  await userEvent.click(runsWith("mcp"));
  expect(runsWith("mcp").getAttribute("aria-checked")).toBe("true");
  expect(sheet().getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Agent");
  expect(sheet().queryByRole("switch")).toBeNull();
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  const first = onSave.mock.calls[0]![0];
  expect(Object.keys(first.agents)).toEqual(["default", "codex", "terminal", "agent"]);
  // Olive, blue and rose are the agents', teal is yours, so plum is next.
  expect(first.agents.agent).toEqual({ name: "Agent", hue: "plum", changesFiles: true, enabled: false, timeoutMinutes: 30 });
  expect(first.agents.agent).not.toHaveProperty("launch");
  expect(screen.queryByTestId("agent-add-sheet")).toBeNull();
  rerender({ settings: first });
  expect(ids()).toEqual(["default", "codex", "terminal", "agent"]);
  expect(document.activeElement).toBe(row("Agent"));
  expect(state("Agent")).toBe("Through MCP");
  await addAgent("mcp");
  expect(onSave.mock.calls[1]![0].agents["agent-2"]).toMatchObject({ name: "Agent 2", hue: "rust", enabled: false });
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("shows the MCP config an agent you run will use before it is added", async () => {
  renderList({ config: { command: "dohc-mcp", args: ["--workspace", "Trip"], workspacePath: "Trip", home: "Home" } });
  await openAdd();
  await userEvent.click(runsWith("mcp"));
  const connect = within(screen.getByTestId("agent-add-connect"));
  expect(connect.getByText(/"--agent-id",\s*"agent"/)).toBeTruthy();
  expect(connect.getByRole("button", { name: "Copy MCP config" })).toBeTruthy();
});

it("names a new agent, picks its color, and keeps a typed name when the choice changes", async () => {
  const { onSave } = renderList();
  await openAdd();
  await within(runsWith("codex")).findByText("Ready");
  const name = sheet().getByRole<HTMLInputElement>("textbox", { name: "Name" });
  // The name follows the choice until the person types one.
  expect(name.value).toBe("Codex 2");
  await userEvent.click(runsWith("mcp"));
  expect(name.value).toBe("Agent");
  await userEvent.clear(name);
  // An empty name says so only once Add agent is pressed.
  expect(sheet().queryByRole("alert")).toBeNull();
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(sheet().getByRole("alert").textContent).toBe("Enter an agent name.");
  await userEvent.type(name, "codex");
  expect(sheet().getByRole("alert").textContent).toBe("Another agent has this name.");
  await userEvent.clear(name);
  await userEvent.type(name, "Cursor");
  expect(sheet().getByText("@Cursor")).toBeTruthy();
  await userEvent.click(runsWith("codex"));
  expect(name.value).toBe("Cursor");
  await userEvent.click(sheet().getByRole("radio", { name: "Teal" }));
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(onSave.mock.calls[0]![0].agents["codex-2"]).toMatchObject({ name: "Cursor", hue: "teal", enabled: true });
});

it("closes Add agent on Cancel without saving", async () => {
  const { onSave } = renderList();
  await openAdd();
  await userEvent.click(sheet().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("agent-add-sheet")).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});

it("adds Codex off without checking it when Run on this computer is off", async () => {
  const { onSave } = renderList();
  await openAdd();
  await within(runsWith("codex")).findByText("Ready");
  await userEvent.click(sheet().getByRole("switch", { name: "Run on this computer" }));
  await userEvent.click(screen.getByTestId("agent-add-confirm"));
  expect(onSave.mock.calls[0]![0].agents["codex-2"]).toMatchObject({ enabled: false, launch: { tool: "codex" } });
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("gives an agent you run Rename and Remove, and says on its page what it reaches", async () => {
  renderList();
  await openAgent("Claude in Terminal");
  await userEvent.click(screen.getByRole("button", { name: "Claude in Terminal actions" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Remove"]);
  await userEvent.keyboard("{Escape}");
  const details = within(page().getByTestId("agent-details"));
  expect(details.getByText("Every workspace dohc opens on this computer")).toBeTruthy();
  expect(details.getByRole("radiogroup", { name: "Color of Claude in Terminal" })).toBeTruthy();
  expect(page().queryByText("Stops after")).toBeNull();
});

it("removes an agent you run, and Undo puts it back in its place", async () => {
  const { onSave, onNotice, onOrder } = renderList();
  await chooseAction("Claude in Terminal", "Remove");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Claude in Terminal.", expect.any(Function)));
  // Its page closes, and focus goes to the Agents heading.
  expect(screen.queryByTestId("agent-page")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["default", "codex"]);
  const { default: claude, codex } = SETTINGS.agents;
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { default: claude!, codex: codex! } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledWith(["default", "codex", "terminal"], expect.any(String)));
  expect(bridgeMock.setUserSettings.mock.lastCall![0].settings.agents.terminal).toEqual(mcpOnly);
});

it("turns an agent off from its switch", async () => {
  const { onSave } = renderList();
  await userEvent.click((await openAgent("Codex")).getByRole("switch"));
  expect(onSave.mock.calls[0]![0].agents.codex?.enabled).toBe(false);
});

it("renames an agent in place, and refuses a name another agent has", async () => {
  const { onSave } = renderList();
  await openAgent("Codex");
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

it("renames an agent from its menu", async () => {
  renderList();
  await chooseAction("Codex", "Rename");
  expect(screen.getByRole("textbox", { name: "Name of Codex" })).toBeTruthy();
});

it("shows how dohc starts an agent and what it can do on its page", async () => {
  renderList();
  const codex = await openAgent("Codex");
  const details = within(codex.getByTestId("agent-details"));
  expect(await details.findByText("Codex 0.98, signed in")).toBeTruthy();
  expect(codex.getByTestId("agent-page-subtitle").textContent).toBe("@Codex·Codex 0.98, signed in");
  expect(details.getByText("C:\\Tools\\codex.exe")).toBeTruthy();
  expect(details.getByRole("button", { name: "Use your own command" })).toBeTruthy();
  const can = within(codex.getByTestId("agent-can"));
  expect(can.getByText("Edits without asking")).toBeTruthy();
  expect(can.getByText("Replies only")).toBeTruthy();
  expect(can.getByText("30 min")).toBeTruthy();
  expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);
  // An agent started by your own command has no tool, so its page doesn't say what a tool allows.
  const claude = await openAgent("Claude Code");
  expect(claude.queryByText("Edits without asking")).toBeNull();
  expect(within(claude.getByTestId("agent-details")).getByText("node agent.mjs")).toBeTruthy();
});

it("changes when an agent stops, and refuses minutes it can't save", async () => {
  const { onSave } = renderList();
  const codex = await openAgent("Codex");
  await userEvent.click(codex.getByRole("button", { name: "Change when Codex stops" }));
  const field = codex.getByRole<HTMLInputElement>("spinbutton", { name: "Minutes before Codex stops" });
  await userEvent.clear(field);
  await userEvent.type(field, "0{Enter}");
  expect(codex.getByRole("alert").textContent).toBe("Enter whole minutes from 1 to 1440.");
  expect(onSave).not.toHaveBeenCalled();
  await userEvent.clear(field);
  await userEvent.type(field, "45{Enter}");
  expect(onSave.mock.calls[0]![0].agents.codex?.timeoutMinutes).toBe(45);
});

it("keeps a tool's profile when its command is saved as shown, and adds your own flags to it", async () => {
  const { onSave } = renderList();
  const details = await openAgent("Codex");
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
  const details = within((await openAgent("Codex")).getByTestId("agent-details"));
  expect(await details.findByText("Codex 0.98, signed in")).toBeTruthy();
  expect(details.getByText("C:\\Tools\\codex.exe --model o3")).toBeTruthy();
  expect(details.queryByText("Program")).toBeNull();
  expect(details.getByRole("button", { name: "Change the command that starts Codex" })).toBeTruthy();
});

// An agent's swatches are squares, olive first, and set only that agent's color.
it("sets an agent's color on its page", async () => {
  const { onSave } = renderList();
  const color = (await openAgent("Codex")).getByRole("radiogroup", { name: "Color of Codex" });
  const hues = within(color).getAllByRole("radio");
  expect(hues.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Olive", "Rust", "Amber", "Teal", "Blue", "Indigo", "Plum", "Rose"]);
  for (const radio of hues) expect(radio.className).toContain("rounded-md");
  expect(within(color).getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(within(color).getByRole("radio", { name: "Plum" }));
  expect(onSave.mock.lastCall![0]).toEqual({ ...SETTINGS, agents: { ...SETTINGS.agents, codex: { ...SETTINGS.agents.codex!, hue: "plum" } } });
});

it("says what each tool needs before it can be added, and offers another agent", async () => {
  const found = deferred<AgentToolsResult>();
  bridgeMock.detectAgentTools.mockReturnValueOnce(found.promise);
  renderList();
  await openAdd();
  expect(within(runsWith("claude")).getByLabelText("Looking for Claude Code")).toBeTruthy();
  // Nothing is chosen while dohc looks, so the choice doesn't move under the person.
  expect(within(screen.getByRole("radiogroup", { name: "Runs with" })).queryAllByRole("radio", { checked: true })).toHaveLength(0);
  expect(screen.queryByTestId("agent-add-connect")).toBeNull();
  expect(screen.getByTestId<HTMLButtonElement>("agent-add-confirm").disabled).toBe(true);
  await act(async () => found.resolve({
    workingDirectory: "C:\\Work",
    tools: [
      { tool: "claude", executable: "C:\\Tools\\claude.exe", version: "2.1.317", auth: "signed-out", probe: "detected" },
      { tool: "codex", executable: null, version: null, auth: "unknown", probe: "not-found" },
    ],
  }));
  await within(runsWith("claude")).findByText("Sign in first");
  expect(runsWith("claude").disabled).toBe(true);
  expect(within(runsWith("codex")).getByText("Not found")).toBeTruthy();
  expect(runsWith("codex").disabled).toBe(true);
  // With no tool ready, the sheet starts on another agent.
  expect(runsWith("mcp").getAttribute("aria-checked")).toBe("true");
  expect(runsWith("mcp").disabled).toBe(false);
});

// Codex can run without a saved login, through CODEX_API_KEY or another model
// provider, so a sign-in dohc can't read still lets you add it.
it("says Codex is ready when dohc can't tell whether it is signed in", async () => {
  bridgeMock.detectAgentTools.mockResolvedValueOnce({
    workingDirectory: "C:\\Work",
    tools: [{ tool: "codex", executable: "C:\\Tools\\codex.exe", version: "0.98", auth: "unknown", probe: "detected" }],
  });
  renderList();
  await openAdd();
  await within(runsWith("codex")).findByText("Ready");
  expect(runsWith("codex").disabled).toBe(false);
  expect(runsWith("codex").getAttribute("aria-checked")).toBe("true");
});

it("adds a tool that is ready, on, with an id and name of its own, then checks it", async () => {
  const { onSave } = renderList();
  await addAgent("codex");
  const agents = onSave.mock.calls[0]![0].agents;
  expect(Object.keys(agents)).toEqual(["default", "codex", "terminal", "codex-2"]);
  expect(agents["codex-2"]).toMatchObject({
    name: "Codex 2", launch: { tool: "codex", executable: "C:\\Tools\\codex.exe" }, enabled: true, timeoutMinutes: 30,
  });
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex-2" });
});

it("doesn't check an agent added in one workspace after the panel moves to another", async () => {
  const saving = deferred<DesktopUserSettingsResult | null>();
  const { onSave, rerender } = renderList();
  onSave.mockReturnValueOnce(saving.promise);
  await addAgent("codex");
  rerender({ workspaceId: "ws-2" });
  saving.resolve({ settings: SETTINGS, source: "stored" });
  await waitFor(() => expect(screen.queryByTestId("agent-add-sheet")).toBeNull());
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("gives the first agent you add the default id", async () => {
  const { onSave } = renderList({ settings: { ...SETTINGS, agents: {} } });
  await addAgent("codex");
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["default"]);
});

it("never gives an agent you run the default id, which Chats sets up as one dohc starts", async () => {
  const { onSave } = renderList({ settings: { ...SETTINGS, agents: {} } });
  await addAgent("mcp");
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toEqual(["agent"]);
});

it("says on each tool that dohc couldn't look for tools, and looks again from the toast", async () => {
  bridgeMock.detectAgentTools.mockRejectedValueOnce(new Error("probe failed"));
  const { onError } = renderList();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("probe failed", expect.any(Error), expect.any(Function)));
  await openAdd();
  for (const tool of ["claude", "codex"] as const) {
    expect(within(runsWith(tool)).queryByLabelText(/^Looking for/)).toBeNull();
    expect(within(runsWith(tool)).getByText("Couldn't check")).toBeTruthy();
    expect(runsWith(tool).disabled).toBe(true);
  }
  expect(runsWith("mcp").getAttribute("aria-checked")).toBe("true");
  const retry = onError.mock.calls[0]![2] as () => Promise<void>;
  await act(() => retry());
  expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(2);
  expect(within(runsWith("codex")).getByText("Ready")).toBeTruthy();
  expect(runsWith("codex").disabled).toBe(false);
  // A tool found after the sheet showed its choice doesn't take it over.
  expect(runsWith("mcp").getAttribute("aria-checked")).toBe("true");
  expect(within(runsWith("claude")).getByText("Not found")).toBeTruthy();
});

it("marks the agent automations wake, and moves another one there with Undo", async () => {
  const { onOrder, onNotice } = renderList({ agentProblems: [BROKEN] });
  expect(screen.getAllByTestId("agent-for-automations")).toHaveLength(1);
  expect(within(row("Claude Code")).getByTestId("agent-for-automations").textContent).toBe("For automations");
  // Not on the agent automations already wake, nor on one dohc cannot start.
  for (const name of ["Claude Code", "Claude in Terminal"]) {
    await openAgent(name);
    await userEvent.click(screen.getByRole("button", { name: `${name} actions` }));
    expect(screen.queryByRole("menuitem", { name: "Use for automations" })).toBeNull();
    await userEvent.keyboard("{Escape}");
  }
  await openAgent("Codex");
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
  await chooseAction("Codex", "Use for automations");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Automations now wake Codex.", expect.any(Function)));
  rerender({ settings: { ...SETTINGS, agents: { codex, default: claude, gemini } } });
  await chooseAction("Gemini", "Use for automations");
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
  await chooseAction("Claude in Terminal", "Remove");
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
  await chooseAction("Claude in Terminal", "Remove");
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
  await chooseAction("Codex", "Remove");
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
  await chooseAction("Claude Code", "Remove");
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
  await chooseAction("Claude Code", "Remove");
  await vi.waitFor(() => expect(second.onNotice).toHaveBeenCalledWith("Removed Claude Code.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { codex } }, source: "stored", agentProblems: [{ ...BROKEN, position: 0 }] });
  second.onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(second.onOrder).toHaveBeenLastCalledWith(["codex-two", "default", "codex"], expect.any(String)));
});

it("puts an agent dohc can't start back above the automations agent when its Remove is undone at once", async () => {
  const claude = testAgent({ name: "Claude Code" });
  const codex = testAgent({ name: "Codex", hue: "blue" });
  const { onOrder, onNotice } = renderList({ settings: { ...SETTINGS, agents: { terminal: mcpOnly, default: claude, codex } } });
  await chooseAction("Claude in Terminal", "Remove");
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
  await chooseAction("Claude Code", "Remove");
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
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  const { codex: _codex, ...afterCodex } = agents;
  rerender({ settings: { ...SETTINGS, agents: afterCodex } });
  await chooseAction("Claude Code", "Remove");
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
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  // Gemini was then chosen for automations, and Claude Code removed.
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: { gemini } }, source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenLastCalledWith(["gemini", "codex"], expect.any(String)));
});

it("removes an agent, and Undo puts it back where it was", async () => {
  const { onSave, onOrder, onNotice } = renderList();
  await chooseAction("Codex", "Remove");
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
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dohc didn't remove Codex because the settings file still lists it."));
  // Its page stays open.
  expect(page().getByRole("button", { name: "Rename Codex" })).toBeTruthy();
  // Or as an entry dohc can't use.
  const { codex: _codex, ...rest } = SETTINGS.agents;
  onSave.mockResolvedValueOnce({ settings: { ...SETTINGS, agents: rest }, source: "stored", agentProblems: [{ ...BROKEN, id: "codex" }] });
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  expect(onNotice).not.toHaveBeenCalled();
});

it("leaves an agent that came back after Undo read the file", async () => {
  const { onSave, onOrder, onNotice, onError } = renderList();
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: onSave.mock.calls[0]![0], source: "stored" });
  bridgeMock.setUserSettings.mockRejectedValueOnce(new Error(
    "Error invoking remote method 'desktop:set-user-settings': AgentIdTakenError: dohc didn't add Codex because the settings file changed at the same time.",
  ));
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Undo didn't replace the new Codex, so the one you removed stays removed."));
  expect(onOrder).not.toHaveBeenCalled();
});

it("goes back to the list when the open agent leaves the file", async () => {
  const { rerender } = renderList();
  await openAgent("Codex");
  const { codex: _codex, ...rest } = SETTINGS.agents;
  rerender({ settings: { ...SETTINGS, agents: rest } });
  expect(screen.queryByTestId("agent-page")).toBeNull();
  expect(ids()).toEqual(["default", "terminal"]);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
});

const trust = (trusted: boolean | null) => ({ trusted, asking: false, onTrust: vi.fn() });

it("holds Check back in Restricted Mode with the band's words, and adds an agent without checking it", async () => {
  const restricted = trust(false);
  const { onSave, onError } = renderList({ trust: restricted });
  const band = screen.getByTestId("restricted-agents-state");
  expect(band.textContent).toContain(AGENTS_RESTRICTED_MESSAGE);
  // The band sits above the agents.
  expect(band.compareDocumentPosition(screen.getByTestId("agents")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByTestId("agents-check-note")).toBeNull();
  await userEvent.click(within(band).getByRole("button", { name: "Trust workspace" }));
  expect(restricted.onTrust).toHaveBeenCalledOnce();
  // The agent's page keeps the band, and its test waits.
  const codex = await openAgent("Codex");
  expect(screen.getByTestId("restricted-agents-state")).toBeTruthy();
  expect(checkButton().disabled).toBe(true);
  expect(checkButton().title).toBe(AGENTS_RESTRICTED_MESSAGE);
  expect(codex.queryByTestId("agents-check-note")).toBeNull();
  await back();

  await addAgent("codex");
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(Object.keys(onSave.mock.calls[0]![0].agents)).toContain("codex-2");
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByText("Didn't reply.")).toBeNull();
  // The switch still works.
  await userEvent.click((await openAgent("Codex")).getByRole("switch", { name: "Run Codex on this computer" }));
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("says Restricted Mode holds the check back when an old toast's Try again comes while restricted", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Runner exited before reporting self-test success." });
  const { onError, rerender } = renderList({ trust: trust(true) });
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  rerender({ trust: trust(false) });
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenLastCalledWith("dohc could not check Codex.", undefined, expect.any(Function), [
    ["Cause", AGENTS_RESTRICTED_MESSAGE],
  ], "agent-check:ws-1:codex");
});

it("turns Check on once the workspace is trusted, without checking", async () => {
  const { rerender } = renderList({ trust: trust(false) });
  rerender({ trust: trust(true) });
  expect(screen.queryByTestId("restricted-agents-state")).toBeNull();
  await openAgent("Codex");
  expect(checkButton().disabled).toBe(false);
  expect(checkButton().title).toBe("");
  expect(bridgeMock.runnerSelfTest).not.toHaveBeenCalled();
});

it("holds nothing back while trust is still being read, and Add's passing check takes back the agent's row", async () => {
  const onClearError = vi.fn();
  renderList({ trust: trust(null), onClearError });
  expect(screen.queryByTestId("restricted-agents-state")).toBeNull();
  await openAgent("Codex");
  expect(checkButton().disabled).toBe(false);
  await back();
  await addAgent("codex");
  await vi.waitFor(() => expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "codex-2" }));
  await vi.waitFor(() => expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex-2"));
});

it("takes back only that agent's failed check when its check passes, from its page or the toast", async () => {
  bridgeMock.runnerSelfTest
    .mockResolvedValueOnce({ ok: false, detail: "Claude Code timed out." })
    .mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const onClearError = vi.fn();
  const { onError } = renderList({ onClearError });
  await check("Claude Code");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  expect(onError.mock.calls.map((call) => call[4])).toEqual(["agent-check:ws-1:default", "agent-check:ws-1:codex"]);
  expect(onClearError).not.toHaveBeenCalled();

  await userEvent.click(checkButton());
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
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await chooseAction("Codex", "Remove");
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Codex.", expect.any(Function)));
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");
  bridgeMock.getUserSettings.mockResolvedValueOnce({ settings: onSave.mock.calls[0]![0], source: "stored" });
  onNotice.mock.calls[0]![1]!();
  await vi.waitFor(() => expect(onOrder).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledOnce();
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
});

// Fix P: focus after the band's Trust workspace.
const trustButton = () => within(screen.getByTestId("restricted-agents-state")).getByRole("button", { name: "Trust workspace" });

async function pressTrust(fields: Partial<Parameters<typeof AgentList>[0]> = {}, open?: string) {
  const onTrust = vi.fn();
  const list = renderList({ trust: { trusted: false, asking: false, onTrust }, ...fields });
  if (open) await openAgent(open);
  await userEvent.click(trustButton());
  expect(onTrust).toHaveBeenCalledOnce();
  // Main's dialog is open, and the band's button is off. Chromium then
  // moves focus to the body; jsdom keeps it on a disabled button.
  act(() => trustButton().blur());
  list.rerender({ trust: { trusted: false, asking: true, onTrust } });
  return { ...list, onTrust };
}

it("moves focus to the first agent when the band's Trust workspace trusts the workspace", async () => {
  const { rerender, onTrust } = await pressTrust();
  rerender({ trust: { trusted: true, asking: false, onTrust } });
  expect(document.activeElement).toBe(row("Claude Code"));
});

it("moves focus to Send test when Trust workspace trusts the workspace from an agent's page", async () => {
  const { rerender, onTrust } = await pressTrust({}, "Codex");
  rerender({ trust: { trusted: true, asking: false, onTrust } });
  expect(document.activeElement).toBe(checkButton());
});

it("moves focus to the Agents heading when there is no agent to go to", async () => {
  const { rerender, onTrust } = await pressTrust({ settings: { ...SETTINGS, agents: {} } });
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
  const codex = row("Codex");
  act(() => codex.focus());
  pressed.rerender({ trust: { trusted: true, asking: false, onTrust: pressed.onTrust } });
  expect(document.activeElement).toBe(codex);
});

// Fix P: a check that ends after the panel closes still reports.
it("takes back the notice, or files it, when a check ends after the panel closed", async () => {
  const first = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(first.promise);
  const onClearError = vi.fn();
  const passed = renderList({ onClearError });
  await check("Codex");
  passed.unmount();
  await act(async () => first.resolve({ ok: true, detail: "ok" }));
  expect(onClearError).toHaveBeenCalledExactlyOnceWith("agent-check:ws-1:codex");

  const second = deferred<RunnerSelfTestResult>();
  bridgeMock.runnerSelfTest.mockReturnValueOnce(second.promise);
  const failed = renderList();
  await check("Codex");
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
  await check("Codex");
  await chooseAction("Codex", "Remove");
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
  await check("Codex");
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
  await check("Codex");
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
  await check("Codex");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

  bridgeMock.getUserSettings.mockResolvedValueOnce({
    settings: { ...SETTINGS, agents: rest }, source: "stored", agentProblems: [{ ...BROKEN, id: "codex", name: codex!.name }],
  });
  await userEvent.click(page().getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
});

// Fix P: a Try again kept after the panel closed.
it("asks main whether the workspace is restricted when a closed panel's Try again runs", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Codex timed out." });
  const { onError, unmount } = renderList({ trust: trust(true) });
  await check("Codex");
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
  await check("Codex");
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
  await check("Codex");
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
  await openAgent("Codex");
  await userEvent.dblClick(checkButton());
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledOnce();
  expect(bridgeMock.readWorkspaceTrust).not.toHaveBeenCalled();
  await act(async () => answer.resolve({ ok: true, detail: "ok" }));
});


const GROK_ID = `p-${"b".repeat(26)}`;
const NOVA_ID = `p-${"n".repeat(26)}`;
const GROK: PersonalAgent = {
  agentId: GROK_ID, name: "Grok Bot", hue: "teal", reportedProduct: "Grok", reportedVersion: "4.1", status: "active",
  createdAtMs: Date.UTC(2026, 10, 2), signedInAtMs: Date.UTC(2026, 10, 3, 10, 42), lastActionAtMs: null,
  reach: [{ workspaceId: "ws-2", level: "view" }, { workspaceId: "ws-1", level: "comment" }],
};
const NOVA: PersonalAgent = {
  agentId: NOVA_ID, name: "Nova", hue: "plum", reportedProduct: null, reportedVersion: null, status: "signed_out",
  createdAtMs: Date.UTC(2026, 10, 3), signedInAtMs: null, lastActionAtMs: null, reach: [],
};
const ACCOUNT_KEY = "https://server.test#https://relay.test#user-1";
function account(agents: readonly PersonalAgent[] = [{ ...GROK, lastActionAtMs: Date.now() - 120_000 }, NOVA]): PersonalAgentsAccount {
  return {
    accountKey: ACCOUNT_KEY,
    host: "relay.test",
    agentLinkOrigin: "https://relay.test",
    roster: { revision: 3, agents: [...agents], workspaces: [{ workspaceId: "ws-1", name: "Trip" }, { workspaceId: "ws-2", name: "Budget" }] },
    failure: null,
  };
}
const personalIds = () => screen.queryAllByTestId("agent-row").filter((element) => element.dataset.personal !== undefined).map((element) => element.dataset.agentId);

async function renderServer(fields: Partial<Parameters<typeof AgentList>[0]> = {}, agents?: readonly PersonalAgent[]) {
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [account(agents)] });
  const rendered = renderList(fields);
  await waitFor(() => expect(personalIds().length).toBeGreaterThan(0));
  return rendered;
}
const menuItems = async (name: string) => {
  await userEvent.click(screen.getByRole("button", { name: `${name} actions` }));
  return screen.getAllByRole("menuitem").map((item) => item.textContent);
};

it("lists each personal agent in the one list, after the agents here, through its agent link", async () => {
  await renderServer();
  expect(bridgeMock.readPersonalAgents).toHaveBeenCalledWith({ refresh: true });
  expect(ids()).toEqual(["default", "codex", "terminal", GROK_ID, NOVA_ID]);
  // No section per server: the host is on each row.
  expect(screen.queryByRole("heading", { name: "relay.test" })).toBeNull();
  expect(state("Grok Bot")).toBe("Through agent link·relay.test·Active 2m ago");
  // A signed-out agent stays, dimmed.
  expect(state("Nova")).toBe("Through agent link·relay.test·Signed out");
  expect(row("Nova").querySelector(`span[title="Nova"]`)!.getAttribute("class")).toContain("opacity-50");
  expect(row("Grok Bot").querySelector(`span[title="Grok Bot"]`)!.getAttribute("class")).not.toContain("opacity-50");
  // An agent that has done nothing yet says it signed in.
  act(() => personalListener!({ accounts: [account([GROK, NOVA])] }));
  expect(state("Grok Bot")).toBe("Through agent link·relay.test·Signed in");
});

it("waits for your personal agents before it says there are no agents", async () => {
  const roster = deferred<PersonalAgentsEvent>();
  bridgeMock.readPersonalAgents.mockReturnValueOnce(roster.promise);
  renderList({ settings: { ...SETTINGS, agents: {} } });
  expect(screen.queryByTestId("agents-empty")).toBeNull();
  await act(async () => roster.resolve({ accounts: [account([NOVA])] }));
  expect(ids()).toEqual([NOVA_ID]);
  expect(screen.queryByTestId("agents-empty")).toBeNull();
});

it("copies this workspace's agent link from Add agent, where the agent gets no name", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const { onSave } = await renderServer();
  await user.click(screen.getByRole("button", { name: "Add agent" }));
  expect(within(runsWith("link")).getByText("relay.test")).toBeTruthy();
  await user.click(runsWith("link"));
  expect(runsWith("link").getAttribute("aria-checked")).toBe("true");
  // The agent names itself when it signs in.
  expect(sheet().queryByTestId("agent-add-name")).toBeNull();
  expect(sheet().queryByText("Color")).toBeNull();
  expect(sheet().getByTestId("agent-add-link-name").textContent).toBe("You name it when it signs in.");
  expect(sheet().getByTestId("agent-add-link").textContent).toBe("Triprelay.test");
  expect(sheet().queryByTestId("agent-add-confirm")).toBeNull();
  const copy = sheet().getByTestId<HTMLButtonElement>("agent-add-link-copy");
  expect(copy.disabled).toBe(false);
  expect(copy.textContent).toBe("Copy agent link");
  await user.click(copy);
  expect(writeText).toHaveBeenCalledWith("https://relay.test/mcp/agent/w/ws-1");
  expect(onSave).not.toHaveBeenCalled();
  writeText.mockRestore();
});

it("can't copy an agent link for a workspace that doesn't sync to the server, and says why", async () => {
  await renderServer({ workspaceId: "ws-3" });
  await openAdd();
  await userEvent.click(runsWith("link"));
  expect(sheet().getByTestId<HTMLButtonElement>("agent-add-link-copy").disabled).toBe(true);
  expect(sheet().getByTestId("agent-add-link").textContent).toBe("TripNot synced");
  expect(sheet().getByTestId("agent-add-link-note").textContent).toBe("Sync this workspace to relay.test to give an agent a link.");
});

it("dims Agent link when this computer is signed in to no server", async () => {
  renderList();
  await openAdd();
  expect(await within(runsWith("link")).findByText("Not signed in to a server")).toBeTruthy();
  expect(runsWith("link").disabled).toBe(true);
  expect(runsWith("link").title).toBe("Sign in to a server to give an agent a link.");
});

it("shows a personal agent's color, reach, activity and Sign out on its page", async () => {
  await renderServer();
  const grok = await openAgent("Grok Bot");
  expect(grok.getByTestId("agent-page-subtitle").textContent).toBe("@GrokBot·Through agent link·relay.test");
  expect(grok.getByTestId("personal-agent-color")).toBeTruthy();
  // Every workspace on the server, at its level, in the server's order.
  expect(grok.getAllByTestId("personal-agent-reach-entry").map((entry) => entry.textContent)).toEqual(["TripComment", "BudgetView"]);
  const activity = within(grok.getByTestId("personal-agent-activity"));
  expect(activity.getByText("Signed in")).toBeTruthy();
  expect(grok.getByTestId("personal-agent-activity").querySelector("time")!.getAttribute("datetime")).toBe(new Date(GROK.signedInAtMs!).toISOString());
  expect(activity.getByText("2m ago")).toBeTruthy();
  expect(activity.getByText("Grok 4.1", { exact: false }).textContent).toBe("Grok 4.1 as reported");
  expect(grok.getByTestId("personal-agent-sign-out").textContent).toBe("Sign out");
  // A personal agent never wakes automations, and Remove waits for sign-out.
  expect(await menuItems("Grok Bot")).toEqual(["Rename"]);
  expect(screen.queryByText("Use for automations")).toBeNull();
});

it("shows only what a product reported, and nothing when it reported neither", async () => {
  await renderServer({}, [{ ...GROK, reportedVersion: null }, { ...NOVA, status: "active", reach: [] }]);
  expect(within((await openAgent("Grok Bot")).getByTestId("personal-agent-activity")).getByText("Grok", { exact: false }).textContent).toBe("Grok as reported");
  const nova = await openAgent("Nova");
  expect(nova.queryByText("as reported")).toBeNull();
  expect(within(nova.getByTestId("personal-agent-activity")).getByText("None yet")).toBeTruthy();
  // The relay has no sign-in time for it.
  expect(nova.getByTestId("personal-agent-activity").querySelector("time")).toBeNull();
  expect(nova.getAllByTestId("personal-agent-reach-entry").map((entry) => entry.textContent)).toEqual(["TripNone", "BudgetNone"]);
});

it("changes what an agent can reach from its sheet", async () => {
  await renderServer();
  await openAgent("Grok Bot");
  await userEvent.click(page().getByRole("button", { name: "Change what Grok Bot can reach" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change what Grok Bot can reach" }));
  expect(dialog.getAllByTestId("personal-agent-reach-row").map((element) => element.querySelector("span")!.textContent)).toEqual(["Trip", "Budget"]);
  expect(dialog.getByRole("radiogroup", { name: "What Grok Bot can do in Trip" }).querySelector("[aria-checked='true']")!.textContent).toBe("Comment");
  await userEvent.click(within(dialog.getByRole("radiogroup", { name: "What Grok Bot can do in Budget" })).getByRole("radio", { name: "None" }));
  await userEvent.click(dialog.getByRole("button", { name: "Save reach" }));
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledExactlyOnceWith({
    accountKey: ACCOUNT_KEY,
    agentId: GROK_ID,
    change: { kind: "reach", reach: [{ workspaceId: "ws-1", level: "comment" }] },
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("says above the sheet's buttons why a reach save failed, and keeps the choices", async () => {
  const { onError } = await renderServer();
  bridgeMock.changePersonalAgent.mockResolvedValueOnce({ ok: false, error: "relay.test could not change Grok Bot right now. Try again shortly." });
  await openAgent("Grok Bot");
  await userEvent.click(page().getByRole("button", { name: "Change what Grok Bot can reach" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change what Grok Bot can reach" }));
  await userEvent.click(within(dialog.getByRole("radiogroup", { name: "What Grok Bot can do in Budget" })).getByRole("radio", { name: "Comment" }));
  await userEvent.click(dialog.getByRole("button", { name: "Save reach" }));
  const alert = await dialog.findByTestId("personal-agent-reach-error");
  expect(alert.textContent).toBe("relay.test could not change Grok Bot right now. Try again shortly.");
  // The reason sits right above Cancel and Save reach.
  expect(alert.nextElementSibling!.contains(dialog.getByRole("button", { name: "Save reach" }))).toBe(true);
  expect(dialog.getByRole("radiogroup", { name: "What Grok Bot can do in Budget" }).querySelector("[aria-checked='true']")!.textContent).toBe("Comment");
  expect(dialog.getByRole<HTMLButtonElement>("button", { name: "Save reach" }).disabled).toBe(false);
  // The sheet shows its own failure; no toast while it is open.
  expect(onError).not.toHaveBeenCalled();
});

it("closes the reach sheet on Cancel without changing anything", async () => {
  await renderServer();
  await openAgent("Grok Bot");
  await userEvent.click(page().getByRole("button", { name: "Change what Grok Bot can reach" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change what Grok Bot can reach" }));
  await userEvent.click(within(dialog.getByRole("radiogroup", { name: "What Grok Bot can do in Trip" })).getByRole("radio", { name: "None" }));
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridgeMock.changePersonalAgent).not.toHaveBeenCalled();
  expect(page().getAllByTestId("personal-agent-reach-entry")[0]!.textContent).toBe("TripComment");
});

it("signs an agent out after asking, and its page dims with no reach", async () => {
  await renderServer();
  await openAgent("Grok Bot");
  await userEvent.click(page().getByTestId("personal-agent-sign-out"));
  const dialog = within(screen.getByRole("dialog", { name: "Sign out Grok Bot?" }));
  expect(dialog.getByText("Its posts and changes stay in History.")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Sign out" }));
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledExactlyOnceWith({
    accountKey: ACCOUNT_KEY, agentId: GROK_ID, change: { kind: "sign-out" },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => personalListener!({ accounts: [account([{ ...GROK, status: "signed_out", reach: [] }, NOVA])] }));
  expect(screen.getByTestId("agent-page").dataset.status).toBe("signed_out");
  expect(page().getByTestId("agent-page-subtitle").textContent).toBe("@GrokBot·Through agent link·relay.test·Signed out");
  expect(page().getByTestId("agent-page-subtitle").parentElement!.getAttribute("class")).toContain("opacity-50");
  expect(page().queryByTestId("personal-agent-reach-list")).toBeNull();
  expect(page().queryByTestId("personal-agent-sign-out")).toBeNull();
  expect(await menuItems("Grok Bot")).toEqual(["Rename", "Remove"]);
});

it("says why a sign-out failed in a toast, with Try again", async () => {
  const { onError } = await renderServer();
  bridgeMock.changePersonalAgent.mockResolvedValueOnce({ ok: false, error: "relay.test could not change Grok Bot right now. Try again shortly." });
  await openAgent("Grok Bot");
  await userEvent.click(page().getByTestId("personal-agent-sign-out"));
  await userEvent.click(within(screen.getByRole("dialog", { name: "Sign out Grok Bot?" })).getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("relay.test could not change Grok Bot right now. Try again shortly.", undefined, expect.any(Function)));
  await act(() => (onError.mock.calls[0]![2] as () => Promise<void>)());
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledTimes(2);
});

it("copies the agent link that signs a signed-out agent in again", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await renderServer();
  const nova = await openAgent("Nova");
  expect(nova.queryByTestId("personal-agent-reach-list")).toBeNull();
  expect(nova.getByText("Sign in again")).toBeTruthy();
  expect(screen.queryByTestId("personal-agent-link-reason")).toBeNull();
  await user.click(nova.getByTestId("personal-agent-link-copy"));
  expect(writeText).toHaveBeenCalledWith("https://relay.test/mcp/agent/w/ws-1");
  writeText.mockRestore();
});

it("can't sign an agent in again from a workspace that doesn't sync to the server", async () => {
  await renderServer({ workspaceId: "ws-3" });
  const nova = await openAgent("Nova");
  expect(nova.getByTestId<HTMLButtonElement>("personal-agent-link-copy").disabled).toBe(true);
  expect(nova.getByTestId("personal-agent-link-reason").textContent).toBe("Sync this workspace to relay.test to give an agent a link.");
});

it("removes a signed-out agent, and Undo brings it back signed out", async () => {
  const { onNotice } = await renderServer();
  await chooseAction("Nova", "Remove");
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Nova.", expect.any(Function)));
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledExactlyOnceWith({
    accountKey: ACCOUNT_KEY, agentId: NOVA_ID, change: { kind: "remove" },
  });
  // Its page goes with it, and focus goes to the Agents heading.
  act(() => personalListener!({ accounts: [account([GROK])] }));
  expect(screen.queryByTestId("agent-page")).toBeNull();
  expect(personalIds()).toEqual([GROK_ID]);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
  act(() => onNotice.mock.calls[0]![1]!());
  await waitFor(() => expect(bridgeMock.changePersonalAgent).toHaveBeenLastCalledWith({
    accountKey: ACCOUNT_KEY, agentId: NOVA_ID, change: { kind: "restore" },
  }));
  act(() => personalListener!({ accounts: [account([GROK, NOVA])] }));
  expect(state("Nova")).toBe("Through agent link·relay.test·Signed out");
});

it("marks this computer's agent whose handle a personal agent has", async () => {
  await renderServer({}, [{ ...GROK, name: "codex" }]);
  expect(within(row("Codex")).getByTestId("agent-problem").textContent).toBe("Another agent has this name.");
  expect(within(row("Claude Code")).queryByTestId("agent-problem")).toBeNull();
});

it("won't name an agent here like a personal agent, even a signed-out one", async () => {
  await renderServer();
  await chooseAction("Codex", "Rename");
  const input = screen.getByTestId("agent-name-input");
  await userEvent.clear(input);
  await userEvent.type(input, "Nova");
  expect(screen.getByRole("alert").textContent).toBe("Another agent has this name.");
});

it("gives a new agent a name no personal agent has", async () => {
  await renderServer({}, [{ ...GROK, name: "Agent" }]);
  await openAdd();
  await userEvent.click(runsWith("mcp"));
  expect(sheet().getByTestId<HTMLInputElement>("agent-add-name").value).toBe("Agent 2");
});

it("renames a personal agent on its server, to a name no other agent has", async () => {
  await renderServer();
  await chooseAction("Grok Bot", "Rename");
  const input = screen.getByTestId("agent-name-input");
  await userEvent.clear(input);
  await userEvent.type(input, "Codex");
  expect(screen.getByRole("alert").textContent).toBe("Another agent has this name.");
  await userEvent.clear(input);
  await userEvent.type(input, "Grok{Enter}");
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledExactlyOnceWith({
    accountKey: ACCOUNT_KEY, agentId: GROK_ID, change: { kind: "name", name: "Grok" },
  });
});

it("opens the page of the personal agent a notice names once the roster answers", async () => {
  const roster = deferred<PersonalAgentsEvent>();
  bridgeMock.readPersonalAgents.mockReturnValueOnce(roster.promise);
  renderList({ openAgent: { agentId: GROK_ID } });
  expect(screen.queryByTestId("agent-page")).toBeNull();
  // Main lists the account before its first read answers.
  act(() => personalListener!({ accounts: [{ ...account(), roster: null }] }));
  expect(screen.queryByTestId("agent-page")).toBeNull();
  act(() => personalListener!({ accounts: [account()] }));
  await waitFor(() => expect(screen.getByTestId("agent-page").getAttribute("aria-label")).toBe("Grok Bot"));
  expect(document.activeElement).toBe(screen.getByTestId("agent-back"));
  await act(async () => roster.resolve({ accounts: [account()] }));
  expect(screen.getByTestId("agent-page").getAttribute("aria-label")).toBe("Grok Bot");
});

it("opens the agent a notice names on a page of its own, with that agent's reach", async () => {
  const irisId = `p-${"c".repeat(26)}`;
  const iris: PersonalAgent = { ...GROK, agentId: irisId, name: "Iris", hue: "plum", reach: [{ workspaceId: "ws-2", level: "comment" }] };
  const { rerender } = await renderServer({}, [GROK, iris]);
  await openAgent("Grok Bot");
  await userEvent.click(page().getByRole("button", { name: "Change what Grok Bot can reach" }));
  const grok = within(screen.getByRole("dialog", { name: "Change what Grok Bot can reach" }));
  await userEvent.click(within(grok.getByRole("radiogroup", { name: "What Grok Bot can do in Budget" })).getByRole("radio", { name: "Comment" }));
  // Open on Iris's sign-in toast.
  rerender({ openAgent: { agentId: irisId } });
  await waitFor(() => expect(screen.getByTestId("agent-page").getAttribute("aria-label")).toBe("Iris"));
  // Grok's sheet closed with Grok's page.
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(page().getByRole("button", { name: "Change what Iris can reach" }));
  const irisSheet = within(screen.getByRole("dialog", { name: "Change what Iris can reach" }));
  expect(irisSheet.getByRole("radiogroup", { name: "What Iris can do in Trip" }).querySelector("[aria-checked='true']")!.textContent).toBe("None");
  await userEvent.click(irisSheet.getByRole("button", { name: "Save reach" }));
  expect(bridgeMock.changePersonalAgent).toHaveBeenCalledExactlyOnceWith({
    accountKey: ACCOUNT_KEY, agentId: irisId, change: { kind: "reach", reach: [{ workspaceId: "ws-2", level: "comment" }] },
  });
});

it("opens a personal agent's page after it was renamed on another computer", async () => {
  // The notice said "Grok Bot signed in as your agent"; the roster now calls it Grok.
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [account([{ ...GROK, name: "Grok" }, NOVA])] });
  renderList({ openAgent: { agentId: GROK_ID } });
  await waitFor(() => expect(screen.getByTestId("agent-page").getAttribute("aria-label")).toBe("Grok"));
});

it("shows the list when the roster no longer holds the agent a notice names", async () => {
  await renderServer({ openAgent: { agentId: `p-${"i".repeat(26)}` } });
  expect(screen.queryByTestId("agent-page")).toBeNull();
  expect(personalIds()).toEqual([GROK_ID, NOVA_ID]);
});

it("goes back to the list from another agent's page when the roster no longer holds the agent a notice names", async () => {
  const { rerender } = await renderServer();
  await chooseAction("Grok Bot", "Rename");
  // A name another agent has keeps the rename open.
  const input = screen.getByTestId("agent-name-input");
  await userEvent.clear(input);
  await userEvent.type(input, "Codex");
  rerender({ openAgent: { agentId: `p-${"i".repeat(26)}` } });
  await waitFor(() => expect(screen.queryByTestId("agent-page")).toBeNull());
  expect(personalIds()).toEqual([GROK_ID, NOVA_ID]);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
  // The rename ended with its page.
  await openAgent("Grok Bot");
  expect(screen.queryByTestId("agent-name-input")).toBeNull();
});

it("says in the list that the account's agents couldn't be listed, with the cause in a toast", async () => {
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({
    accounts: [{ ...account(), roster: null, failure: "dohc could not reach relay.test. Check your connection." }],
  });
  const { onError } = renderList();
  expect((await screen.findByTestId("personal-agents-retry")).textContent).toContain("dohc could not list your agents on relay.test.");
  expect(onError).toHaveBeenCalledWith("dohc could not reach relay.test. Check your connection.", undefined, expect.any(Function), undefined,
    `personal-agents:${ACCOUNT_KEY}`);
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [account()] });
  await userEvent.click(within(screen.getByTestId("personal-agents-retry")).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(personalIds()).toEqual([GROK_ID, NOVA_ID]));
  expect(bridgeMock.readPersonalAgents).toHaveBeenLastCalledWith({ refresh: true });
  expect(screen.queryByTestId("personal-agents-retry")).toBeNull();
});

it("reports again when Try again on the toast can't list the account's agents again, in the account's one row", async () => {
  const failure = "dohc could not reach relay.test. Check your connection.";
  const failing = (): PersonalAgentsEvent => ({ accounts: [{ ...account(), roster: null, failure }] });
  bridgeMock.readPersonalAgents.mockResolvedValueOnce(failing());
  // Notices as the shell keeps them: a report replaces the row of its
  // identity, and Try again takes its row back as the read starts.
  const notices = new Map<string, () => Promise<void>>();
  const onError = vi.fn((message: string, _cause?: unknown, retry?: () => Promise<void>, _details?: unknown, identity?: string) => {
    notices.set(identity ?? message, retry!);
  });
  renderList({ onError });
  const identity = `personal-agents:${ACCOUNT_KEY}`;
  await waitFor(() => expect(notices.has(identity)).toBe(true));
  const tryAgain = notices.get(identity)!;
  notices.delete(identity);
  // Still offline: main pushes the same words, then answers with them.
  bridgeMock.readPersonalAgents.mockImplementationOnce(async () => {
    personalListener!(failing());
    return failing();
  });
  await act(tryAgain);
  expect([...notices.keys()]).toEqual([identity]);
  expect(onError).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenLastCalledWith(failure, undefined, expect.any(Function), undefined, identity);
  // A push for another reason reports nothing.
  act(() => personalListener!(failing()));
  expect(onError).toHaveBeenCalledTimes(2);
});

it("reports an account's failure once while you open one of its agents and come back", async () => {
  const failure = "dohc could not reach relay.test. Check your connection.";
  // The last roster stays while the next read fails.
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [{ ...account(), failure }] });
  const { onError } = renderList();
  const reports = () => onError.mock.calls.filter(([message]) => message === failure);
  await waitFor(() => expect(reports()).toHaveLength(1));
  await openAgent("Grok Bot");
  await back();
  expect(personalIds()).toEqual([GROK_ID, NOVA_ID]);
  expect(reports()).toHaveLength(1);
});

it("reports an account's failure again when it ends and comes back while a page is open", async () => {
  const failure = "dohc could not reach relay.test. Check your connection.";
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [{ ...account(), failure }] });
  const { onError } = renderList();
  const reports = () => onError.mock.calls.filter(([message]) => message === failure);
  await waitFor(() => expect(reports()).toHaveLength(1));
  await openAgent("Claude Code");
  // Elsewhere the account signs out, signs in again, and its first read fails the same way.
  act(() => personalListener!({ accounts: [] }));
  act(() => personalListener!({ accounts: [{ ...account(), roster: null, failure: null }] }));
  act(() => personalListener!({ accounts: [{ ...account(), roster: null, failure }] }));
  await back();
  await waitFor(() => expect(reports()).toHaveLength(2));
});

it("reports again when Try again on the toast can't read your personal agents again", async () => {
  bridgeMock.readPersonalAgents.mockRejectedValueOnce(new Error("main went away"));
  const { onError } = renderList();
  const reports = () => onError.mock.calls.filter(([message]) => message === "dohc could not read your personal agents.");
  await waitFor(() => expect(reports()).toHaveLength(1));
  expect(screen.getByTestId("personal-agents-retry").textContent).toContain("dohc could not read your personal agents.");
  bridgeMock.readPersonalAgents.mockRejectedValueOnce(new Error("main went away"));
  await act(() => (reports()[0]![2] as () => Promise<void>)());
  expect(reports()).toHaveLength(2);
  expect(bridgeMock.readPersonalAgents).toHaveBeenLastCalledWith({ refresh: true });
});
