import { useCallback, useEffect, useRef } from "react";
import type { CaptureFileHold } from "../../ipc/bridgeContract";
import { CAPTURE_HELD_WORDS } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { useShellError } from "./useShellError";

export function captureHoldMessage(path: string): string {
  return `dohc did not record the outside edit to "${path}". ${CAPTURE_HELD_WORDS}`;
}

export function useCaptureHoldNotices(input: {
  workspaceId: string;
  heldFiles: readonly CaptureFileHold[] | undefined;
  show: ReturnType<typeof useShellError>["showCaptureHolds"];
  reportShellError: ReturnType<typeof useShellError>["reportShellError"];
  reportShellFailure: ReturnType<typeof useShellError>["reportShellFailure"];
}) {
  const latest = useRef(input);
  latest.current = input;
  const requests = useRequestSequence([input.workspaceId]);
  const retry = useCallback(async (path: string) => {
    const workspaceId = input.workspaceId;
    const token = requests.current();
    const current = () => requests.isCurrent(token) && latest.current.workspaceId === workspaceId;
    try {
      const result = await bridge().retryHeldCapture({ workspaceId, path });
      if (!current()) return;
      if (result.degraded) {
        latest.current.reportShellError("dohc could not record outside edits. Reopen the workspace.", undefined, () => void retry(path));
      } else if (result.heldFiles.some(file => file.path === path && file.workspaceId === workspaceId) &&
        latest.current.heldFiles?.some(file => file.path === path && file.workspaceId === workspaceId)) {
        reportHeld(path);
      }
    } catch (error) {
      if (!current()) return;
      reportHeld(path, error);
    }
  }, [input.workspaceId, requests]);

  function reportHeld(path: string, cause?: unknown) {
    latest.current.reportShellFailure({ title: "Outside edit not recorded", tone: "warning",
      message: captureHoldMessage(path), cause, details: [["File", path, path.length]],
      retry: () => void retry(path), kind: "capture-held", identity: `capture-held:${path}` });
  }

  function publish(files: readonly CaptureFileHold[]) {
    latest.current.show(files.filter(file => file.workspaceId === input.workspaceId).map(file => ({
      path: file.path,
      message: captureHoldMessage(file.path),
      retry: () => void retry(file.path),
    })));
  }
  useEffect(() => {
    if (input.heldFiles === undefined) return;
    publish(input.heldFiles);
  }, [input.workspaceId, input.heldFiles, requests, input.show]);
  return retry;
}
