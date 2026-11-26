// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceAppsDialog } from "./WorkspaceAppsDialog";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reports a failed review with Try again, and keeps the message in the dialog", async () => {
  const unreachable = new Error("dohc could not load trip-board. The server answered 503.");
  const memberAppInspect = vi.fn(async () => {
    throw unreachable;
  });
  vi.stubGlobal("dohcDesktop", {
    memberAppInspect,
    memberAppsList: vi.fn(async () => ({
      apps: [
        {
          kind: "member",
          publicationId: "a".repeat(64),
          name: "trip-board",
          authorName: "Ana",
          createdAtMs: 1,
          reachable: true,
          consent: "none",
          canWithdraw: false,
          url: null,
        },
      ],
      nextCursor: null,
    })),
  });
  const reportError = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceSessionProvider workspaceId="ws-1">{children}</WorkspaceSessionProvider>
  );
  render(
    <WorkspaceAppsDialog workspaceId="ws-1" canCopy onClose={vi.fn()} reportError={reportError} />,
    { wrapper },
  );

  await userEvent.setup().click(await screen.findByRole("button", { name: "Review" }));
  await waitFor(() =>
    expect(reportError).toHaveBeenCalledWith(
      "dohc could not load trip-board.",
      unreachable,
      expect.any(Function),
    ),
  );
  expect(screen.getByText(/The server answered 503/)).toBeTruthy();
  reportError.mock.calls[0]![2]();
  await waitFor(() => expect(memberAppInspect).toHaveBeenCalledTimes(2));
});
