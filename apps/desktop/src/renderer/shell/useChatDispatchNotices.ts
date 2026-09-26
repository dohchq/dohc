import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

export function useChatDispatchNotices(
  workspaceId: string,
  report: ReturnType<typeof useShellError>["reportShellFailure"],
) {
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  useEffect(() => {
    let active = true;
    const unsubscribe = bridge().onChatDispatchUnavailable((event) => {
      if (!active || currentWorkspace.current !== workspaceId || event.workspaceId !== workspaceId) return;
      const why = event.reason === "disabled"
        ? "Agent dispatch is off."
        : "No agent runner is configured.";
      report({
        message: `No agent could take this request. ${why} Set up agent dispatch in Settings → Agents & MCP.`,
        kind: "chat-no-runner",
      });
    });
    return () => { active = false; unsubscribe(); };
  }, [workspaceId, report]);
}
