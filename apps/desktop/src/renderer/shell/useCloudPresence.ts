import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { isWorkspaceUpdatingError } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { buildChatCollaboration } from "../collab/chatCollaboration";

export function useCloudPresence(
  workspaceId: string,
  onStatusUnavailable: (retry: () => void) => void,
  workspaceIsReady: boolean,
) {
  // MU-C5 presence: the signed-in relay session, if any. Drives whether Chats
  // gets a live presence transport (connected + relayUrl) or stays dormant.
  // Scope the first render after a workspace switch, before effects run.
  const [scopedStatus, setScopedStatus] = useState<
    { workspaceId: string; status: CloudStatusResult } | null
  >(null);
  const cloudStatus =
    workspaceIsReady && scopedStatus?.workspaceId === workspaceId ? scopedStatus.status : null;
  // The workspace whose last status read failed, so "not read yet" and
  // "could not be read" stay apart. A read that answers clears it.
  const [unreadableFor, setUnreadableFor] = useState<string | null>(null);
  const cloudStatusUnreadable = cloudStatus === null && unreadableFor === workspaceId;
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
  // A workspace still taking in files is busy, not unreadable: its refusal
  // keeps the last status, and the next workspace activity reads again. An
  // activity that arrived while the refused read was out reads again at once.
  const readAgainOnActivity = useRef(false);
  const activityCount = useRef(0);
  const refreshCloudStatus = useCallback(() => {
    const token = ++cloudStatusToken.current;
    if (!workspaceIsReady) return;
    const activityAtRead = activityCount.current;
    bridge()
      .cloudStatus({ workspaceId })
      .then((status) => {
        if (token === cloudStatusToken.current) {
          setScopedStatus({ workspaceId, status });
          setUnreadableFor(null);
        }
      })
      .catch((error: unknown) => {
        if (token !== cloudStatusToken.current) return;
        if (isWorkspaceUpdatingError(error)) {
          if (activityCount.current !== activityAtRead) refreshCloudStatus();
          else readAgainOnActivity.current = true;
          return;
        }
        setScopedStatus(null);
        setUnreadableFor(workspaceId);
        onStatusUnavailable(() => {
          if (token === cloudStatusToken.current) refreshCloudStatus();
        });
      });
  }, [workspaceId, onStatusUnavailable, workspaceIsReady]);
  useEffect(() => {
    setScopedStatus(null);
    readAgainOnActivity.current = false;
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
      setScopedStatus(null);
      refreshCloudStatus();
    });
  }, [refreshCloudStatus]);
  const readCloudStatusAgainIfBusy = useCallback(() => {
    activityCount.current += 1;
    if (!readAgainOnActivity.current) return;
    readAgainOnActivity.current = false;
    refreshCloudStatus();
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

  const workspaceSynced = cloudStatus?.workspaceSynced === true;

  return {
    chatCollaboration,
    refreshCloudStatus,
    readCloudStatusAgainIfBusy,
    workspaceSynced,
    cloudStatus,
    cloudStatusUnreadable,
  };
}
