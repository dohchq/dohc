// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../../settings/userSettings";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import { deferred } from "../../testing/deferred";
import { AddAgentForm } from "./AddAgentForm";

const detected: AgentToolsResult = {
  workingDirectory: "C:\\Work",
  tools: [
    { tool: "claude", executable: "C:\\Tools\\claude.exe", version: "2.1.278", auth: "signed-in", probe: "detected" },
    { tool: "codex", executable: "C:\\Tools\\codex.cmd", version: "0.155.1", auth: "unknown", probe: "detected" },
    { tool: "opencode", executable: "C:\\Tools\\opencode.cmd", version: "1.18.31", auth: "unknown", probe: "detected" },
    { tool: "cursor", executable: null, version: null, auth: "unknown", probe: "not-found" },
  ],
};

function fixture(probe = vi.fn(async () => detected)) {
  const selfTest = vi.fn(async () => ({ ok: true, detail: "The runner answered." }));
  vi.stubGlobal("dohcDesktop", { detectAgentTools: probe, runnerSelfTest: selfTest });
  const props = {
    workspaceId: "workspace-a", settings: { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ice", agentName: "Nova" } },
    onSave: vi.fn(async (_settings: DesktopUserSettings): Promise<void> => undefined), onError: vi.fn(), onDone: vi.fn(), onCancel: vi.fn(),
  };
  return { props, selfTest, probe };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("requires an agent name and saves it alongside the selected tool and owner", async () => {
  const f = fixture();
  render(<AddAgentForm {...f.props} settings={{ ...f.props.settings, profile: { preferredName: "Ice" } }} />);
  await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
  expect(screen.getByTestId("chats-add-agent-submit").hasAttribute("disabled")).toBe(true);
  await userEvent.type(screen.getByLabelText("Agent name"), "Nova");
  expect(screen.getByTestId("chats-add-agent-preview").textContent).toBe("Posts as Nova");
  await userEvent.click(screen.getByTestId("chats-add-agent-submit"));
  await waitFor(() => expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ profile: { preferredName: "Ice", agentName: "Nova" }, runner: expect.objectContaining({ profile: { tool: "codex", executable: "C:\\Tools\\codex.cmd" }, enabled: true }) })));
});

it("preserves the saved command when selecting a profile and can restore it", async () => {
  const f = fixture();
  const settings = { ...f.props.settings, runner: { ...f.props.settings.runner, command: "node custom.mjs" } };
  const view = render(<AddAgentForm {...f.props} settings={settings} />);
  await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
  await userEvent.click(screen.getByTestId("chats-add-agent-check"));
  await waitFor(() => expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ runner: expect.objectContaining({ command: "node custom.mjs", profile: { tool: "codex", executable: "C:\\Tools\\codex.cmd" } }) })));
  const saved = f.props.onSave.mock.calls[0]![0];
  view.unmount();
  render(<AddAgentForm {...f.props} settings={saved} />);
  await userEvent.click(screen.getByText("Advanced"));
  await userEvent.click(screen.getByRole("button", { name: "Use saved command" }));
  expect((screen.getByLabelText("Runner command") as HTMLInputElement).value).toBe("node custom.mjs");
});

it("keeps the form open while saving and checking", async () => {
  const f = fixture();
  const save = deferred<void>();
  const check = deferred<{ ok: boolean; detail: string }>();
  f.props.onSave.mockReturnValue(save.promise);
  f.selfTest.mockReturnValue(check.promise);
  render(<AddAgentForm {...f.props} />);
  await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
  await userEvent.click(screen.getByTestId("chats-add-agent-check"));
  const backdrop = screen.getByTestId("chats-add-agent").closest('[data-dohc-modal="true"]')!;
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(backdrop);
  expect(f.props.onCancel).not.toHaveBeenCalled();
  await act(async () => { save.resolve(); });
  await waitFor(() => expect(f.selfTest).toHaveBeenCalled());
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(backdrop);
  expect(f.props.onCancel).not.toHaveBeenCalled();
  await act(async () => { check.resolve({ ok: true, detail: "Ready" }); });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(f.props.onCancel).toHaveBeenCalledOnce();
});

it("requires an update before selecting an older Claude profile", async () => {
  const f = fixture(vi.fn(async () => ({ ...detected, tools: detected.tools.map((tool) => tool.tool === "claude" ? { ...tool, version: "2.1.258" } : tool) })));
  render(<AddAgentForm {...f.props} />);
  await screen.findByText("Update Claude Code to 2.1.259 or later to use this profile.");
  expect(screen.getByRole("button", { name: "Claude Code" }).hasAttribute("disabled")).toBe(true);
});

it.each(["Claude Code", "Codex"])("saves %s as a profile and checks through the existing runner", async (name) => {
  const f = fixture();
  render(<AddAgentForm {...f.props} />);
  await userEvent.click(await screen.findByRole("button", { name }));
  expect(screen.getByText("Conversation through stdin")).toBeTruthy();
  expect(screen.getByText("Tool configuration only. dohc adds no servers.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "OpenCode" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByTestId("chats-add-agent-check-result")).toBeNull();
  await userEvent.click(screen.getByTestId("chats-add-agent-check"));
  await waitFor(() => expect(f.selfTest).toHaveBeenCalledWith({ workspaceId: "workspace-a" }));
  expect(f.props.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ runner: expect.objectContaining({
    command: "", enabled: true, profile: { tool: name === "Codex" ? "codex" : "claude", executable: name === "Codex" ? "C:\\Tools\\codex.cmd" : "C:\\Tools\\claude.exe" },
  }) }));
  expect((await screen.findByTestId("chats-add-agent-check-result")).textContent).toBe("The runner answered.");
});

it("editing the Advanced command removes the profile and its permission claim", async () => {
  const f = fixture();
  render(<AddAgentForm {...f.props} />);
  await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
  await userEvent.click(screen.getByText("Advanced"));
  fireEvent.change(screen.getByLabelText("Runner command"), { target: { value: "node custom.mjs" } });
  expect(screen.queryByText("Workspace-write sandbox. Runs without approval prompts.")).toBeNull();
  await userEvent.click(screen.getByTestId("chats-add-agent-submit"));
  await waitFor(() => expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ runner: expect.objectContaining({ command: "node custom.mjs", profile: undefined }) })));
});

it("ignores detection and checks that finish after a workspace switch", async () => {
  const pending = deferred<AgentToolsResult>();
  const f = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ workingDirectory: "/workspace-b", tools: [] }));
  const view = render(<AddAgentForm {...f.props} />);
  view.rerender(<AddAgentForm {...f.props} workspaceId="workspace-b" />);
  await screen.findByText("Choose an installed tool");
  await act(async () => { pending.resolve(detected); });
  expect(screen.queryByText("Detected · 0.155.1")).toBeNull();
  expect(f.props.onError).not.toHaveBeenCalled();
});

it("reports detection failures to the shell and can refresh", async () => {
  const f = fixture(vi.fn().mockRejectedValueOnce(new Error("probe failed")).mockResolvedValue(detected));
  render(<AddAgentForm {...f.props} />);
  await waitFor(() => expect(f.props.onError).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Detected · 2.1.278");
});

it("keeps a cleared Advanced command open and preserves drafts across equivalent settings broadcasts", async () => {
  const f = fixture();
  const settings = { ...f.props.settings, runner: { ...f.props.settings.runner, profile: { tool: "codex" as const, executable: "C:\\Tools\\codex.cmd" } } };
  const view = render(<AddAgentForm {...f.props} settings={settings} />);
  await userEvent.click(screen.getByText("Advanced"));
  const input = screen.getByLabelText("Runner command");
  fireEvent.change(input, { target: { value: "" } });
  expect(input.closest("details")?.open).toBe(true);
  fireEvent.change(input, { target: { value: "node draft.mjs" } });
  view.rerender(<AddAgentForm {...f.props} settings={structuredClone(settings)} />);
  expect((input as HTMLInputElement).value).toBe("node draft.mjs");
  expect(input.closest("details")?.open).toBe(true);
});
