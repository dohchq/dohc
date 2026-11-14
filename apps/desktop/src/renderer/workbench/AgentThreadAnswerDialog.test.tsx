// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentThreadAnswers,
  AgentThreadLine,
  AgentThreadLinesEvent,
  AgentThreadQuestion,
  AgentThreadQuestionBox,
} from "../../ipc/bridgeContract";
import {
  DEFAULT_USER_SETTINGS,
  type AgentSettings,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { deferred } from "../../testing/deferred";
import type { ReportShellFailure } from "../shell/useShellError";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { AgentThreadLines, AgentThreadLinesProvider } from "./AgentThreadLines";

const nova = (workspaces: string[]): AgentSettings => ({
  name: "Nova",
  hue: "olive",
  thread: { tool: "t3-code", id: "t3-nova" },
  workspaces,
  changesFiles: true,
  enabled: true,
  timeoutMinutes: 30,
});
const settingsFor = (...workspaces: string[]): DesktopUserSettings => ({
  ...DEFAULT_USER_SETTINGS,
  agents: { nova: nova(workspaces) },
});

const line = (more: Partial<AgentThreadLine> = {}): AgentThreadLine => ({
  agentId: "nova",
  chatThreadId: "thread-1",
  forwardedAtMs: 0,
  questionId: "q-1",
  state: "waiting-in-tool",
  sinceMs: 0,
  ...more,
});

const question = (more: Partial<AgentThreadQuestion> = {}): AgentThreadQuestion => ({
  id: "branch",
  header: "",
  question: "Which branch should I use?",
  options: [
    { label: "Rebase", description: "Replay your commits on main", value: "rebase-value" },
    { label: "Merge", description: "", value: "merge-value" },
  ],
  multiSelect: false,
  allowCustomAnswer: false,
  required: true,
  ...more,
});
const openBox = (...questions: AgentThreadQuestion[]): AgentThreadQuestionBox => ({
  status: "open",
  requestId: "q-1",
  questions,
});

type Target = { workspaceId: string; agentId: string; requestId: string };
type Sent = { status: "answered" | "already-answered" | "closed" };

function stubDesktop() {
  const listeners = new Set<(event: AgentThreadLinesEvent) => void>();
  const reads: Array<{
    input: Target;
    answer: ReturnType<typeof deferred<AgentThreadQuestionBox>>;
  }> = [];
  const sends: Array<{
    input: Target & { answers: AgentThreadAnswers };
    answer: ReturnType<typeof deferred<Sent>>;
  }> = [];
  let revision = 0;
  const desktop = {
    // The lines come by push alone here.
    readAgentThreadLines: vi.fn(() => new Promise<AgentThreadLinesEvent>(() => undefined)),
    onAgentThreadLines: vi.fn((listener: (event: AgentThreadLinesEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    openAgentThread: vi.fn(async (_input: { workspaceId: string; agentId: string }) => undefined),
    readAgentThreadQuestion: vi.fn((input: Target) => {
      const answer = deferred<AgentThreadQuestionBox>();
      reads.push({ input, answer });
      return answer.promise;
    }),
    answerAgentThreadQuestion: vi.fn((input: Target & { answers: AgentThreadAnswers }) => {
      const answer = deferred<Sent>();
      sends.push({ input, answer });
      return answer.promise;
    }),
  };
  vi.stubGlobal("dohcDesktop", desktop);
  return {
    desktop,
    reads,
    sends,
    push: (lines: AgentThreadLine[], workspaceId = "ws-a") =>
      act(() => {
        revision += 1;
        for (const listener of [...listeners]) listener({ workspaceId, revision, lines });
      }),
  };
}

const report = vi.fn<ReportShellFailure>();

function chat(workspaceId = "ws-a") {
  return (
    <AgentThreadLinesProvider
      workspaceId={workspaceId}
      ready
      settings={settingsFor("ws-a", "ws-b")}
      report={report}
      clear={vi.fn()}
    >
      <WorkspaceSessionProvider workspaceId={workspaceId}>
        <AgentThreadLines workspaceId={workspaceId} chatThreadIds={["thread-1"]} />
      </WorkspaceSessionProvider>
    </AgentThreadLinesProvider>
  );
}

// Settles a read or a send, and lets the dialog take the answer.
const settle = (run: () => void) =>
  act(async () => {
    run();
    await Promise.resolve();
    await Promise.resolve();
  });

/** A chat whose line waits on a question, with Answer here pressed and the read still out. */
function asking() {
  const stub = stubDesktop();
  const view = render(chat());
  stub.push([line()]);
  fireEvent.click(screen.getByRole("button", { name: "Answer here" }));
  return { ...stub, view };
}

/** The same, with the question box read. */
async function answering(...questions: AgentThreadQuestion[]) {
  const stub = asking();
  await settle(() => stub.reads[0]!.answer.resolve(openBox(...questions)));
  return stub;
}

const dialog = () => screen.getByRole("dialog", { name: "Answer Nova" });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Answer" }));

afterEach(() => {
  cleanup();
  report.mockReset();
  vi.unstubAllGlobals();
});

it("reads the question of the line's workspace, agent and request, and holds its place while it reads", async () => {
  const { reads, sends } = asking();
  expect(reads.map((read) => read.input)).toEqual([
    { workspaceId: "ws-a", agentId: "nova", requestId: "q-1" },
  ]);
  expect(dialog().dataset.view).toBe("loading");
  expect(within(dialog()).getByRole("status").textContent).toBe("Loading the question");
  // Nothing can be sent before the question shows.
  send();
  expect(sends).toHaveLength(0);

  await settle(() => reads[0]!.answer.resolve(openBox(question())));
  expect(dialog().dataset.view).toBe("form");
  expect(screen.queryByTestId("agent-thread-answer-loading")).toBeNull();
  expect(screen.getByRole("radiogroup", { name: "Which branch should I use?" })).toBeTruthy();
});

it("shows a question's header, its words as plain text with their line breaks, and each option's description", async () => {
  const words = "Pick one.\n<b>Not bold</b>\n**Not Markdown**";
  await answering(question({ header: "Branch", question: words }));
  const shown = within(dialog()).getByTestId("agent-thread-answer-question");
  expect(within(shown).getByText("Branch")).toBeTruthy();
  const text = shown.querySelector("p > span")!;
  expect(text.textContent).toBe(words);
  expect(text.className).toContain("whitespace-pre-wrap");
  expect(shown.querySelector("b, strong")).toBeNull();
  const rebase = within(shown).getByRole("radio", { name: "Rebase" });
  expect(rebase.getAttribute("aria-describedby")).toBe(
    within(shown).getByText("Replay your commits on main").id,
  );
  expect(within(shown).getByRole("radio", { name: "Merge" }).hasAttribute("aria-describedby")).toBe(
    false,
  );
  // A question that takes no answer of the person's own offers no field for one.
  expect(within(shown).queryByRole("textbox")).toBeNull();
});

it("sends the value of the one option picked, and closes once the thread has the answer", async () => {
  const { sends } = await answering(question());
  fireEvent.click(screen.getByRole("radio", { name: "Merge" }));
  fireEvent.click(screen.getByRole("radio", { name: "Rebase" }));
  send();
  expect(sends.map((sent) => sent.input)).toEqual([
    { workspaceId: "ws-a", agentId: "nova", requestId: "q-1", answers: { branch: "rebase-value" } },
  ]);
  // While it sends, the dialog stays and says so.
  expect(screen.getByRole("button", { name: "Answering…" }).hasAttribute("disabled")).toBe(true);

  await settle(() => sends[0]!.answer.resolve({ status: "answered" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  // The line is main's to change.
  expect(screen.getByTestId("agent-thread-line").dataset.state).toBe("waiting-in-tool");
});

it("sends the values of every option ticked, in the question's order, with the person's own text last", async () => {
  const { sends } = await answering(
    question({
      id: "checks",
      question: "Which checks should run?",
      multiSelect: true,
      allowCustomAnswer: true,
      options: [
        { label: "Lint", description: "", value: "lint" },
        { label: "Types", description: "", value: "types" },
        { label: "Tests", description: "", value: "tests" },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Tests" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Lint" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Types" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Types" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
    target: { value: "  the desktop e2e  " },
  });
  // Typing an own answer ticks it.
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Your own answer" }).checked).toBe(
    true,
  );
  send();
  expect(sends[0]!.input.answers).toEqual({ checks: ["lint", "tests", "the desktop e2e"] });

  // Unticked, the own answer stays typed and is left out.
  await settle(() => sends[0]!.answer.reject(new Error("T3 Code is not running.")));
  fireEvent.click(screen.getByRole("checkbox", { name: "Your own answer" }));
  send();
  expect(sends[1]!.input.answers).toEqual({ checks: ["lint", "tests"] });
});

it("sends either the option picked or the person's own text for a single choice, whichever is marked", async () => {
  const { sends } = await answering(question({ allowCustomAnswer: true }));
  const rebase = screen.getByRole<HTMLInputElement>("radio", { name: "Rebase" });
  const own = screen.getByRole<HTMLInputElement>("radio", { name: "Your own answer" });
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Your own answer" });

  // Typing marks the own answer, which takes the mark from the option.
  fireEvent.click(rebase);
  fireEvent.change(field, { target: { value: "Squash it" } });
  expect([rebase.checked, own.checked]).toEqual([false, true]);
  send();
  expect(sends[0]!.input.answers).toEqual({ branch: "Squash it" });
  await settle(() => sends[0]!.answer.reject(new Error("T3 Code is not running.")));

  // Picking an option takes the mark back. The text stays, unsent.
  fireEvent.click(rebase);
  expect([rebase.checked, own.checked, field.value]).toEqual([true, false, "Squash it"]);
  send();
  expect(sends[1]!.input.answers).toEqual({ branch: "rebase-value" });
});

it("takes the person's own text for a question with no options", async () => {
  const { sends } = await answering(
    question({ id: "why", question: "Why did the build fail?", options: [] }),
  );
  const field = screen.getByRole("textbox", { name: "Why did the build fail?" });
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.change(field, { target: { value: "A stale lockfile.\nIt is fixed now.\n" } });
  send();
  expect(sends[0]!.input.answers).toEqual({ why: "A stale lockfile.\nIt is fixed now." });
});

it("answers several questions together, and leaves out an optional one the person skipped", async () => {
  const { sends } = await answering(
    question(),
    question({ id: "note", question: "Anything to add?", options: [], required: false }),
    question({
      id: "extras",
      question: "Any extras?",
      multiSelect: true,
      required: false,
      options: [{ label: "Changelog", description: "", value: "changelog" }],
    }),
  );
  const shown = screen.getAllByTestId("agent-thread-answer-question");
  expect(shown.map((one) => within(one).queryByText("Optional") !== null)).toEqual([
    false,
    true,
    true,
  ]);
  fireEvent.click(screen.getByRole("radio", { name: "Merge" }));
  // Blank text is no answer.
  fireEvent.change(screen.getByRole("textbox", { name: "Anything to add?" }), {
    target: { value: "   " },
  });
  send();
  expect(sends[0]!.input.answers).toEqual({ branch: "merge-value" });
});

it("keeps a required question from being sent unanswered, and says what it needs", async () => {
  const { sends } = await answering(
    question({ id: "why", question: "Why did the build fail?", options: [], required: false }),
    question({ allowCustomAnswer: true }),
  );
  send();
  expect(sends).toHaveLength(0);
  const [optional, required] = screen.getAllByTestId("agent-thread-answer-question");
  expect(within(optional!).queryByRole("alert")).toBeNull();
  const error = within(required!).getByRole("alert");
  expect(error.textContent).toBe("Choose an option, or enter your own answer.");
  const group = within(required!).getByRole("radiogroup");
  expect(group.getAttribute("aria-invalid")).toBe("true");
  expect(group.getAttribute("aria-describedby")).toBe(error.id);
  // Focus goes to the question that needs an answer.
  expect(document.activeElement).toBe(within(required!).getByRole("radio", { name: "Rebase" }));

  // The own answer marked with nothing typed is still no answer.
  fireEvent.click(within(required!).getByRole("radio", { name: "Your own answer" }));
  expect(within(required!).queryByRole("alert")).toBeNull();
  send();
  expect(sends).toHaveLength(0);
  expect(within(required!).getByRole("alert").textContent).toBe("Enter your own answer.");

  fireEvent.click(within(required!).getByRole("radio", { name: "Rebase" }));
  expect(within(required!).queryByRole("alert")).toBeNull();
  send();
  expect(sends[0]!.input.answers).toEqual({ branch: "rebase-value" });
});

it.each([
  ["already-answered", "This question was already answered."],
  ["closed", "This question no longer waits for an answer."],
] as const)("says so when the read finds the question %s", async (status, words) => {
  const { reads, sends } = asking();
  await settle(() => reads[0]!.answer.resolve({ status }));
  expect(within(dialog()).getByRole("status").textContent).toBe(words);
  expect(screen.queryByTestId("agent-thread-answer-question")).toBeNull();
  expect(
    within(dialog())
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Close"]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sends).toHaveLength(0);
});

it.each([
  ["already-answered", "This question was already answered."],
  ["closed", "This question no longer waits for an answer."],
] as const)("says so when the send finds the question %s", async (status, words) => {
  const { sends } = await answering(question({ allowCustomAnswer: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
    target: { value: "Squash it" },
  });
  send();
  await settle(() => sends[0]!.answer.resolve({ status }));
  expect(within(dialog()).getByRole("status").textContent).toBe(words);
  // The form goes, and what was typed with it.
  expect(screen.queryByTestId("agent-thread-answer-question")).toBeNull();
  expect(document.body.textContent).not.toContain("Squash it");
  expect(
    within(dialog())
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Close"]);
});

it("shows why the question could not be read, with Try again and the way to the thread", async () => {
  const { desktop, reads } = asking();
  await settle(() => reads[0]!.answer.reject(new Error("T3 Code is not running. Open it.")));
  expect(within(dialog()).getByRole("alert").textContent).toBe(
    "dohc could not read the question. T3 Code is not running. Open it.",
  );
  // A dialog shows its own failure. It files no notice.
  expect(report).not.toHaveBeenCalled();

  fireEvent.click(within(dialog()).getByRole("button", { name: "Open in T3 Code" }));
  expect(desktop.openAgentThread).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "ws-a",
    agentId: "nova",
  });

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(reads).toHaveLength(2);
  expect(within(dialog()).queryByRole("alert")).toBeNull();
  await settle(() => reads[1]!.answer.resolve(openBox(question())));
  expect(screen.getByRole("radio", { name: "Rebase" })).toBeTruthy();
});

it("keeps the form and what was typed when the send is refused, and can send again", async () => {
  const { sends } = await answering(
    question({ id: "why", question: "Why did the build fail?", options: [] }),
  );
  const field = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(field, { target: { value: "A stale lockfile." } });
  send();
  await settle(() => sends[0]!.answer.reject(new Error("Answer each question before sending.")));

  expect(within(dialog()).getByRole("alert").textContent).toBe(
    "dohc could not send your answer. Answer each question before sending.",
  );
  expect(field.value).toBe("A stale lockfile.");
  expect(report).not.toHaveBeenCalled();
  const again = screen.getByRole<HTMLButtonElement>("button", { name: "Answer" });
  expect(again.disabled).toBe(false);
  expect(document.activeElement).toBe(again);
  // The words sit over the buttons.
  expect(
    within(dialog()).getByRole("alert").compareDocumentPosition(again) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(again);
  expect(within(dialog()).queryByRole("alert")).toBeNull();
  expect(sends[1]!.input.answers).toEqual({ why: "A stale lockfile." });
  await settle(() => sends[1]!.answer.resolve({ status: "answered" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("reads the question again once when its line stops carrying it, and shows what that says", async () => {
  const { push, reads } = await answering(question({ allowCustomAnswer: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
    target: { value: "Squash it" },
  });
  // Another chat thread's line for the same question keeps it asked.
  push([line({ chatThreadId: "thread-2" })]);
  expect(reads).toHaveLength(1);

  // Someone answered in T3 Code: the thread works on, and the line goes with it.
  push([line({ state: "working", questionId: null })]);
  expect(reads.map((read) => read.input)).toEqual([
    { workspaceId: "ws-a", agentId: "nova", requestId: "q-1" },
    { workspaceId: "ws-a", agentId: "nova", requestId: "q-1" },
  ]);
  // The form stays until the answer comes.
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("Squash it");
  push([]);
  expect(reads).toHaveLength(2);

  await settle(() => reads[1]!.answer.resolve({ status: "already-answered" }));
  expect(within(dialog()).getByRole("status").textContent).toBe(
    "This question was already answered.",
  );
  expect(document.body.textContent).not.toContain("Squash it");
});

it("keeps what was typed when the second read finds the question still open", async () => {
  const { push, reads } = await answering(question({ allowCustomAnswer: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
    target: { value: "Squash it" },
  });
  push([]);
  await settle(() => reads[1]!.answer.resolve(openBox(question({ allowCustomAnswer: true }))));
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("Squash it");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Your own answer" }).checked).toBe(
    true,
  );
});

it("leaves a send that is on its way to say what became of the question", async () => {
  const { push, reads, sends } = await answering(question());
  fireEvent.click(screen.getByRole("radio", { name: "Rebase" }));
  send();
  // The person's own answer is what took the question off the line.
  push([line({ state: "working", questionId: null })]);
  expect(reads).toHaveLength(1);
  await settle(() => sends[0]!.answer.resolve({ status: "answered" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(reads).toHaveLength(1);
});

it("keeps nothing of the question or the answer once the dialog closes", async () => {
  const { reads } = await answering(
    question({ question: "Is the secret plan ready?", allowCustomAnswer: true }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
    target: { value: "Only on Friday" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  for (const kept of ["Is the secret plan ready?", "Only on Friday", "Rebase", "rebase-value"]) {
    expect(document.documentElement.outerHTML).not.toContain(kept);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(kept);
  }

  // Opening it again asks main again, and starts from an empty answer.
  fireEvent.click(screen.getByRole("button", { name: "Answer here" }));
  expect(reads).toHaveLength(2);
  expect(dialog().dataset.view).toBe("loading");
  await settle(() =>
    reads[1]!.answer.resolve(
      openBox(question({ question: "Is the secret plan ready?", allowCustomAnswer: true })),
    ),
  );
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Your own answer" }).checked).toBe(
    false,
  );
});

it("closes when the window changes workspaces, and paints nothing a slow answer brings", async () => {
  // A read that is still out.
  const reading = asking();
  reading.view.rerender(chat("ws-b"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await settle(() => reading.reads[0]!.answer.resolve(openBox(question())));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("Which branch should I use?");
  // The other workspace's own line opens its own question.
  reading.push([line({ questionId: "q-b" })], "ws-b");
  fireEvent.click(screen.getByRole("button", { name: "Answer here" }));
  expect(reading.reads[1]!.input).toEqual({
    workspaceId: "ws-b",
    agentId: "nova",
    requestId: "q-b",
  });
  cleanup();
  vi.unstubAllGlobals();

  // A send that is still out.
  const sending = await answering(question());
  fireEvent.click(screen.getByRole("radio", { name: "Rebase" }));
  send();
  sending.view.rerender(chat("ws-b"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await settle(() => sending.sends[0]!.answer.reject(new Error("T3 Code is not running.")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("T3 Code is not running.");
  expect(report).not.toHaveBeenCalled();
});

it("works from the keyboard: focus starts on the first control, Escape closes, and focus returns", async () => {
  const user = userEvent.setup();
  const { push, reads, sends } = stubDesktop();
  render(chat());
  push([line()]);
  const opener = screen.getByRole("button", { name: "Answer here" });
  opener.focus();
  await user.keyboard("{Enter}");
  // While the question loads, focus waits inside the dialog.
  expect(dialog().parentElement).toBe(document.activeElement);

  await settle(() =>
    reads[0]!.answer.resolve(
      openBox(
        question(),
        question({ id: "why", question: "Why did the build fail?", options: [], required: false }),
      ),
    ),
  );
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Rebase" }));
  // The Enter that opened the dialog, still held, sends nothing.
  expect(
    fireEvent.keyDown(screen.getByRole("radio", { name: "Rebase" }), {
      key: "Enter",
      repeat: true,
    }),
  ).toBe(false);
  // Space picks, Tab reaches the next question, and Enter on the button sends.
  await user.keyboard(" ");
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
  await user.keyboard("Stale lockfile");
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Answer" }));
  await user.keyboard("{Enter}");
  expect(sends[0]!.input.answers).toEqual({ branch: "rebase-value", why: "Stale lockfile" });

  // Escape waits for a send that is on its way.
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await settle(() => sends[0]!.answer.reject(new Error("T3 Code is not running.")));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
