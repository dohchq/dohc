// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COPY_FAILURE, CopyButton } from "../ui/CopyButton";
import { ConnectionNotices, StandaloneNotices } from "./connectionNotices";
import type { ReportShellFailure } from "./useShellError";

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", {
    platform: "win32",
    getUpdateState: () => new Promise(() => {}),
    onUpdateState: () => () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const notice = {
  id: "connect",
  message: "dohc could not reach this server.",
  details: "Error: dohc could not reach this server.",
  atMs: 1_000,
  canRetry: true,
  seen: false,
};

// Outside the workspace shell, the corner notices own their own failures: a
// copy refused from one of them is reported to the same owner.
it("reports a copy refused from a notice to the owner it was given", async () => {
  const user = userEvent.setup();
  const refusal = new Error("Document is not focused.");
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(refusal);
  const reportFailure = vi.fn<ReportShellFailure>();
  render(
    <ConnectionNotices
      notices={[notice]}
      reportFailure={reportFailure}
      onRetry={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Copy error details" }));
  expect(reportFailure).toHaveBeenCalledWith({
    message: `${COPY_FAILURE} Document is not focused.`,
    cause: refusal,
    retry: expect.any(Function),
  });
});

// A screen with no notice owner above it, such as the one dohc shows when it
// cannot read its workspace list, gets its own: a refused copy there becomes a
// toast with Try again.
it("gives a copy on a screen with no notice owner a toast and Try again", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Document is not focused."));
  render(
    <StandaloneNotices>
      <CopyButton label="Copy" pinName iconOnly getText={() => "Error: dohc couldn't read its workspace registry"} />
    </StandaloneNotices>,
  );

  await user.click(screen.getByRole("button", { name: "Copy" }));
  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain(COPY_FAILURE);

  writeText.mockResolvedValueOnce(undefined);
  await act(async () => {
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
  });
  expect(writeText).toHaveBeenLastCalledWith("Error: dohc couldn't read its workspace registry");
});
