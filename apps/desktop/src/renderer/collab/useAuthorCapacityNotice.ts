import { useEffect, useRef } from "react";
import type { ReportButtonError } from "../collections/useAutomationButtons";
import type { EngineDocSaveState } from "./engineDocLease";

export function useAuthorCapacityNotice(input: {
  workspaceId: string;
  path: string;
  authorCapacity: boolean;
  saveState: EngineDocSaveState;
  reportError?: ReportButtonError;
  retry: () => void;
}): void {
  const reported = useRef<string | null>(null);
  const current = useRef(input);
  current.current = input;
  const key = JSON.stringify([input.workspaceId, input.path]);
  useEffect(() => {
    if (input.saveState === "saved" || input.saveState === "saved-to-host") {
      reported.current = null;
    }
    if (!input.authorCapacity || !input.reportError || reported.current === key) return;
    reported.current = key;
    const message = `dohc could not save ${input.path}. This file has too many pending authors. Try again to save this edit.`;
    input.reportError(message, new Error(message), () => {
      if (JSON.stringify([current.current.workspaceId, current.current.path]) !== key) return;
      current.current.retry();
    });
  }, [key, input.authorCapacity, input.saveState, input.reportError]);
}
