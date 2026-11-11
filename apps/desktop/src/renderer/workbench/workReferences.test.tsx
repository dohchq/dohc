// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkReferenceView } from "../../ipc/bridgeContract";
import { ChatMarkdown } from "./ChatMarkdown";
import { createWorkReferenceLinks, WorkReferences } from "./workReferences";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ref = (letter: string) => letter.repeat(43);
const chat = (reference: string): WorkReferenceView =>
  ({ reference, kind: "chat", label: "Trip", open: { to: "chat-channel", channel: "c-1" } });
const handlers = (open = vi.fn(), failed = vi.fn()) => ({ open, failed });

describe("the work link store", () => {
  it("asks main once per batch of 64, for each link once while its answer is fresh", async () => {
    const describe = vi.fn(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", handlers(), describe);
    const many = Array.from({ length: 70 }, (_, at) => String(at).padStart(43, "x"));
    for (const reference of [...many, many[0]!]) links.want(reference);
    await vi.waitFor(() => expect(links.view(many[69]!)).toBeDefined());
    expect(describe.mock.calls.map(([batch]) => batch.length)).toEqual([64, 6]);
    links.want(many[0]!);
    await Promise.resolve();
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it("reads a link again once its answer is old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const describe = vi.fn(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", handlers(), describe);
    links.want(ref("A"));
    await vi.waitFor(() => expect(links.view(ref("A"))).toBeDefined());
    vi.setSystemTime(Date.now() + 30_001);
    links.want(ref("A"));
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
  });

  it("drops an answer and an open after the workspace changes", async () => {
    let answer!: (views: WorkReferenceView[]) => void;
    const open = vi.fn();
    const links = createWorkReferenceLinks("ws", handlers(open), () => new Promise((resolve) => { answer = resolve; }));
    links.want(ref("A"));
    await vi.waitFor(() => expect(answer).toBeDefined());
    links.dispose();
    answer([chat(ref("A"))]);
    await Promise.resolve();
    expect(links.view(ref("A"))).toBeUndefined();
    await links.open(ref("A"));
    expect(open).not.toHaveBeenCalled();
  });

  it("asks again after a failed read", async () => {
    const describe = vi.fn().mockRejectedValueOnce(new Error("engine stopped")).mockImplementation(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", handlers(), describe);
    links.want(ref("A"));
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    links.want(ref("A"));
    await vi.waitFor(() => expect(links.view(ref("A"))).toBeDefined());
  });

  it("opens only the newest click when an older one is answered last", async () => {
    const answers = new Map<string, (views: WorkReferenceView[]) => void>();
    const open = vi.fn();
    const links = createWorkReferenceLinks("ws", handlers(open), ([reference]) =>
      new Promise((resolve) => answers.set(reference!, resolve)));
    const first = links.open(ref("A"));
    const second = links.open(ref("B"));
    answers.get(ref("B"))!([{ ...chat(ref("B")), open: { to: "chat-channel", channel: "c-2" } }]);
    await second;
    answers.get(ref("A"))!([chat(ref("A"))]);
    await first;
    expect(open.mock.calls).toEqual([[{ to: "chat-channel", channel: "c-2" }]]);
  });

  it("says when a click cannot be read, and Try again opens it", async () => {
    const error = new Error("engine stopped");
    const describe = vi.fn().mockRejectedValueOnce(error).mockImplementation(async (references: string[]) => references.map(chat));
    const open = vi.fn();
    const failed = vi.fn();
    const links = createWorkReferenceLinks("ws", handlers(open, failed), describe);
    await links.open(ref("A"));
    expect(open).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(error, expect.any(Function));
    failed.mock.calls[0]![1]();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith({ to: "chat-channel", channel: "c-1" }));
  });
});

describe("a work link in a chat message", () => {
  function renderLinks(body: string, views: WorkReferenceView[]) {
    const open = vi.fn();
    const links = createWorkReferenceLinks("ws", handlers(open), async (references) =>
      views.filter((view) => references.includes(view.reference)));
    const view = render(
      <WorkReferences.Provider value={links}>
        <ChatMarkdown body={body} candidates={[]} testId="body" onOpenPath={vi.fn()} />
      </WorkReferences.Provider>,
    );
    return { view, open };
  }

  it("shows a chat by name and opens it", async () => {
    const { view, open } = renderLinks(`See @[work:${ref("A")}] **now**`, [chat(ref("A"))]);
    const chip = await waitFor(() => view.getByRole("button", { name: "Open Trip" }));
    expect(chip.dataset.testid).toBe("body-work-link");
    await act(async () => chip.click());
    await waitFor(() => expect(open).toHaveBeenCalledWith({ to: "chat-channel", channel: "c-1" }));
  });

  it("names a file by its basename and a thread without a title as Thread", async () => {
    const { view } = renderLinks(`@[work:${ref("A")}] and @[work:${ref("B")}]`, [
      { reference: ref("A"), kind: "file", label: "Trip/plan.md", open: { to: "file", path: "Trip/plan.md" } },
      { reference: ref("B"), kind: "thread", label: "", open: { to: "chat", thread: "t-1" } },
    ]);
    await waitFor(() => view.getByRole("button", { name: "Open plan.md" }));
    expect(view.getByRole("button", { name: "Open Thread" })).toBeTruthy();
  });

  it("reads a link again when it is opened, so a click follows a rename", async () => {
    const views = [{ reference: ref("A"), kind: "file" as const, label: "plan.md", open: { to: "file" as const, path: "plan.md" } }];
    const { view, open } = renderLinks(`@[work:${ref("A")}]`, views);
    await waitFor(() => view.getByRole("button", { name: "Open plan.md" }));
    views[0] = { ...views[0]!, label: "trip.md", open: { to: "file", path: "trip.md" } };
    await act(async () => view.getByRole("button", { name: "Open plan.md" }).click());
    await waitFor(() => expect(open).toHaveBeenCalledWith({ to: "file", path: "trip.md" }));
    expect(view.getByRole("button", { name: "Open trip.md" })).toBeTruthy();
  });

  it("opens a link whose first read failed once it is read", async () => {
    const open = vi.fn();
    const describe = vi.fn().mockRejectedValueOnce(new Error("engine stopped"))
      .mockImplementation(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", handlers(open), describe);
    const view = render(
      <WorkReferences.Provider value={links}>
        <ChatMarkdown body={`@[work:${ref("A")}]`} candidates={[]} testId="body" onOpenPath={vi.fn()} />
      </WorkReferences.Provider>,
    );
    await waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
    await act(async () => view.getByRole("button", { name: "Open link" }).click());
    await waitFor(() => expect(open).toHaveBeenCalledWith({ to: "chat-channel", channel: "c-1" }));
    expect(view.getByRole("button", { name: "Open Trip" })).toBeTruthy();
  });

  it("shows work this workspace cannot see as unavailable, with nothing to open", async () => {
    const { view } = renderLinks(`@[work:${ref("A")}]`, [{ reference: ref("A"), kind: null, label: "", open: null }]);
    await waitFor(() => expect(view.getByTestId("body-work-link").textContent).toContain("Unavailable"));
    expect(view.getByTestId("body-work-link").dataset.missing).toBe("true");
    expect(view.queryByRole("button")).toBeNull();
  });

  it("leaves text that only looks like a link alone", () => {
    const { view } = renderLinks("`@[work:" + ref("A") + "]` and @[work:short]", []);
    expect(view.queryByTestId("body-work-link")).toBeNull();
  });
});
