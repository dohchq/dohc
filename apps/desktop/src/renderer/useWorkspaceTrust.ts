import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTrustAnswer } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

/**
 * Whether this computer trusts a workspace to run its apps' code: true, false
 * in Restricted Mode, or null until main answers. Main decides and enforces
 * it; this only follows it.
 *
 * Every answer is guarded: a read, or the reply to Trust workspace or
 * Restricted Mode, shows only while the hook still shows its workspace and
 * nothing newer arrived. A change main announces is always newest.
 */
export function useWorkspaceTrust(
  workspaceId: string,
  enabled: boolean,
  // A failed read, with a way to read again.
  onReadError?: (error: unknown, retry: () => void) => void,
) {
  const [answer, setAnswer] = useState<WorkspaceTrustAnswer | null>(null);
  const [readFailedFor, setReadFailedFor] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ workspaceId: string; token: number } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  // Moves when the workspace changes and when main announces a change.
  const changes = useRef(0);
  // Moves when an action's reply shows, so an older read does not paint over it.
  const applied = useRef(0);
  // The newest action. Only its reply shows.
  const actions = useRef(0);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const onReadErrorRef = useRef(onReadError);
  onReadErrorRef.current = onReadError;

  useEffect(() => {
    if (!enabled) return;
    changes.current += 1;
    const atStart = { changes: changes.current, applied: applied.current };
    const unsubscribe = bridge().onWorkspaceTrustChanged((event) => {
      if (event.workspaceId !== workspaceId) return;
      changes.current += 1;
      setReadFailedFor(null);
      setAnswer(event);
    });
    void bridge().readWorkspaceTrust({ workspaceId }).then(
      (read) => {
        if (changes.current !== atStart.changes || applied.current !== atStart.applied) return;
        if (read.workspaceId !== workspaceId) return;
        setReadFailedFor(null);
        setAnswer(read);
      },
      (error: unknown) => {
        if (changes.current !== atStart.changes) return;
        setReadFailedFor(workspaceId);
        onReadErrorRef.current?.(error, () => setReadAttempt((attempt) => attempt + 1));
      },
    );
    return () => {
      changes.current += 1;
      unsubscribe();
    };
  }, [enabled, readAttempt, workspaceId]);

  const act = useCallback(async (call: (workspaceId: string) => Promise<WorkspaceTrustAnswer>) => {
    const token = ++actions.current;
    const changesAtStart = changes.current;
    setAsking({ workspaceId, token });
    try {
      const next = await call(workspaceId);
      if (token === actions.current && changes.current === changesAtStart && next.workspaceId === workspaceRef.current) {
        applied.current += 1;
        setReadFailedFor(null);
        setAnswer(next);
      }
      return next.trusted;
    } finally {
      setAsking((current) => (current?.token === token ? null : current));
    }
  }, [workspaceId]);

  // Opens main's dialog. Only the person's answer there trusts the workspace.
  // Automatic: a send asked for it, so main opens it only once.
  const requestTrust = useCallback(
    (automatic?: true) => act((id) => bridge().requestWorkspaceTrust({ workspaceId: id, ...(automatic ? { automatic } : {}) })),
    [act],
  );
  const restrict = useCallback(
    async () => { await act((id) => bridge().restrictWorkspace({ workspaceId: id })); },
    [act],
  );

  const shown = enabled && answer?.workspaceId === workspaceId ? answer.trusted : null;
  return {
    trusted: shown,
    // Main did not answer for this workspace. Nothing that runs app code starts.
    readFailed: enabled && shown === null && readFailedFor === workspaceId,
    asking: asking?.workspaceId === workspaceId,
    requestTrust,
    restrict,
  };
}
