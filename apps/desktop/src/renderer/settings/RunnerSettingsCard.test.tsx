// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSettings } from "../../settings/userSettings";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type AgentFields = Pick<AgentSettings, "launch" | "enabled" | "timeoutMinutes">;

// Agent dispatch runs; no window or tray pauses it.
const dispatchRunning = {
  readChatDispatchPaused: async () => ({ paused: false }),
  onChatDispatchPaused: () => () => undefined,
};

it("preserves a newer command draft when a pending profile save rolls back", async () => {
  vi.stubGlobal("dohcDesktop", { ...dispatchRunning, detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [
    { tool: "codex", executable: "/tools/codex", version: "0.155.1", auth: "signed-in", probe: "detected" },
  ] })) });
  const pending = deferred<void>();
  const initial = testAgent({ launch: { command: "node old.mjs" }, enabled: false });
  const saved = vi.fn<(fields: AgentFields) => void>();
  function Settings() {
    const [agent, setAgent] = useState(initial);
    return <RunnerSettingsCard workspaceId="workspace" agent={agent} sessionRecorderOn onAgentChange={async (fields) => {
      saved(fields);
      setAgent({ ...agent, ...fields });
      if (fields.launch && "tool" in fields.launch) {
        try { await pending.promise; } catch { setAgent(initial); }
      }
    }} />;
  }
  render(<Settings />);
  await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const input = screen.getByTestId("runner-command-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "node newer.mjs" } });
  await act(async () => { pending.reject(new Error("save failed")); });
  expect(input.value).toBe("node newer.mjs");
  expect(screen.getByRole("button", { name: "Codex" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.blur(input);
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ launch: { command: "node newer.mjs" } })));
});

it("keeps the timeout draft when a tool is chosen, and a typed command replaces the tool", async () => {
  vi.stubGlobal("dohcDesktop", { ...dispatchRunning, detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [
    { tool: "codex", executable: "/tools/codex", version: "0.155.1", auth: "signed-in", probe: "detected" },
  ] })) });
  const saved = vi.fn<(fields: AgentFields) => void>();
  function Settings() {
    const [agent, setAgent] = useState(testAgent({ launch: { command: "node custom.mjs" }, enabled: false }));
    return <RunnerSettingsCard workspaceId="workspace" agent={agent} sessionRecorderOn onAgentChange={async (fields) => { saved(fields); setAgent({ ...agent, ...fields }); }} />;
  }
  render(<Settings />);
  await screen.findByText("Detected · 0.155.1");
  const timeout = screen.getByTestId("runner-timeout-input");
  fireEvent.focus(timeout);
  fireEvent.change(timeout, { target: { value: "45" } });
  // Blur and click can queue saves before the parent receives either result.
  fireEvent.blur(timeout);
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith({ launch: { tool: "codex", executable: "/tools/codex" }, enabled: false, timeoutMinutes: 45 }));
  const input = screen.getByTestId("runner-command-input") as HTMLInputElement;
  expect(input.value).toContain("/tools/codex");
  fireEvent.change(input, { target: { value: "node other.mjs" } });
  fireEvent.blur(input);
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith({ launch: { command: "node other.mjs" }, enabled: false, timeoutMinutes: 45 }));
  expect(screen.getByRole("button", { name: "Codex" }).getAttribute("aria-pressed")).toBe("false");
});

it("puts the saved command back when the command is cleared", async () => {
  vi.stubGlobal("dohcDesktop", { ...dispatchRunning, detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })) });
  const saved = vi.fn<(fields: AgentFields) => Promise<void>>(async () => undefined);
  render(<RunnerSettingsCard workspaceId="workspace" agent={testAgent({ launch: { command: "node run.mjs" } })} sessionRecorderOn onAgentChange={saved} />);
  const input = screen.getByTestId("runner-command-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "  " } });
  fireEvent.blur(input);
  await waitFor(() => expect(input.value).toBe("node run.mjs"));
  expect(saved).not.toHaveBeenCalled();
});

it("reports a failed self-test with the error it came from, so Copy keeps it", async () => {
  const refused = new Error(
    "Error invoking remote method 'desktop:runner-self-test': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
  );
  vi.stubGlobal("dohcDesktop", { ...dispatchRunning,
    detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
    runnerSelfTest: vi.fn(async () => { throw refused; }),
  });
  const onError = vi.fn<(message: string, cause?: unknown) => void>();
  render(<RunnerSettingsCard workspaceId="workspace" agent={testAgent({ launch: { command: "node run.mjs" }, enabled: false })}
    agentName="Agent" sessionRecorderOn onAgentChange={async () => undefined} onError={onError} />);
  await userEvent.click(screen.getByTestId("runner-self-test-button"));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledWith(
    "Runner self-test could not start. dohc is still reading this workspace's files. Try again when it finishes.",
    refused,
  );
});

function dispatchPauseBridge(read: Promise<{ paused: boolean }> = Promise.resolve({ paused: false })) {
  const listeners = new Set<(event: { paused: boolean }) => void>();
  const push = (paused: boolean) => { for (const listener of [...listeners]) listener({ paused }); };
  return {
    push,
    bridge: {
      detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
      readChatDispatchPaused: () => read,
      onChatDispatchPaused: (listener: (event: { paused: boolean }) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      setChatDispatchPaused: vi.fn(async ({ paused }: { paused: boolean }) => push(paused)),
    },
  };
}
const enabledAgent = testAgent({ launch: { command: "node run.mjs" } });

it("pauses and resumes agent dispatch, and shows a resume from the tray", async () => {
  const { bridge, push } = dispatchPauseBridge();
  vi.stubGlobal("dohcDesktop", bridge);
  render(<RunnerSettingsCard workspaceId="workspace" agent={enabledAgent} sessionRecorderOn onAgentChange={async () => undefined} />);

  await userEvent.click(screen.getByRole("button", { name: "Pause agent dispatch" }));
  expect(bridge.setChatDispatchPaused).toHaveBeenCalledWith({ paused: true });
  expect(screen.getByTestId("runner-dispatch-state").textContent).toBe("Paused until you resume or quit dohc.");

  act(() => push(false));
  expect(screen.getByRole("button", { name: "Pause agent dispatch" }).textContent).toBe("Pause");
  expect(screen.getByTestId("runner-dispatch-state").textContent).toBe("Runs in the background.");
});

it("keeps a pause pushed before the first read answers", async () => {
  const read = deferred<{ paused: boolean }>();
  const { bridge, push } = dispatchPauseBridge(read.promise);
  vi.stubGlobal("dohcDesktop", bridge);
  render(<RunnerSettingsCard workspaceId="workspace" agent={enabledAgent} sessionRecorderOn onAgentChange={async () => undefined} />);

  act(() => push(true));
  await act(async () => { read.resolve({ paused: false }); });
  expect(screen.getByRole("button", { name: "Resume agent dispatch" }).textContent).toBe("Resume");
});

it("offers no pause while dispatch is off, and reports a pause that fails", async () => {
  const { bridge } = dispatchPauseBridge();
  bridge.setChatDispatchPaused.mockRejectedValueOnce(new Error("main is gone"));
  vi.stubGlobal("dohcDesktop", bridge);
  const onError = vi.fn<(message: string, cause?: unknown) => void>();
  const { rerender } = render(<RunnerSettingsCard workspaceId="workspace" agent={{ ...enabledAgent, enabled: false }} sessionRecorderOn onAgentChange={async () => undefined} onError={onError} />);
  expect(screen.queryByRole("button", { name: "Pause agent dispatch" })).toBeNull();

  rerender(<RunnerSettingsCard workspaceId="workspace" agent={enabledAgent} sessionRecorderOn onAgentChange={async () => undefined} onError={onError} />);
  await userEvent.click(screen.getByRole("button", { name: "Pause agent dispatch" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not pause agent dispatch. main is gone", expect.any(Error)));
  expect(screen.getByTestId("runner-dispatch-state").textContent).toBe("Runs in the background.");
});
