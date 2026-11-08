import { useCallback, useMemo, useReducer, useRef } from "react";
import type { RelayShareUndoReceipt } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";

// The relay keeps a removal's receipt for 10 minutes. The notice states that,
// and a late Undo explains itself instead of asking the relay to fail.
export const SHARE_UNDO_WINDOW = "You can undo this for 10 minutes.";
export const SHARE_UNDO_EXPIRED =
  "The 10 minutes to undo this have passed. Share again to give access back.";
export const SHARE_UNDO_FAILED = "dohc could not undo this removal.";

export type ShareRemoval = {
  workspaceId: string;
  // A Change, in the surface's own nouns: "Removed ana@example.com from Trip."
  message: string;
  // The Change the Undo makes: "Restored ana@example.com to Trip."
  restoredMessage: string;
  shareId: string;
  undo?: RelayShareUndoReceipt;
  // Runs after access is back, so a list that is still open reads it again.
  restored?: () => void;
};
export type ReportShareRemoval = (removal: ShareRemoval) => void;

// A removal the relay refused. The shell files it with Try again, which runs
// the removal again, and the cause for Copy details.
export type ShareRemovalFailure = {
  workspaceId: string;
  // What did not happen, in the surface's own nouns: "dohc could not end the link to Trip."
  message: string;
  cause: unknown;
  retry?: () => void;
  // What failed, such as one agent's Disconnect. A later failure of the same
  // thing replaces its row.
  identity?: string;
};

export type DisconnectedLinkAgent = { workspaceId: string; grantId: string; connectionId: string };

// One agent's Disconnect, as the shell names its failure.
export function agentDisconnectIdentity(grantId: string, connectionId: string): string {
  return `share-link-agent-disconnect:${grantId}:${connectionId}`;
}

// An agent's key in the shell's set of disconnected agents.
export function disconnectedAgentKey(agent: DisconnectedLinkAgent): string {
  return `${agent.workspaceId}\n${agentDisconnectIdentity(agent.grantId, agent.connectionId)}`;
}

function addDisconnectedAgent(current: ReadonlySet<string>, agent: DisconnectedLinkAgent): ReadonlySet<string> {
  const key = disconnectedAgentKey(agent);
  return current.has(key) ? current : new Set(current).add(key);
}

const NO_DISCONNECTED_AGENTS: ReadonlySet<string> = new Set();

/**
 * The agents the owner disconnected while dohc ran, by disconnectedAgentKey.
 * The shell holds it so a Disconnect that Try again finishes in Notices
 * leaves any Share dialog open then, or opened later, without the agent. Only
 * the Share dialog reads it, so a Disconnect re-renders nothing else.
 */
export function useDisconnectedLinkAgents() {
  return useReducer(addDisconnectedAgent, NO_DISCONNECTED_AGENTS);
}

export interface ShareRemovalNotices {
  removed: ReportShareRemoval;
  failed: (failure: ShareRemovalFailure) => void;
  // An agent's Disconnect succeeded, from a Share dialog or from Try again:
  // its failure's toast and row go, and every Agents list drops it.
  agentDisconnected: (agent: DisconnectedLinkAgent) => void;
}

// A removal an owner made: a toast and a Notices row with Undo. The notice is
// the shell's, so Undo outlives the dialog or panel that removed the access.
// Undo puts back the grants the removal ended; it never makes a new one.
export function useShareRemovalNotices(input: {
  workspaceId: string;
  showSuccessNotice: (message: string, undo?: () => void) => void;
  reportShellFailure: (failure: {
    message: string;
    cause?: unknown;
    retry?: (() => void) | null;
    identity?: string;
  }) => void;
  clearIdentity: (identity: string) => void;
  // A share ended or came back, whichever surface or retry did it, so a list
  // still open reads again.
  onSharesChanged?: () => void;
  // An agent's Disconnect succeeded: useDisconnectedLinkAgents' dispatch.
  onAgentDisconnected?: (agent: DisconnectedLinkAgent) => void;
}): ShareRemovalNotices {
  const workspaceIdRef = useRef(input.workspaceId);
  workspaceIdRef.current = input.workspaceId;
  const { showSuccessNotice, reportShellFailure, clearIdentity, onSharesChanged, onAgentDisconnected } = input;
  const removed = useCallback<ReportShareRemoval>(
    (removal) => {
      // A switch clears the shell's list, so an answer for the workspace this
      // removal came from must not land in another workspace's notices.
      const current = () => workspaceIdRef.current === removal.workspaceId;
      if (!current()) return;
      onSharesChanged?.();
      const receipt = removal.undo;
      if (!receipt) {
        showSuccessNotice(removal.message);
        return;
      }
      let busy = false;
      const undo = async () => {
        if (!current() || busy) return;
        if (Date.now() >= receipt.expiresAtMs) {
          reportShellFailure({ message: SHARE_UNDO_EXPIRED });
          return;
        }
        busy = true;
        try {
          await bridge().undoRelayShare({
            workspaceId: removal.workspaceId,
            shareId: removal.shareId,
            undoId: receipt.undoId,
          });
          if (!current()) return;
          showSuccessNotice(removal.restoredMessage);
          onSharesChanged?.();
          removal.restored?.();
        } catch (cause) {
          if (!current()) return;
          reportShellFailure({
            message: withErrorWords(SHARE_UNDO_FAILED, cause),
            cause,
            retry: () => void undo(),
          });
        } finally {
          busy = false;
        }
      };
      showSuccessNotice(`${removal.message} ${SHARE_UNDO_WINDOW}`, () => void undo());
    },
    [onSharesChanged, reportShellFailure, showSuccessNotice],
  );
  const failed = useCallback(
    (failure: ShareRemovalFailure) => {
      if (workspaceIdRef.current !== failure.workspaceId) return;
      reportShellFailure({
        message: withErrorWords(failure.message, failure.cause),
        cause: failure.cause,
        retry: failure.retry ?? null,
        ...(failure.identity !== undefined ? { identity: failure.identity } : {}),
      });
    },
    [reportShellFailure],
  );
  const agentDisconnected = useCallback(
    (agent: DisconnectedLinkAgent) => {
      onAgentDisconnected?.(agent);
      if (workspaceIdRef.current === agent.workspaceId) clearIdentity(agentDisconnectIdentity(agent.grantId, agent.connectionId));
    },
    [clearIdentity, onAgentDisconnected],
  );
  return useMemo(() => ({ removed, failed, agentDisconnected }), [removed, failed, agentDisconnected]);
}
