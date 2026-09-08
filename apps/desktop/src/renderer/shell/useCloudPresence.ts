import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { buildChatCollaboration } from "../collab/chatCollaboration";

export function useCloudPresence(workspaceId: string) {
  // MU-C5 presence: the signed-in relay session, if any. Drives whether Chats
  // gets a live presence transport (connected + relayUrl) or stays dormant.
  const [cloudStatus, setCloudStatus] = useState<CloudStatusResult | null>(null);
  // Stable per-session client id so this device's own presence entry is
  // identifiable and filtered out of "others". Lazily minted once — a fresh id
  // per render would churn the presence channel.
  const [presenceClientId] = useState(() => crypto.randomUUID());

  // MU-C5 presence: track the signed-in relay session for this workspace. The
  // request token + workspaceId key uphold the no-repaint invariant — a slow
  // cloud-status response for workspace A must never set state after a switch
  // to B. `refreshCloudStatus` is also called when the cloud dialog closes so a
  // fresh sign-in lights presence up without waiting for a workspace switch.
  const cloudStatusToken = useRef(0);
  const refreshCloudStatus = useCallback(() => {
    const token = ++cloudStatusToken.current;
    bridge()
      .cloudStatus({ workspaceId })
      .then((status) => {
        if (token === cloudStatusToken.current) setCloudStatus(status);
      })
      .catch(() => {
        if (token === cloudStatusToken.current) setCloudStatus(null);
      });
  }, [workspaceId]);
  useEffect(() => {
    setCloudStatus(null);
    refreshCloudStatus();
    return () => {
      // A pending response after unmount / switch must never repaint.
      cloudStatusToken.current += 1;
    };
  }, [refreshCloudStatus]);
  // The session signal reaches the SHELL too: cloudStatus derives the
  // presence collaboration, so a sign-out must tear the old account's
  // presence down now — dropping the status rebuilds the collaboration
  // dormant and aborts its long poll — not when some later refresh notices.
  // The token bump also stops a stale connected response from repainting;
  // the refresh then reports the new session's truth.
  useEffect(() => {
    return bridge().onCloudSessionChanged(() => {
      cloudStatusToken.current += 1;
      setCloudStatus(null);
      refreshCloudStatus();
    });
  }, [refreshCloudStatus]);

  // The presence collaboration for the active workspace, rebuilt per workspace
  // (keyed by workspaceId) so a switch tears the old transport down and aborts
  // its in-flight poll — dormant (null) when signed out / no relay.
  const chatCollaboration = useMemo(
    () =>
      buildChatCollaboration({
        connected: cloudStatus?.connected ?? false,
        relayUrl: cloudStatus?.relayUrl,
        email: cloudStatus?.email,
        workspaceId,
        clientId: presenceClientId,
      }),
    [
      cloudStatus?.connected,
      cloudStatus?.relayUrl,
      cloudStatus?.email,
      workspaceId,
      presenceClientId,
    ],
  );

  return { chatCollaboration, refreshCloudStatus };
}
