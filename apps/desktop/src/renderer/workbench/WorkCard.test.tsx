// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { openLink } from "../linkActivation";
import { formatChatTime } from "../time";
import { threadWork, WorkStatus } from "./WorkCard";

vi.mock("../linkActivation", () => ({ openLink: vi.fn(async () => undefined) }));

afterEach(() => {
  cleanup();
  vi.mocked(openLink).mockClear();
});

function message(id: string, createdAtMs: number, work?: ChatMessageRecord["work"]): ChatMessageRecord {
  return {
    presentation: { group: "fixture", hue: null, self: false },
    id, threadId: "thread", authorKind: "agent", authorDisplayName: id === "other" ? "Scout" : "Nova",
    body: id, createdAtMs, ...(work ? { work } : {}),
  };
}

describe("threadWork", () => {
  it("has no card when no message reported work", () => {
    expect(threadWork([message("a", 1), message("b", 2)])).toBeUndefined();
  });

  it("takes the newest report's status and the newest link, whatever order the messages arrived in", () => {
    const card = threadWork([
      message("late", 25, { status: "failed", url: "https://example.com/threads/2" }),
      message("open", 10, { status: "working", url: "https://example.com/threads/1" }),
      message("talk", 40),
      message("other", 30, { status: "done" }),
    ]);
    expect(card).toEqual({
      status: "done", url: "https://example.com/threads/2", messageId: "other",
      authorDisplayName: "Scout", reportedAtMs: 30,
    });
  });

  it("breaks a tie on the time by message id, as the engine does", () => {
    const card = threadWork([message("b", 10, { status: "done" }), message("a", 10, { status: "working" })]);
    expect(card?.messageId).toBe("b");
  });
});

describe("WorkStatus", () => {
  it("shows the status in words with its mark, and who reported it in the tooltip", () => {
    const atMs = new Date(2026, 6, 8, 14, 43).getTime();
    render(<WorkStatus testIdPrefix="chats-post" work={{ status: "done" }} reportedBy={{ name: "Nova", atMs }} />);
    const status = screen.getByTestId("chats-post-work");
    expect(status.getAttribute("data-status")).toBe("done");
    expect(status.textContent).toContain("Done");
    expect(status.querySelector("svg.lucide-circle-check")).not.toBeNull();
    expect(screen.getByTitle(`Reported by Nova, ${formatChatTime(atMs).label}`)).not.toBeNull();
    expect(screen.queryByTestId("chats-post-work-reporter")).toBeNull();
    expect(screen.queryByTestId("chats-post-work-open")).toBeNull();
  });

  it("names the agent beside the status where the row shows another author", () => {
    render(<WorkStatus testIdPrefix="chats-post" work={{ status: "working" }} reportedBy={{ name: "Nova", atMs: 1 }} showReporter />);
    expect(screen.getByTestId("chats-post-work-reporter").textContent).toBe("Nova");
    expect(screen.getByTestId("chats-post-work").querySelector(".bg-agent")).not.toBeNull();
  });

  it.each([
    ["waiting", "Waiting", "svg.lucide-hourglass"],
    ["failed", "Failed", "svg.lucide-circle-alert"],
    ["stopped", "Stopped", "svg.lucide-circle-stop"],
  ] as const)("marks %s with its own icon", (status, word, icon) => {
    render(<WorkStatus testIdPrefix="chats-comment" work={{ status }} />);
    const mark = screen.getByTestId("chats-comment-work");
    expect(mark.textContent).toBe(word);
    expect(mark.querySelector(icon)).not.toBeNull();
  });

  it("opens the link through the app's link path, named by its site, without opening the row", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <WorkStatus testIdPrefix="chats-post" work={{ status: "waiting", url: "https://github.com/dohchq/dohc/pull/7" }} />
      </div>,
    );
    const open = screen.getByRole("button", { name: "Open github.com" });
    expect(open.getAttribute("title")).toBe("https://github.com/dohchq/dohc/pull/7");
    expect(open.textContent).toBe("github.com");
    fireEvent.click(open);
    expect(openLink).toHaveBeenCalledWith("https://github.com/dohchq/dohc/pull/7");
    expect(onRow).not.toHaveBeenCalled();
  });
});
