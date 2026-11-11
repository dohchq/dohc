// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetails } from "./ChatPosts";

const run = { runId: "run-1", threadId: "thread-1", triggerMessageId: "message-1", command: "claude", startedAtMs: 1_000, exitCode: 0 };

afterEach(cleanup);
describe("run details", () => {
  it("shows the product and model the agent reported, marked as reported", () => {
    const { container } = render(<RunDetails run={run} reported={{ product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" }} />);
    expect(screen.getByTestId("chats-run-product").textContent).toBe("Claude Code 2.1 (as reported)");
    expect(screen.getByTestId("chats-run-model").textContent).toBe("Claude Opus 5.5 (as reported)");
    for (const id of ["chats-run-product", "chats-run-model"]) {
      const value = screen.getByTestId(id);
      expect(value.classList.contains("text-ink")).toBe(true);
      expect(value.querySelector("span")?.classList.contains("text-muted")).toBe(true);
      expect(value.querySelector("span")?.textContent).toBe("(as reported)");
    }
    // Product and Model are rows of their own, like Command, not one row split in two.
    for (const id of ["chats-run-command", "chats-run-product", "chats-run-model"]) {
      expect(screen.getByTestId(id).parentElement?.parentElement).toBe(container);
    }
  });

  it("shows only what was reported, and nothing when nothing was", () => {
    render(<RunDetails run={run} reported={{ product: "Claude Code" }} />);
    expect(screen.getByTestId("chats-run-product").textContent).toBe("Claude Code (as reported)");
    expect(screen.queryByTestId("chats-run-model")).toBeNull();
    cleanup();
    render(<RunDetails run={run} />);
    expect(screen.queryByTestId("chats-run-product")).toBeNull();
    expect(screen.queryByTestId("chats-run-model")).toBeNull();
    expect(screen.getByTestId("chats-run-command").textContent).toBe("claude");
  });

  it("says a removed log was removed instead of naming a file that is gone", () => {
    render(<RunDetails run={{ ...run, logPath: "/state/run-logs/run-1.log" }} />);
    expect(screen.getByTestId("chats-run-log-path").textContent).toBe("/state/run-logs/run-1.log");
    expect(screen.getByTestId("chats-run-copy-log")).toBeTruthy();
    cleanup();
    render(<RunDetails run={{ ...run, logRemoved: true }} />);
    expect(screen.getByTestId("chats-run-log-removed").textContent).toBe("Removed");
    expect(screen.queryByTestId("chats-run-log-path")).toBeNull();
    expect(screen.queryByTestId("chats-run-copy-log")).toBeNull();
  });
});
