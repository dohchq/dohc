import { useCallback, useEffect, useRef } from "react";
import type { CaptureFileHold } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { useShellError } from "./useShellError";

export function captureHoldMessage(path: string): string {
  return `dohc did not record the outside edit to "${path}". This file is still on this computer. Edit it in another editor so dohc can read it, or choose Try again.`;
}

export function useCaptureHoldNotices(input: {
  workspaceId: string;
  heldFiles: readonly CaptureFileHold[] | undefined;
  show: ReturnType<typeof useShellError>["showCaptureHolds"];
  reportShellError: ReturnType<typeof useShellError>["reportShellError"];
}) {
  const latest = useRef(input);
  latest.current = input;
  const requests = useRequestSequence([input.workspaceId]);
  const retry = useCallback(async (path: string) => {
    const workspaceId = input.workspaceId;
    const token = requests.next();
    const current = () => requests.isCurrent(token) && latest.current.workspaceId === workspaceId;
    try {
      const result = await bridge().retryHeldCapture({ workspaceId, path });
      if (!current()) return;
      publish(result.heldFiles);
      if (result.degraded) {
        latest.current.reportShellError("dohc could not record outside edits. Reopen the workspace and try again.", undefined, () => void retry(path));
      }
    } catch (error) {
      if (!current()) return;
      latest.current.reportShellError(captureHoldMessage(path), error, () => void retry(path), "capture-held", `capture-held:${path}`);
    }
  }, [input.workspaceId, requests]);

  function publish(files: readonly CaptureFileHold[]) {
    latest.current.show(files.filter(file => file.workspaceId === input.workspaceId).map(file => ({
      path: file.path,
      message: captureHoldMessage(file.path),
      retry: () => void retry(file.path),
    })));
  }
  useEffect(() => {
    if (input.heldFiles === undefined) return;
    // A newer status supersedes a retry already on its way.
    requests.next();
    publish(input.heldFiles);
  }, [input.workspaceId, input.heldFiles, requests, input.show]);
}
