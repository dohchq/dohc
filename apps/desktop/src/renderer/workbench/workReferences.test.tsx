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

describe("the work link store", () => {
  it("asks main once per batch of 64, for each link once while its answer is fresh", async () => {
    const describe = vi.fn(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", vi.fn(), describe);
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
    const links = createWorkReferenceLinks("ws", vi.fn(), describe);
    links.want(ref("A"));
    await vi.waitFor(() => expect(links.view(ref("A"))).toBeDefined());
    vi.setSystemTime(Date.now() + 30_001);
    links.want(ref("A"));
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
  });

  it("drops an answer and an open after the workspace changes", async () => {
    let answer!: (views: WorkReferenceView[]) => void;
    const open = vi.fn();
    const links = createWorkReferenceLinks("ws", open, () => new Promise((resolve) => { answer = resolve; }));
    links.want(ref("A"));
    await vi.waitFor(() => expect(answer).toBeDefined());
    links.dispose();
    answer([chat(ref("A"))]);
    await Promise.resolve();
    expect(links.view(ref("A"))).toBeUndefined();
    links.open({ to: "chat-channel", channel: "c-1" });
    expect(open).not.toHaveBeenCalled();
  });

  it("asks again after a failed read", async () => {
    const describe = vi.fn().mockRejectedValueOnce(new Error("engine stopped")).mockImplementation(async (references: string[]) => references.map(chat));
    const links = createWorkReferenceLinks("ws", vi.fn(), describe);
    links.want(ref("A"));
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    links.want(ref("A"));
    await vi.waitFor(() => expect(links.view(ref("A"))).toBeDefined());
  });
});

describe("a work link in a chat message", () => {
  function renderLinks(body: string, views: WorkReferenceView[]) {
    const open = vi.fn();
    const links = createWorkReferenceLinks("ws", open, async (references) =>
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
    act(() => chip.click());
    expect(open).toHaveBeenCalledWith({ to: "chat-channel", channel: "c-1" });
  });

  it("names a file by its basename and a thread without a title as Thread", async () => {
    const { view } = renderLinks(`@[work:${ref("A")}] and @[work:${ref("B")}]`, [
      { reference: ref("A"), kind: "file", label: "Trip/plan.md", open: { to: "file", path: "Trip/plan.md" } },
      { reference: ref("B"), kind: "thread", label: "", open: { to: "chat", thread: "t-1" } },
    ]);
    await waitFor(() => view.getByRole("button", { name: "Open plan.md" }));
    expect(view.getByRole("button", { name: "Open Thread" })).toBeTruthy();
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
