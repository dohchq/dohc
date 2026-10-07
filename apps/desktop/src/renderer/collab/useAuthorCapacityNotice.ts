import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { useEffect, useRef } from "react";
import { authorCapacityMessage } from "./authorCapacityMessage";
import type { ReportButtonError } from "../collections/useAutomationButtons";

export function useAuthorCapacityNotice(input: {
  workspaceId: string;
  path: string;
  authorCapacity: boolean;
  saveState: SaveState;
  reportError?: ReportButtonError;
  retry: () => void;
}): void {
  const reported = useRef<string | null>(null);
  const current = useRef(input);
  current.current = input;
  const key = JSON.stringify([input.workspaceId, input.path]);
  useEffect(() => {
    if (input.saveState.kind === "saved-here" || input.saveState.kind === "saved-to-host") {
      reported.current = null;
    }
    if (!input.authorCapacity || !input.reportError || reported.current === key) return;
    reported.current = key;
    const message = authorCapacityMessage(input.path);
    input.reportError(message, new Error(message), () => {
      if (JSON.stringify([current.current.workspaceId, current.current.path]) !== key) return;
      current.current.retry();
    });
  }, [key, input.authorCapacity, input.saveState, input.reportError]);
}
