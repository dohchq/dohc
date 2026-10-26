// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CaptureFileHold } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useCaptureHoldNotices } from "./useCaptureHoldNotices";
import { useShellError } from "./useShellError";
import { readError } from "../../ipc/errorWords";

afterEach(cleanup);
const held: CaptureFileHold = { workspaceId: "workspace", sourceVersionId: "main", objectId: "object", path: "held.md",
  observedSha256: "digest", observedSize: 4, reason: "ydoc-resolution-not-representable",
  observedAtMs: 1, attemptCount: 1, retryRequested: false };
const reply = { deferredWrites: [], settled: true, running: true, degraded: false, retried: true, heldFiles: [held] };
function fixture() {
  const retryHeldCapture = vi.fn(async () => reply);
  Object.assign(window, { dohcDesktop: { retryHeldCapture } });
  const view = renderHook(({ files, workspaceId }: { files: CaptureFileHold[]; workspaceId: string }) => {
    const shell = useShellError(workspaceId);
    useCaptureHoldNotices({ workspaceId, heldFiles: files, show: shell.showCaptureHolds,
      reportShellError: shell.reportShellError, reportShellFailure: shell.reportShellFailure });
    return shell;
  }, { initialProps: { files: [held], workspaceId: "workspace" } });
  return { ...view, retryHeldCapture };
}

it.each(["degraded", "failure"])("reports a retry %s after the updated held event arrives before its reply", async mode => {
  const f = fixture();
  const pending = deferred<typeof reply>();
  const failure = new Error("DaemonRefusalError [INTERNAL]: disk refused retry");
  f.retryHeldCapture.mockImplementationOnce(() => pending.promise);
  act(() => f.result.current.retryShellError(f.result.current.shellErrors[0]!.id));
  f.rerender({ files: [{ ...held, observedAtMs: 2 }], workspaceId: "workspace" });
  await act(async () => {
    if (mode === "degraded") pending.resolve({ ...reply, degraded: true });
    else pending.reject(failure);
  });
  if (mode === "degraded") {
    expect(f.result.current.shellErrors.some(row => row.message.includes("Reopen the workspace"))).toBe(true);
  } else {
    expect(f.result.current.shellErrors[0]).toMatchObject({ title: "Outside edit not recorded", tone: "warning",
      identity: "capture-held:held.md", details: [["File", "held.md", 7], ["Cause", readError(failure).cause]] });
  }
});

it("shows the toast again after an unchanged retry finishes still held", async () => {
  const f = fixture();
  act(() => f.result.current.hideShellError(f.result.current.shellErrors[0]!.id));
  expect(f.result.current.shellErrors[0]!.seen).toBe(true);
  act(() => f.result.current.retryShellError(f.result.current.shellErrors[0]!.id));
  await waitFor(() => expect(f.result.current.shellErrors[0]!.seen).toBe(false));
  expect(f.result.current.shellErrors).toHaveLength(1);
});

it("keeps a cleared hold cleared when its retry answers later", async () => {
  const f = fixture();
  const pending = deferred<typeof reply>();
  f.retryHeldCapture.mockImplementationOnce(() => pending.promise);
  act(() => f.result.current.retryShellError(f.result.current.shellErrors[0]!.id));
  f.rerender({ files: [], workspaceId: "workspace" });
  await act(async () => pending.resolve(reply));
  expect(f.result.current.shellErrors).toHaveLength(0);
});
