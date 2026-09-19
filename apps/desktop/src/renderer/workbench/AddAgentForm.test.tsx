// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { deferred } from "../../testing/deferred";
import { AddAgentForm } from "./AddAgentForm";

const bridgeMock = {
  runnerSelfTest: vi.fn(),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const FILLED_SETTINGS = {
  ...DEFAULT_USER_SETTINGS,
  profile: { preferredName: "Ice", agentName: "Nova" },
  runner: { ...DEFAULT_USER_SETTINGS.runner, command: "node agent.mjs" },
};

function backdrop(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-dohc-modal="true"]');
  if (!element) throw new Error("overlay backdrop is missing");
  return element;
}

function expectDismissBlocked(onCancel: ReturnType<typeof vi.fn>): void {
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(backdrop());
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByTestId("chats-add-agent-cancel").hasAttribute("disabled")).toBe(true);
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

describe("AddAgentForm", () => {
  it("renders inside an overlay that Escape and the backdrop dismiss while idle", () => {
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        settings={FILLED_SETTINGS}
        onSave={vi.fn()}
        onDone={vi.fn()}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Add an agent" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("blocks Escape and the backdrop while the save is held, then allows them", async () => {
    const user = userEvent.setup();
    const save = deferred<void>();
    const onSave = vi.fn().mockReturnValue(save.promise);
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        settings={FILLED_SETTINGS}
        onSave={onSave}
        onDone={onDone}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByTestId("chats-add-agent-submit"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByTestId("chats-add-agent-submit").textContent).toBe("Saving…");
    expectDismissBlocked(onCancel);

    await act(async () => {
      save.resolve();
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(screen.getByTestId("chats-add-agent-cancel").hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("blocks Escape and the backdrop while the self-test is held, then allows them", async () => {
    const user = userEvent.setup();
    const selfTest = deferred<{ ok: boolean; detail: string }>();
    bridgeMock.runnerSelfTest.mockReturnValue(selfTest.promise);
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        settings={FILLED_SETTINGS}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDone={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByTestId("chats-add-agent-check"));
    await waitFor(() =>
      expect(screen.getByTestId("chats-add-agent-check").textContent).toBe("Checking…"),
    );
    expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expectDismissBlocked(onCancel);

    await act(async () => {
      selfTest.resolve({ ok: true, detail: "The agent replied." });
    });
    expect(screen.getByTestId("chats-add-agent-check-result").dataset.state).toBe("ok");
    expect(screen.getByTestId("chats-add-agent-cancel").hasAttribute("disabled")).toBe(false);
    fireEvent.click(backdrop());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
