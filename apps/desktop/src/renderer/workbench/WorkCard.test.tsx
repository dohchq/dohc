// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLink } from "../linkActivation";
import { formatChatTime } from "../time";
import { linkHost, WorkStatus } from "./WorkCard";

vi.mock("../linkActivation", () => ({ openLink: vi.fn(async () => undefined) }));

afterEach(() => {
  cleanup();
  vi.mocked(openLink).mockClear();
});

describe("linkHost", () => {
  it("names the site a web address leads to, without a name before the host", () => {
    expect(linkHost("https://github.com/dohchq/dohc/pull/7")).toBe("github.com");
    expect(linkHost("http://localhost:3773/threads/1")).toBe("localhost:3773");
    expect(linkHost("https://github.com@evil.example/pull/7")).toBe("evil.example");
  });

  it("keeps the end of a long host, where the site's own name is", () => {
    const host = linkHost("https://github.com.pull.request.1234.long-chain.evil.example/");
    expect(host).toHaveLength(32);
    expect(host?.startsWith("…")).toBe(true);
    expect(host?.endsWith(".long-chain.evil.example")).toBe(true);
  });

  it("is null for anything that is not a web address", () => {
    for (const url of ["javascript:alert(1)", "mailto:ada@example.com", "https://[bad", "https://‮x/moc.buhtig", ""]) {
      expect(linkHost(url), url).toBeNull();
    }
  });
});

describe("WorkStatus", () => {
  it("shows the status in words with a plain mark, and says who reported it", () => {
    const atMs = new Date(2026, 6, 8, 14, 43).getTime();
    render(<WorkStatus testIdPrefix="chats-post" work={{ status: "done" }} reportedBy={{ name: "Nova", owner: "Ada", atMs }} />);
    const status = screen.getByTestId("chats-post-work");
    expect(status.getAttribute("data-status")).toBe("done");
    const mark = status.querySelector("svg.lucide-circle-check");
    expect(mark).not.toBeNull();
    // dohc did not check the report, so the mark takes no success color.
    expect(mark?.getAttribute("class")).not.toContain("text-success");
    const reported = `As reported by Nova, Ada's agent, ${formatChatTime(atMs).label}`;
    expect(screen.getByTitle(reported)).not.toBeNull();
    expect(status.textContent).toBe(`Done. ${reported}`);
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
  ] as const)("marks %s on a message with its own icon, as reported", (status, word, icon) => {
    render(<WorkStatus testIdPrefix="chats-comment" work={{ status }} />);
    const mark = screen.getByTestId("chats-comment-work");
    expect(mark.textContent).toBe(`${word}. As reported`);
    expect(screen.getByTitle("As reported")).not.toBeNull();
    expect(mark.querySelector(icon)).not.toBeNull();
  });

  it("opens the link through the app's link path, named by its site, without opening the row", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <WorkStatus testIdPrefix="chats-post" work={{ status: "waiting", url: "https://github.com/dohchq/dohc/pull/7" }} />
      </div>,
    );
    const open = screen.getByRole("button", { name: "Open github.com, as reported" });
    expect(open.getAttribute("title")).toBe("https://github.com/dohchq/dohc/pull/7");
    expect(open.textContent).toBe("github.com");
    fireEvent.click(open);
    expect(openLink).toHaveBeenCalledWith("https://github.com/dohchq/dohc/pull/7");
    expect(onRow).not.toHaveBeenCalled();
  });

  it("offers no button for a link that is not a web address", () => {
    render(<WorkStatus testIdPrefix="chats-post" work={{ status: "done", url: "javascript:alert(1)" }} />);
    expect(screen.queryByTestId("chats-post-work-open")).toBeNull();
  });
});
