// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_RUNNER_SETTINGS, type RunnerSettings } from "../../settings/userSettings";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { deferred } from "../../testing/deferred";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("preserves a newer command draft when a pending profile save rolls back", async () => {
  vi.stubGlobal("dohcDesktop", { detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [
    { tool: "codex", executable: "/tools/codex", version: "0.155.1", auth: "signed-in", probe: "detected" },
  ] })) });
  const pending = deferred<void>();
  const initial = { ...DEFAULT_RUNNER_SETTINGS, command: "node old.mjs" };
  const saved = vi.fn<(runner: RunnerSettings) => void>();
  function Settings() {
    const [runner, setRunner] = useState(initial);
    return <RunnerSettingsCard workspaceId="workspace" runner={runner} sessionRecorderOn onRunnerChange={async (value) => {
      saved(value);
      setRunner(value);
      if (value.profile) {
        try { await pending.promise; } catch { setRunner(initial); }
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
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ command: "node newer.mjs", profile: undefined })));
});

it("retains the timeout draft and saved command through profile selection and restoration", async () => {
  vi.stubGlobal("dohcDesktop", { detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [
    { tool: "codex", executable: "/tools/codex", version: "0.155.1", auth: "signed-in", probe: "detected" },
  ] })) });
  const saved = vi.fn<(runner: RunnerSettings) => void>();
  function Settings() {
    const [runner, setRunner] = useState({ ...DEFAULT_RUNNER_SETTINGS, command: "node custom.mjs" });
    return <RunnerSettingsCard workspaceId="workspace" runner={runner} sessionRecorderOn onRunnerChange={async (value) => { saved(value); setRunner(value); }} />;
  }
  render(<Settings />);
  await screen.findByText("Detected · 0.155.1");
  const timeout = screen.getByTestId("runner-timeout-input");
  fireEvent.focus(timeout);
  fireEvent.change(timeout, { target: { value: "45" } });
  // Blur and click can queue saves before the parent receives either result.
  fireEvent.blur(timeout);
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ command: "node custom.mjs", timeoutMinutes: 45, profile: { tool: "codex", executable: "/tools/codex" } })));
  expect((screen.getByTestId("runner-command-input") as HTMLInputElement).value).toContain("/tools/codex");
  await userEvent.click(screen.getByRole("button", { name: "Use saved command" }));
  await waitFor(() => expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ command: "node custom.mjs", timeoutMinutes: 45, profile: undefined })));
  expect((screen.getByTestId("runner-command-input") as HTMLInputElement).value).toBe("node custom.mjs");
});
