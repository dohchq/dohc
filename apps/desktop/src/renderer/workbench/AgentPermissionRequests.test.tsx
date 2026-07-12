// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPermissionRequests } from "./AgentPermissionRequests";
import type { AgentPermissionRequest } from "./useAgentNotifications";

// The retired Agent panel's one load-bearing interaction, relocated: a
// blocked run's consent ask surfaces as a floating card wherever the user
// already is, and answering resumes the run.

const answerAgentPermission = vi.fn(async () => ({ drivers: [], session: null }));

beforeEach(() => {
  answerAgentPermission.mockClear();
  vi.stubGlobal("dohcDesktop", { answerAgentPermission });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function request(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    requestId: "perm-1",
    requestType: "file-change",
    title: "Write notes/plan.md",
    detail: "The agent wants to update the plan.",
    locations: ["notes/plan.md"],
    options: [
      { optionId: "o-allow", name: "Allow", kind: "allow_once" },
      { optionId: "o-reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

describe("AgentPermissionRequests", () => {
  it("renders nothing without pending requests", () => {
    render(<AgentPermissionRequests workspaceId="ws-1" requests={[]} />);
    expect(screen.queryByTestId("agent-permission-requests")).toBeNull();
  });

  it("shows the ask with its locations and answers it", async () => {
    const user = userEvent.setup();
    render(<AgentPermissionRequests workspaceId="ws-1" requests={[request()]} />);

    const card = screen.getByTestId("agent-permission-request");
    expect(card.textContent).toContain("Write notes/plan.md");
    expect(card.textContent).toContain("The agent wants to update the plan.");
    expect(
      screen.getByTestId("agent-permission-locations").textContent,
    ).toContain("notes/plan.md");

    await user.click(screen.getByTestId("agent-permission-allow_once"));
    expect(answerAgentPermission).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      requestId: "perm-1",
      decision: "allow_once",
    });
    // Optimistic hide: the answered card is gone before the next poll.
    await waitFor(() =>
      expect(screen.queryByTestId("agent-permission-request")).toBeNull(),
    );
  });

  it("releases an answered id once the poll drops it, so a reused id can ask again", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentPermissionRequests workspaceId="ws-1" requests={[request()]} />,
    );
    await user.click(screen.getByTestId("agent-permission-allow_once"));
    await waitFor(() =>
      expect(screen.queryByTestId("agent-permission-request")).toBeNull(),
    );

    // Poll confirms the answer (request gone), then a LATER ask reuses the
    // provider request id — it must render, not stay hidden forever.
    rerender(<AgentPermissionRequests workspaceId="ws-1" requests={[]} />);
    rerender(
      <AgentPermissionRequests
        workspaceId="ws-1"
        requests={[request({ title: "Run: rm old.md" })]}
      />,
    );
    expect(screen.getByTestId("agent-permission-request").textContent).toContain(
      "Run: rm old.md",
    );
  });

  it("restores the card with an error when answering fails", async () => {
    answerAgentPermission.mockRejectedValueOnce(new Error("run already ended"));
    const user = userEvent.setup();
    render(<AgentPermissionRequests workspaceId="ws-1" requests={[request()]} />);

    await user.click(screen.getByTestId("agent-permission-reject_once"));
    await screen.findByTestId("agent-permission-error");
    expect(screen.getByTestId("agent-permission-error").textContent).toContain(
      "run already ended",
    );
    expect(screen.getByTestId("agent-permission-request")).toBeTruthy();
  });
});
