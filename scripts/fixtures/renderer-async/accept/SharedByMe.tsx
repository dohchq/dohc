import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare const workspaceOutcomes: { live(): boolean };
declare function postUndo(token: unknown, shareId: string): void;
declare function postFailure(error: unknown, shareId: string, retry: () => void): void;
export function SharedByMe() {
  const [, setConfirm] = useState<string | null>(null);
  const onRevoked = useCallback(() => { setConfirm(null); }, []);
  const [revoke, revoking] = useDesktopCommand([], "revokeRelayShare",
    { scope: workspaceOutcomes, success: (result: any, _input: any, labels: any) => postUndo(result.undo, labels.recipient), failure: (error: unknown, _input: any, retry: () => void, labels: any) => postFailure(error, labels.recipient, retry) },
    { success: onRevoked });
  return revoking;
}
