import { useEffect, useRef } from "react";
import type { DirectWriteRow } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// How long saves settle before a push. A burst of saves makes one push.
export const DIRECT_WRITE_PUSH_DELAY_MS = 800;

export type DirectWriteNoticeKind = "direct-write-stale" | "direct-write-refused" | "direct-write-failed";

export interface DirectWriteNotice {
  kind: DirectWriteNoticeKind;
  message: string;
  retry: (() => void) | null;
  sendAsProposal: (() => void) | null;
}

// After a save in an Edit share view, the shell pushes the change to a
// Collection's own files straight into the owner's workspace (ADR 0013).
// A write that went is silent: the save already showed it. A stale or
// refused write stays for Send changes, and its notice offers that.
export function useShareDirectWrites(input: {
  workspaceId: string;
  // An Edit share view that has not ended and whose grant is readable.
  enabled: boolean;
  ownerName: string;
  refreshShareView(): Promise<void>;
  sendShareChanges(): Promise<void>;
  showNotice(notice: DirectWriteNotice): void;
}): void {
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (!input.enabled) return;
    const workspaceId = input.workspaceId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;

    const push = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const result = await bridge().pushShareDirectWrites({ workspaceId });
        if (disposed) return;
        report(result.ok ? result.writes : null, result.ok ? null : result.errorMessage);
      } catch (error) {
        if (!disposed) report(null, error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          void push();
        }
      }
    };

    const report = (writes: DirectWriteRow[] | null, failure: string | null): void => {
      const { ownerName, showNotice, refreshShareView, sendShareChanges } = latest.current;
      const sendAsProposal = () => void sendShareChanges();
      if (writes === null) {
        showNotice({
          kind: "direct-write-failed",
          message: `dohc could not send your Collection changes to ${ownerName}.${failure ? ` ${failure}` : ""}`,
          retry: () => void push(),
          sendAsProposal: null,
        });
        return;
      }
      const stale = writes.filter((write) => write.result === "stale");
      const refused = writes.filter((write) => write.result === "refused");
      if (stale.length > 0) {
        // Bring in the owner's version, so the person sees what changed.
        void refreshShareView().catch(() => undefined);
        showNotice({
          kind: "direct-write-stale",
          message: `${writesLabel(stale)} changed before your change reached ${ownerName}. Check the new version, or send yours as a proposal.`,
          retry: null,
          sendAsProposal,
        });
      }
      if (refused.length > 0) {
        showNotice({
          kind: "direct-write-refused",
          message: `dohc could not save your change to ${writesLabel(refused)} directly. Send it to ${ownerName} as a proposal.`,
          retry: null,
          sendAsProposal,
        });
      }
    };

    const unsubscribe = bridge().onShareViewEdited((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void push();
      }, DIRECT_WRITE_PUSH_DELAY_MS);
    });
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [input.enabled, input.workspaceId]);
}

// The name a person knows a write by: its Collection's folder for a new
// Collection, else the folder and file, as "packing/automations.yaml".
function writeLabel(write: DirectWriteRow): string {
  if (write.paths.length > 1) {
    return write.paths[0]!.split("/").slice(-2, -1)[0] ?? write.paths[0]!;
  }
  const path = write.result === "stale" ? write.stalePath : write.paths[0]!;
  return path.split("/").slice(-2).join("/");
}

function writesLabel(writes: readonly DirectWriteRow[]): string {
  const first = writeLabel(writes[0]!);
  return writes.length === 1 ? first : `${first} and ${writes.length - 1} more`;
}
