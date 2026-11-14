// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentThreadLine, AgentThreadLinesEvent } from "../../ipc/bridgeContract";
import {
  DEFAULT_USER_SETTINGS,
  type AgentSettings,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { deferred } from "../../testing/deferred";
import type { ReportShellFailure } from "../shell/useShellError";
import { AgentThreadLines, AgentThreadLinesProvider } from "./AgentThreadLines";

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

const agent = (name: string, more: Partial<AgentSettings> = {}): AgentSettings => ({
  name,
  hue: "olive",
  thread: { tool: "t3-code", id: `t3-${name}` },
  workspaces: ["ws-a"],
  changesFiles: true,
  enabled: true,
  timeoutMinutes: 30,
  ...more,
});
const settingsWith = (agents: DesktopUserSettings["agents"]): DesktopUserSettings => ({
  ...DEFAULT_USER_SETTINGS,
  agents,
});
const NOVA = settingsWith({ nova: agent("Nova") });

const line = (more: Partial<AgentThreadLine> = {}): AgentThreadLine => ({
  agentId: "nova",
  chatThreadId: "thread-1",
  forwardedAtMs: 0,
  questionId: null,
  threadWaiting: false,
  state: "working",
  sinceMs: NOW - 4_000,
  ...more,
});

function stubDesktop() {
  const listeners = new Set<(event: AgentThreadLinesEvent) => void>();
  const reads: Array<{
    workspaceId: string;
    answer: ReturnType<typeof deferred<AgentThreadLinesEvent>>;
  }> = [];
  let revision = 0;
  const desktop = {
    readAgentThreadLines: vi.fn(({ workspaceId }: { workspaceId: string }) => {
      const answer = deferred<AgentThreadLinesEvent>();
      reads.push({ workspaceId, answer });
      return answer.promise;
    }),
    onAgentThreadLines: vi.fn((listener: (event: AgentThreadLinesEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    openAgentThread: vi.fn(async (_input: { workspaceId: string; agentId: string }) => undefined),
  };
  vi.stubGlobal("dohcDesktop", desktop);
  return {
    desktop,
    listeners,
    reads,
    push: (lines: AgentThreadLine[], workspaceId = "ws-a") =>
      act(() => {
        revision += 1;
        for (const listener of [...listeners]) listener({ workspaceId, revision, lines });
      }),
  };
}

const report = vi.fn<ReportShellFailure>();
const clear = vi.fn<(identity: string) => void>();

function chat(
  props: {
    workspaceId?: string;
    shown?: string;
    settings?: DesktopUserSettings | null;
    ready?: boolean;
    chatThreadIds?: readonly (string | null)[];
  } = {},
) {
  const workspaceId = props.workspaceId ?? "ws-a";
  return (
    <AgentThreadLinesProvider
      workspaceId={workspaceId}
      ready={props.ready ?? true}
      settings={props.settings === undefined ? NOVA : props.settings}
      report={report}
      clear={clear}
    >
      <AgentThreadLines
        workspaceId={props.shown ?? workspaceId}
        chatThreadIds={props.chatThreadIds ?? ["thread-1"]}
      />
    </AgentThreadLinesProvider>
  );
}

const hideWindow = (hidden: boolean) =>
  act(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

afterEach(() => {
  cleanup();
  report.mockReset();
  clear.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

it("shows a line for the chat thread on screen, and none for another chat thread", () => {
  const { push } = stubDesktop();
  render(chat());
  expect(screen.queryByTestId("agent-thread-lines")).toBeNull();

  push([line({ chatThreadId: "thread-2" })]);
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();

  push([line({ chatThreadId: "thread-2" }), line({ state: "in-line" })]);
  const shown = screen.getByTestId("agent-thread-line");
  expect(shown.dataset.state).toBe("in-line");
  expect(within(shown).getByRole("status").textContent).toContain("Nova");

  // The agent replied here: its line goes.
  push([line({ chatThreadId: "thread-2" })]);
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();
});

it.each([
  ["in-line", "In line in T3 Code"],
  ["working", "Working"],
  ["waiting-in-tool", "Waiting for you in T3 Code"],
  ["silent", "Finished without replying here"],
] as const)("says what a thread that is %s is doing", (state, words) => {
  const { push } = stubDesktop();
  render(chat());
  push([line({ state })]);
  const status = screen.getByRole("status");
  expect(within(status).getByText(words)).toBeTruthy();
  expect(within(status).getByText("Nova")).toBeTruthy();
});

it("offers Answer here only while the thread waits on a question", () => {
  const { push } = stubDesktop();
  render(chat());
  const buttons = () => screen.getAllByRole("button").map((button) => button.textContent);

  // An approval, say, is answered in the tool.
  push([line({ state: "waiting-in-tool", threadWaiting: true })]);
  expect(buttons()).toEqual(["Open in T3 Code"]);

  push([line({ state: "waiting-in-tool", threadWaiting: true, questionId: "question-1" })]);
  expect(buttons()).toEqual(["Answer here", "Open in T3 Code"]);
  expect(within(screen.getByRole("status")).getByText("Waiting for you in T3 Code")).toBeTruthy();

  push([line({ state: "working" })]);
  expect(buttons()).toEqual(["Open in T3 Code"]);
});

it("says when a message is in line behind work that waits on the person, and offers its question", () => {
  const { push } = stubDesktop();
  render(chat());
  const buttons = () => screen.getAllByRole("button").map((button) => button.textContent);
  const words = () => within(screen.getByRole("status")).getByText(/line/i).textContent;

  push([line({ state: "in-line" })]);
  expect(words()).toBe("In line in T3 Code");
  expect(buttons()).toEqual(["Open in T3 Code"]);

  // The work ahead of it waits on an approval: the line will not move until the person acts there.
  push([line({ state: "in-line", threadWaiting: true })]);
  expect(words()).toBe("In line. The thread is waiting for you in T3 Code");
  expect(buttons()).toEqual(["Open in T3 Code"]);

  // It waits on a question: answering it here is what moves the line.
  push([line({ state: "in-line", threadWaiting: true, questionId: "question-1" })]);
  expect(buttons()).toEqual(["Answer here", "Open in T3 Code"]);
});

it("shows nothing for another workspace's lines", async () => {
  const { push, reads } = stubDesktop();
  const view = render(chat());
  push([line()], "ws-b");
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();

  // A chat of another workspace never borrows this workspace's lines.
  push([line()]);
  expect(screen.getByTestId("agent-thread-line")).toBeTruthy();
  view.rerender(chat({ shown: "ws-b" }));
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();

  // The window moved on: the first workspace's slow read paints nothing.
  const moved = settingsWith({ nova: agent("Nova", { workspaces: ["ws-a", "ws-b"] }) });
  view.rerender(chat({ workspaceId: "ws-b", settings: moved }));
  expect(reads.map((read) => read.workspaceId)).toEqual(["ws-a", "ws-b"]);
  await act(async () => {
    reads[0]!.answer.resolve({ workspaceId: "ws-a", revision: 90, lines: [line()] });
    await Promise.resolve();
  });
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();
  await act(async () => {
    reads[1]!.answer.resolve({
      workspaceId: "ws-b",
      revision: 91,
      lines: [line({ state: "silent" })],
    });
    await Promise.resolve();
  });
  expect(screen.getByTestId("agent-thread-line").dataset.state).toBe("silent");
});

it("counts the time a state has lasted, outside the status, and stops with the line", async () => {
  vi.useFakeTimers({ now: NOW });
  const { push } = stubDesktop();
  const view = render(chat());
  push([line()]);
  const elapsed = screen.getByTestId("agent-thread-line-elapsed");
  expect(elapsed.textContent).toBe("4s");
  // A screen reader hears the state once, not each second.
  expect(screen.getByRole("status").contains(elapsed)).toBe(false);

  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(elapsed.textContent).toBe("7s");
  await act(() => vi.advanceTimersByTimeAsync(74_000));
  expect(elapsed.textContent).toBe("1m 21s");

  // A new state counts from its own start.
  push([line({ state: "silent", sinceMs: Date.now() - 2_000 })]);
  expect(screen.getByTestId("agent-thread-line-elapsed").textContent).toBe("2s");

  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps no timer while the window is hidden, and catches up when it shows", async () => {
  vi.useFakeTimers({ now: NOW });
  const { push } = stubDesktop();
  render(chat());
  push([line()]);
  hideWindow(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  hideWindow(false);
  expect(screen.getByTestId("agent-thread-line-elapsed").textContent).toBe("1m 4s");
  expect(vi.getTimerCount()).toBe(1);
});

it("repaints each minute once a state has lasted an hour", async () => {
  vi.useFakeTimers({ now: NOW });
  const { push } = stubDesktop();
  render(chat());
  push([line({ sinceMs: NOW - 3_600_000 })]);
  const elapsed = screen.getByTestId("agent-thread-line-elapsed");
  expect(elapsed.textContent).toBe("1h 0m");
  const repaints = vi.spyOn(window, "setTimeout");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(elapsed.textContent).toBe("1h 1m");
  expect(repaints.mock.calls.map(([, delay]) => delay)).toEqual([60_000]);
});

it("shows one line for each agent, with its newest state", () => {
  const { push } = stubDesktop();
  const two = settingsWith({ nova: agent("Nova"), scout: agent("Scout", { hue: "plum" }) });
  render(chat({ settings: two, chatThreadIds: ["thread-1", "post-1", null] }));
  push([
    line({ agentId: "scout", state: "waiting-in-tool" }),
    // The older message's state began later. The newer message's line still shows.
    line({ state: "silent", sinceMs: NOW - 1_000, forwardedAtMs: NOW - 60_000 }),
    line({
      chatThreadId: "post-1",
      state: "working",
      sinceMs: NOW - 5_000,
      forwardedAtMs: NOW - 6_000,
    }),
    // An agent that Settings no longer lists has no line.
    line({ agentId: "gone" }),
  ]);
  const lines = screen.getAllByTestId("agent-thread-line");
  expect(lines.map((shown) => [shown.dataset.agentId, shown.dataset.state])).toEqual([
    ["nova", "working"],
    ["scout", "waiting-in-tool"],
  ]);
});

it("opens the agent's thread, and reports a refusal with Try again", async () => {
  const { desktop, push } = stubDesktop();
  render(chat());
  push([line({ state: "waiting-in-tool" })]);
  const failure = new Error("T3 Code is not running. Open it, then try again.");
  desktop.openAgentThread.mockRejectedValueOnce(failure);
  fireEvent.click(screen.getByRole("button", { name: "Open in T3 Code" }));
  expect(desktop.openAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-a",
    agentId: "nova",
  });
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  const reported = report.mock.calls[0]![0];
  expect(reported.message).toBe(
    "dohc could not open Nova's thread in T3 Code. T3 Code is not running. Open it, then try again.",
  );
  expect(reported.cause).toBe(failure);
  expect(clear).not.toHaveBeenCalled();

  // Try again opens it, which takes the failure's notice back.
  await act(async () => reported.retry?.());
  expect(desktop.openAgentThread).toHaveBeenCalledTimes(2);
  expect(clear).toHaveBeenCalledExactlyOnceWith(reported.identity);
  expect(report).toHaveBeenCalledOnce();
});

it("reports nothing about a thread once the window shows another workspace", async () => {
  const { desktop, push } = stubDesktop();
  const view = render(chat());
  push([line()]);
  const opening = deferred<undefined>();
  desktop.openAgentThread.mockReturnValueOnce(opening.promise);
  fireEvent.click(screen.getByTestId("agent-thread-open"));
  view.rerender(chat({ workspaceId: "ws-b" }));
  await act(async () => {
    opening.reject(new Error("T3 Code is not running."));
    await Promise.resolve();
  });
  expect(report).not.toHaveBeenCalled();
});

it("reports a failed read of the lines with a retry", async () => {
  const { reads } = stubDesktop();
  render(chat());
  const failure = new Error("main refused");
  await act(async () => {
    reads[0]!.answer.reject(failure);
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  const reported = report.mock.calls[0]![0];
  expect(reported.cause).toBe(failure);
  act(() => reported.retry?.());
  await act(async () => {
    reads[1]!.answer.resolve({ workspaceId: "ws-a", revision: 1, lines: [line()] });
    await Promise.resolve();
  });
  expect(screen.getByTestId("agent-thread-line")).toBeTruthy();
});

it.each([
  ["has no agent", settingsWith({})],
  [
    "has only an agent dohc starts",
    settingsWith({
      runner: {
        name: "Runner",
        hue: "olive",
        launch: { command: "runner" },
        changesFiles: true,
        enabled: true,
        timeoutMinutes: 30,
      } as AgentSettings,
    }),
  ],
  ["has its thread's agent turned off", settingsWith({ nova: agent("Nova", { enabled: false }) })],
  ["is not one the agent serves", settingsWith({ nova: agent("Nova", { workspaces: ["ws-z"] }) })],
  ["has no settings yet", null],
])("reads and listens to nothing when the workspace %s", (_why, settings) => {
  const { desktop, listeners } = stubDesktop();
  render(chat({ settings }));
  expect(desktop.readAgentThreadLines).not.toHaveBeenCalled();
  expect(desktop.onAgentThreadLines).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
  expect(screen.queryByTestId("agent-thread-lines")).toBeNull();
});

it("reads once for a workspace, however many chats show, and not before it is ready", () => {
  const { desktop, listeners } = stubDesktop();
  const view = render(chat({ ready: false }));
  expect(desktop.readAgentThreadLines).not.toHaveBeenCalled();
  const both = (
    <AgentThreadLinesProvider
      workspaceId="ws-a"
      ready
      settings={NOVA}
      report={report}
      clear={clear}
    >
      <AgentThreadLines workspaceId="ws-a" chatThreadIds={["thread-1"]} />
      <AgentThreadLines workspaceId="ws-a" chatThreadIds={["thread-2"]} />
    </AgentThreadLinesProvider>
  );
  view.rerender(both);
  view.rerender(both);
  expect(desktop.readAgentThreadLines).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("drops its lines when the agent is turned off", () => {
  const { push, listeners } = stubDesktop();
  const view = render(chat());
  push([line()]);
  expect(screen.getByTestId("agent-thread-line")).toBeTruthy();
  view.rerender(chat({ settings: settingsWith({ nova: agent("Nova", { enabled: false }) }) }));
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();
  expect(listeners.size).toBe(0);
});
