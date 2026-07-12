import { Check, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPermissionDecision } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { AgentPermissionRequest } from "./useAgentNotifications";

// Floating permission cards (update-toast position, bottom-right): THE place
// a blocked agent run asks the user for consent. Requests arrive through the
// shell's session poll (useAgentNotifications) from any run source — "Try it
// in a version", chat dispatch, an MCP-connected agent — and answering
// resumes the run. This replaced the retired Agent panel's permission
// section: review gates must never weaken (AGENTS.md), so the ask surfaces
// wherever the user already is instead of inside a dedicated agent view.

function permissionDecision(kind: string): AgentPermissionDecision {
  if (
    kind === "allow_once" ||
    kind === "allow_always" ||
    kind === "reject_once" ||
    kind === "reject_always"
  ) {
    return kind;
  }
  return "cancel";
}

export function AgentPermissionRequests(props: {
  workspaceId: string;
  // The run the requests belong to (session runId). Optimistic-hide keys are
  // scoped by it: a LATER run reusing a provider request id must ask again,
  // never inherit an old answer.
  runId: string | null;
  requests: readonly AgentPermissionRequest[];
}) {
  const { workspaceId, runId, requests } = props;
  // Optimistic hide: an answered request disappears immediately; the session
  // poll confirms within a tick. A failed answer restores the card with the
  // error, and every async result is epoch-gated so a slow response for
  // workspace A never touches workspace B's cards (product invariant).
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);
  const keyOf = useCallback(
    (requestId: string) => `${runId ?? ""}\0${requestId}`,
    [runId],
  );
  useEffect(() => {
    epochRef.current += 1;
    setAnswered(new Set());
    setError(null);
  }, [workspaceId]);
  // Release an answered key once the poll confirms the request is gone (or
  // the run changed) — a kept key could silently hide a future ask forever.
  useEffect(() => {
    setAnswered((prev) => {
      const live = new Set(requests.map((request) => keyOf(request.requestId)));
      const next = new Set([...prev].filter((key) => live.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [requests, keyOf]);

  const visible = requests.filter((request) => !answered.has(keyOf(request.requestId)));
  if (visible.length === 0) return null;

  async function answer(requestId: string, decision: AgentPermissionDecision) {
    const epoch = epochRef.current;
    const key = keyOf(requestId);
    setAnswered((prev) => new Set(prev).add(key));
    setError(null);
    try {
      await bridge().answerAgentPermission({ workspaceId, requestId, decision });
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setAnswered((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setError(cause instanceof Error ? cause.message : "Could not answer the request.");
    }
  }

  return (
    <div
      data-testid="agent-permission-requests"
      // Top-right alert stack: clear of the bottom-right corner the update
      // toast and NoticeCenter popover share. z-40 keeps a consent ask above
      // the modal overlays (z-30) — it must stay answerable while Settings /
      // palette / share dialogs are open. Bounded + scrollable so even the
      // contract's 20-request maximum keeps every decision reachable.
      className="fixed right-3 top-12 z-40 flex max-h-[calc(100vh-6rem)] w-[min(380px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto"
    >
      {visible.map((request) => (
        <section
          key={request.requestId}
          data-testid="agent-permission-request"
          role="alertdialog"
          aria-label={`Agent permission: ${request.title}`}
          className="dohc-popover dohc-pop-in rounded-lg border border-line bg-panel p-3"
        >
          <div className="mb-1 flex items-center gap-2">
            <ShieldAlert size={13} aria-hidden className="shrink-0 text-warning" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Your agent asked
            </span>
          </div>
          <h3 className="m-0 mb-1 text-[13px] font-medium leading-snug text-ink">
            {request.title}
          </h3>
          {request.detail ? (
            <div className="mb-2 text-[12px] leading-snug text-muted">{request.detail}</div>
          ) : null}
          {request.locations && request.locations.length > 0 ? (
            <div data-testid="agent-permission-locations" className="mb-2 grid gap-1">
              {request.locations.map((location) => (
                <code
                  key={location}
                  className="truncate rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink"
                >
                  {location}
                </code>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {request.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                data-testid={`agent-permission-${option.kind}`}
                onClick={() => void answer(request.requestId, permissionDecision(option.kind))}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-[12px] text-ink transition-colors hover:bg-panel-2"
              >
                {option.kind.startsWith("allow") ? (
                  <Check size={12} aria-hidden />
                ) : (
                  <X size={12} aria-hidden />
                )}
                {option.name}
              </button>
            ))}
          </div>
        </section>
      ))}
      {error ? (
        <div
          data-testid="agent-permission-error"
          role="status"
          className="dohc-popover rounded-md border border-line bg-panel px-3 py-2 text-[11px] text-danger"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
