// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ChatDispatchPausedEvent } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type AgentProblem, type DesktopUserSettings } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList, agentListRows } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
const bridgeMock = {
  readChatDispatchPaused: vi.fn(async () => ({ paused: false })),
  onChatDispatchPaused: vi.fn((listener: (event: ChatDispatchPausedEvent) => void) => {
    pausedListener = listener;
    return () => { pausedListener = null; };
  }),
  setChatDispatchPaused: vi.fn(async (_event: ChatDispatchPausedEvent) => undefined),
  runnerSelfTest: vi.fn(async (_payload: { workspaceId: string; agentId: string }) => ({ ok: true, detail: "Runner self-test passed." })),
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
  const onSave = vi.fn(async (_settings: DesktopUserSettings) => true);
  const onError = vi.fn();
  const onOpenSettingsFile = vi.fn();
  const list = (more: Partial<Parameters<typeof AgentList>[0]> = {}) => (
    <AgentList workspaceId="ws-1" settings={SETTINGS} config={null} sessionRecorderOn
      onSave={onSave} onError={onError} onOpenSettingsFile={onOpenSettingsFile} {...fields} {...more} />
  );
  const { rerender } = render(list());
  return { onSave, onError, onOpenSettingsFile, rerender: (more: Partial<Parameters<typeof AgentList>[0]>) => rerender(list(more)) };
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
  const answer = deferred<{ ok: boolean; detail: string }>();
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

it("says an agent didn't reply, sends why to Notices, and offers Try again", async () => {
  bridgeMock.runnerSelfTest.mockResolvedValueOnce({ ok: false, detail: "Runner self-test timed out after 120 seconds." });
  const { onError } = renderList();
  await userEvent.click(within(row("Claude Code")).getByRole("button", { name: "Check" }));
  expect(await within(row("Claude Code")).findByText("Didn't reply.")).toBeTruthy();
  expect(onError).toHaveBeenCalledWith("Runner self-test timed out after 120 seconds.");
  await userEvent.click(within(row("Claude Code")).getByRole("button", { name: "Try again" }));
  expect(bridgeMock.runnerSelfTest).toHaveBeenCalledTimes(2);
});

it("pauses every agent dohc starts, and leaves an agent you run as it is", async () => {
  renderList();
  await userEvent.click(screen.getByRole("button", { name: "Pause all" }));
  expect(bridgeMock.setChatDispatchPaused).toHaveBeenCalledWith({ paused: true });
  act(() => pausedListener?.({ paused: true }));
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(screen.getByTestId("agents-paused").textContent).toBe("Paused until you resume or quit dohc.");
  for (const name of ["Claude Code", "Codex"]) {
    expect(within(row(name)).getByText("Paused")).toBeTruthy();
    expect((within(row(name)).getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);
  }
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

it("says so when dohc could not look for tools, and stops looking", async () => {
  bridgeMock.detectAgentTools.mockRejectedValueOnce(new Error("probe failed"));
  const { onError } = renderList();
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(within(tile("Add Codex")).queryByLabelText("Looking for Codex")).toBeNull();
  expect(tile("Add Codex").disabled).toBe(true);
});
