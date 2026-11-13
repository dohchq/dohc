// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENTS_RESTRICTED_MESSAGE, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { AgentsListeningEvent, ChatChannelRecord, ChatDispatchPausedEvent, PersonalAgent, PersonalAgentChange, PersonalAgentChangeResult, PersonalAgentsAccount, PersonalAgentsEvent, RunnerSelfTestResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings, type DesktopUserSettingsResult } from "../../settings/userSettings";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AgentList } from "./AgentList";

let pausedListener: ((event: ChatDispatchPausedEvent) => void) | null = null;
let _listeningListener: ((event: AgentsListeningEvent) => void) | null = null;

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
  listChatChannels: vi.fn(async (_payload: { workspaceId: string }): Promise<{ channels: ChatChannelRecord[]; fileThreads: [] }> => ({ channels: [], fileThreads: [] })),
  setChatArchived: vi.fn(async (_payload: { workspaceId: string; channelId: string; state: string }): Promise<DesktopUserSettingsResult> => ({ settings: SETTINGS, source: "stored" })),
  readAgentsListening: vi.fn(async (_payload: Record<string, never>): Promise<AgentsListeningEvent> => ({ agentIds: [] })),
  onAgentsListening: vi.fn((listener: (event: AgentsListeningEvent) => void) => {
    _listeningListener = listener;
    return () => { _listeningListener = null; };
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

beforeEach(() => {
  vi.clearAllMocks();
  pausedListener = null;
  _listeningListener = null;
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
// Remove on the agent's page, confirmed in its dialog.
async function removeAgent(name: string) {
  await openAgent(name);
  await userEvent.click(page().getByRole("button", { name: `Remove ${name}…` }));
  await userEvent.click(within(screen.getByTestId("remove-agent-dialog")).getByRole("button", { name: "Remove agent" }));
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

it("removes an agent, and Undo puts it back where it was", async () => {
  const { onSave, onOrder, onNotice } = renderList();
  await removeAgent("Codex");
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

it("leaves an agent that came back after Undo read the file", async () => {
  const { onSave, onOrder, onNotice, onError } = renderList();
  await removeAgent("Codex");
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
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [account([{ ...GROK, name: "Grok" }, NOVA])] });
  renderList({ openAgent: { agentId: GROK_ID } });
  await waitFor(() => expect(screen.getByTestId("agent-page").getAttribute("aria-label")).toBe("Grok"));
});

it("says in the list that the account's agents couldn't be listed, with the cause in a toast", async () => {
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({
    accounts: [{ ...account(), roster: null, failure: "dohc could not reach relay.test. Check your connection." }],
  });
  const { onError } = renderList();
  expect((await screen.findByTestId("personal-agents-retry")).textContent).toContain("dohc could not list your agents on relay.test.");
  await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not reach relay.test. Check your connection.", undefined, expect.any(Function), undefined,
    `personal-agents:${ACCOUNT_KEY}`));
  bridgeMock.readPersonalAgents.mockResolvedValueOnce({ accounts: [account()] });
  await userEvent.click(within(screen.getByTestId("personal-agents-retry")).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(personalIds()).toEqual([GROK_ID, NOVA_ID]));
  expect(bridgeMock.readPersonalAgents).toHaveBeenLastCalledWith({ refresh: true });
  expect(screen.queryByTestId("personal-agents-retry")).toBeNull();
});

function agentChat(id: string, agentId: string, name: string): ChatChannelRecord {
  return { id, name, slug: `agent-${agentId}`, kind: "agent", agentId, createdAtMs: 1, updatedAtMs: 1 } as ChatChannelRecord;
}

it("lists archived agents and removed agents' chats under Archived, with their actions", async () => {
  bridgeMock.listChatChannels.mockResolvedValue({
    channels: [agentChat("chat-codex", "codex", "Codex"), agentChat("chat-gone", "gone", "Old helper"), agentChat("chat-hidden", "hidden", "Hidden")],
    fileThreads: [],
  });
  const settings: DesktopUserSettings = {
    ...SETTINGS,
    sidebar: { ...SETTINGS.sidebar, archivedChats: { "ws-1": ["chat-codex"] }, hiddenChats: { "ws-1": ["chat-hidden"] } },
  };
  const { onNotice } = renderList({ settings });
  const archived = within(await screen.findByTestId("agents-archived"));
  // Codex moves from the main list to Archived; a chat taken off the list stays off.
  expect(screen.queryAllByTestId("agent-row").map((element) => element.getAttribute("aria-label"))).toEqual(["Claude Code", "Claude in Terminal"]);
  expect(archived.getAllByTestId("agent-row-archived").map((element) => element.dataset.agentId)).toEqual(["codex"]);
  expect(archived.getAllByTestId("agent-row-removed").map((element) => element.textContent)).toEqual(["Old helperRemovedRemove from list…"]);

  await userEvent.click(archived.getByRole("button", { name: "Unarchive Codex" }));
  expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", channelId: "chat-codex", state: "active" });

  await userEvent.click(archived.getByRole("button", { name: "Remove Old helper's chat from the list…" }));
  const dialog = within(screen.getByTestId("hide-agent-chat-dialog"));
  expect(dialog.getByText("Its messages stay in this workspace.")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Remove from list" }));
  await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Removed Old helper's chat from the list.", expect.any(Function)));
  expect(bridgeMock.setChatArchived).toHaveBeenLastCalledWith({ workspaceId: "ws-1", channelId: "chat-gone", state: "hidden" });
  onNotice.mock.lastCall![1]!();
  await vi.waitFor(() => expect(bridgeMock.setChatArchived).toHaveBeenLastCalledWith({ workspaceId: "ws-1", channelId: "chat-gone", state: "active" }));

  // An archived agent's page opens from its row, and Remove asks there too.
  await userEvent.click(archived.getByRole("button", { name: "Remove Codex…" }));
  expect(within(screen.getByTestId("remove-agent-dialog")).getByText("Remove Codex?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(archived.getByRole("button", { name: "Codex" }));
  expect(screen.getByTestId("agent-page").dataset.agentId).toBe("codex");
  // Back focuses its row under Archived.
  await back();
  expect(document.activeElement).toBe(within(screen.getByTestId("agents-archived")).getByRole("button", { name: "Codex" }));
});
