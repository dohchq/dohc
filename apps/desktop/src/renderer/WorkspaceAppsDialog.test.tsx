// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { freeAppFolder, WorkspaceAppsDialog } from "./WorkspaceAppsDialog";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const publicationId = "a".repeat(64);
const memberRow = {
  kind: "member",
  publicationId,
  name: "trip-board",
  authorName: "Ana",
  createdAtMs: 1,
  reachable: true,
  consent: "none",
  canWithdraw: true,
  url: null,
};
const inspected = {
  name: "trip-board",
  authorName: "Ana",
  consent: "none",
  collections: [],
  source: [
    { path: "trip-board/index.html", sha256: "b".repeat(64), byteLength: 20 },
    { path: "trip-board/logo.png", sha256: "c".repeat(64), byteLength: 4 },
  ],
};

function renderDialog(desktop: Record<string, unknown>, extra: { canPromote?: boolean } = {}) {
  vi.stubGlobal("dohcDesktop", {
    memberAppsList: vi.fn(async () => ({ apps: [memberRow], nextCursor: null })),
    memberAppInspect: vi.fn(async () => inspected),
    memberAppSource: vi.fn(async ({ path }: { path: string }) =>
      path.endsWith(".png")
        ? { path, byteLength: 4, text: null }
        : { path, byteLength: 20, text: "<h1>Trip</h1>\n<p>Go</p>" },
    ),
    ...desktop,
  });
  const props = {
    reportError: vi.fn(),
    onPromoted: vi.fn(),
    onClose: vi.fn(),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceSessionProvider workspaceId="ws-1">{children}</WorkspaceSessionProvider>
  );
  const view = render(
    <WorkspaceAppsDialog
      workspaceId="ws-1"
      canCopy={!extra.canPromote}
      canPromote={extra.canPromote ?? false}
      pathTaken={(path) => path === "apps/trip-board"}
      {...props}
    />,
    { wrapper },
  );
  return { ...props, view, user: userEvent.setup() };
}

it("keeps a failed review in the dialog, and Review tries again", async () => {
  const unreachable = new Error("dohc could not load trip-board. The server answered 503.");
  const memberAppInspect = vi.fn(async () => {
    throw unreachable;
  });
  const { reportError, user } = renderDialog({ memberAppInspect });

  await user.click(await screen.findByRole("button", { name: "Review" }));
  expect(await screen.findByText(/The server answered 503/)).toBeTruthy();
  expect(reportError).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(memberAppInspect).toHaveBeenCalledTimes(2));
});

it("hands a failure still showing to the shell when the dialog closes", async () => {
  const unreachable = new Error("dohc could not load trip-board. The server answered 503.");
  const { reportError, view, user } = renderDialog({
    memberAppInspect: vi.fn(async () => {
      throw unreachable;
    }),
  });

  await user.click(await screen.findByRole("button", { name: "Review" }));
  await screen.findByText(/The server answered 503/);
  view.unmount();
  expect(reportError).toHaveBeenCalledOnce();
  expect(reportError).toHaveBeenCalledWith(
    "dohc could not load trip-board.",
    unreachable,
    expect.any(Function),
  );
});

it("reports a failure to the shell once the dialog has closed", async () => {
  let fail!: (error: Error) => void;
  const memberAppInspect = vi.fn(
    () => new Promise((_, reject) => (fail = reject as (error: Error) => void)),
  );
  const { reportError, view, user } = renderDialog({ memberAppInspect });

  await user.click(await screen.findByRole("button", { name: "Review" }));
  view.unmount();
  const unreachable = new Error("offline");
  fail(unreachable);
  await waitFor(() =>
    expect(reportError).toHaveBeenCalledWith(
      "dohc could not load trip-board.",
      unreachable,
      expect.any(Function),
    ),
  );
});

it("shows the first source file as text, and a binary file as not text", async () => {
  const { user } = renderDialog({});

  expect(await screen.findByRole("heading", { name: "Shared by members" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect((await screen.findByTestId("workspace-app-source-text")).textContent).toBe(
    "<h1>Trip</h1>\n<p>Go</p>",
  );
  await user.click(screen.getByRole("button", { name: /logo\.png/ }));
  expect(await screen.findByText("This file isn't text.")).toBeTruthy();
});

it("checks the folder before it promotes, then hands the folder on", async () => {
  const memberAppPromote = vi.fn(async ({ folder }: { folder: string }) => ({ folder }));
  const { onPromoted, user } = renderDialog({ memberAppPromote }, { canPromote: true });

  await user.click(await screen.findByRole("button", { name: "Review" }));
  const field = await screen.findByLabelText<HTMLInputElement>("Workspace folder");
  expect(field.value).toBe("apps/trip-board-2");
  await user.clear(field);
  await user.type(field, "apps/trip-board");
  await user.click(screen.getByRole("button", { name: "Promote app" }));
  expect(screen.getByTestId("workspace-app-promote-problem").textContent).toContain(
    "The workspace already has apps/trip-board.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(memberAppPromote).not.toHaveBeenCalled();

  await user.clear(field);
  await user.type(field, ".env{Tab}");
  expect(screen.getByTestId("workspace-app-promote-problem").textContent).toContain(".env");

  await user.clear(field);
  await user.type(field, "apps/trips{Enter}");
  await waitFor(() => expect(onPromoted).toHaveBeenCalledWith("apps/trips"));
  expect(memberAppPromote).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    publicationId,
    folder: "apps/trips",
  });
});

it("keeps a failed withdraw in its confirmation", async () => {
  const memberAppWithdraw = vi.fn(async () => {
    throw new Error("dohc could not withdraw trip-board. The server answered 503.");
  });
  const { reportError, user } = renderDialog({ memberAppWithdraw });

  await user.click(await screen.findByRole("button", { name: "Withdraw" }));
  await user.click(screen.getByTestId("workspace-app-withdraw-action"));
  const confirm = screen.getByTestId("workspace-app-withdraw-confirm");
  await waitFor(() => expect(confirm.textContent).toContain("The server answered 503"));
  expect(reportError).not.toHaveBeenCalled();
});

it("picks the first free apps folder for a name", () => {
  const taken = new Set(["apps/trip-board", "apps/trip-board-2"]);
  expect(freeAppFolder("Trip Board!", (path) => taken.has(path))).toBe("apps/trip-board-3");
  expect(freeAppFolder("***", () => false)).toBe("apps/app");
});
