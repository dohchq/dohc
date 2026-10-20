import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTrustAnswer } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

/**
 * Whether this computer trusts a workspace to run its apps' code: true, false
 * in Restricted Mode, or null until main answers. Main decides and enforces
 * it; this only follows it. Every answer names its workspace, so a slow answer
 * for one workspace never shows for another.
 */
export function useWorkspaceTrust(workspaceId: string, enabled: boolean) {
  const [answer, setAnswer] = useState<WorkspaceTrustAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  // Moves on each new workspace and each change main announces, so an older
  // read never paints over a newer answer.
  const sequence = useRef(0);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const show = useCallback((next: WorkspaceTrustAnswer) => {
    if (next.workspaceId === workspaceRef.current) setAnswer(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const request = ++sequence.current;
    const unsubscribe = bridge().onWorkspaceTrustChanged((event) => {
      if (event.workspaceId !== workspaceId) return;
      sequence.current += 1;
      show(event);
    });
    void bridge().readWorkspaceTrust({ workspaceId }).then(
      (read) => { if (request === sequence.current) show(read); },
      // Unknown stays unknown. Main still refuses every app command.
      () => undefined,
    );
    return () => {
      sequence.current += 1;
      unsubscribe();
    };
  }, [enabled, show, workspaceId]);

  // Opens main's dialog. Only the person's answer there trusts the workspace.
  const requestTrust = useCallback(async () => {
    setAsking(true);
    try {
      const next = await bridge().requestWorkspaceTrust({ workspaceId });
      sequence.current += 1;
      show(next);
      return next.trusted;
    } finally {
      setAsking(false);
    }
  }, [show, workspaceId]);

  const restrict = useCallback(async () => {
    const next = await bridge().restrictWorkspace({ workspaceId });
    sequence.current += 1;
    show(next);
  }, [show, workspaceId]);

  return {
    trusted: enabled && answer?.workspaceId === workspaceId ? answer.trusted : null,
    asking,
    requestTrust,
    restrict,
  };
}
