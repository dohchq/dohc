// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { AddAgentForm } from "./AddAgentForm";

const bridgeMock = {
  runnerSelfTest: vi.fn(),
  detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const FILLED_SETTINGS = settingsWithAgent(
  { name: "Nova", launch: { command: "node agent.mjs" }, enabled: false },
  { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Sam" } },
);

function backdrop(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-dohc-modal="true"]');
  if (!element) throw new Error("overlay backdrop is missing");
  return element;
}

function expectDismissBlocked(onCancel: ReturnType<typeof vi.fn>): void {
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByTestId("chats-add-agent-cancel").hasAttribute("disabled")).toBe(true);
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddAgentForm", () => {
  it("renders inside an overlay that Escape and a press outside dismiss while idle", () => {
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        onError={vi.fn()}
        settings={FILLED_SETTINGS}
        onSave={vi.fn()}
        onDone={vi.fn()}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Add an agent" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(backdrop());
    fireEvent.click(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("blocks Escape while the save is held, then allows it", async () => {
    const user = userEvent.setup();
    const save = deferred<void>();
    const onSave = vi.fn().mockReturnValue(save.promise);
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        onError={vi.fn()}
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

  it("blocks Escape while the self-test is held, then allows it", async () => {
    const user = userEvent.setup();
    const selfTest = deferred<{ ok: boolean; detail: string }>();
    bridgeMock.runnerSelfTest.mockReturnValue(selfTest.promise);
    const onCancel = vi.fn();
    render(
      <AddAgentForm
        workspaceId="ws-1"
        onError={vi.fn()}
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
    expect(bridgeMock.runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "default" });
    expectDismissBlocked(onCancel);

    await act(async () => {
      selfTest.resolve({ ok: true, detail: "The agent replied." });
    });
    expect(screen.getByTestId("chats-add-agent-check-result").dataset.state).toBe("ok");
    expect(screen.getByTestId("chats-add-agent-cancel").hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("puts the title and actions in bands with a rule only while the body overflows", () => {
    // ResizeObservers that report a resize when the test says so.
    const observed = new Set<Element>();
    const live = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe(target: Element) {
          observed.add(target);
          live.add(this.callback);
        }
        disconnect() {
          live.delete(this.callback);
        }
      },
    );
    const report = () => act(() => live.forEach((callback) => callback()));
    render(
      <AddAgentForm
        workspaceId="ws-1"
        onError={vi.fn()}
        settings={FILLED_SETTINGS}
        onSave={vi.fn()}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const form = screen.getByTestId("chats-add-agent");
    const body = screen.getByTestId("chats-add-agent-body");
    const header = screen.getByTestId("chats-add-agent-header");
    const footer = screen.getByTestId("chats-add-agent-footer");
    expect(observed.has(body)).toBe(true);
    let contentHeight = 300;
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => contentHeight });
    const banded = () => form.hasAttribute("data-scrolls") && header.classList.contains("border-b") && footer.classList.contains("border-t");

    report();
    expect(form.hasAttribute("data-scrolls")).toBe(false);
    expect(header.classList.contains("border-b")).toBe(false);
    expect(footer.classList.contains("border-t")).toBe(false);
    expect(form.classList.contains("p-5")).toBe(true);

    contentHeight = 520;
    report();
    expect(banded()).toBe(true);
    // The bands keep the dialog's 20px inset.
    expect(body.classList.contains("px-5")).toBe(true);
    expect(header.classList.contains("px-5") && header.classList.contains("pt-5")).toBe(true);
    expect(footer.classList.contains("px-5") && footer.classList.contains("pb-5")).toBe(true);
    expect(form.classList.contains("p-5")).toBe(false);

    contentHeight = 400;
    report();
    expect(form.hasAttribute("data-scrolls")).toBe(false);
    expect(header.classList.contains("border-b")).toBe(false);
    expect(form.classList.contains("p-5")).toBe(true);
  });
});
