import { useEffect, useRef } from "react";
import type { DirectWriteRow, PushShareDirectWritesResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// Share views whose relay answered that it takes no direct writes, with its
// notice shown. Main stops asking until the app restarts, and the notice
// shows once.
const unavailableShown = new Set<string>();

export type DirectWriteNoticeKind =
  | "direct-write-stale"
  | "direct-write-refused"
  | "direct-write-failed"
  | "direct-write-unavailable";

export interface DirectWriteNotice {
  kind: DirectWriteNoticeKind;
  message: string;
  retry: (() => void) | null;
  // Sends the waiting changes for the owner to review.
  send: { label: string; run: () => void } | null;
}

// After a save in an Edit share view, main pushes the change to a
// Collection's own files straight into the owner's workspace (ADR 0013), and
// this shell shows how it ended. A write that went is silent: the save
// already showed it. A stale or refused write stays for Send changes, and its
// notice offers that.
//
// The engine's journal keeps every change until a push decides it, so the
// view also pushes when it opens: changes from before this session go then.
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

    const push = async (): Promise<void> => {
      let result: PushShareDirectWritesResult;
      try {
        result = await bridge().pushShareDirectWrites({ workspaceId });
      } catch (error) {
        result = {
          status: "failed",
          writes: [],
          errorMessage: error instanceof Error ? error.message : String(error),
          lasting: false,
        };
      }
      if (!disposed) report(result);
    };

    const report = (result: PushShareDirectWritesResult): void => {
      const { ownerName, showNotice, refreshShareView, sendShareChanges } = latest.current;
      const sendAsProposal = { label: "Send as proposal", run: () => void sendShareChanges() };
      if (result.status === "unavailable") {
        if (unavailableShown.has(workspaceId)) return;
        unavailableShown.add(workspaceId);
        showNotice({
          kind: "direct-write-unavailable",
          message: `${ownerName}'s server doesn't take Collection changes directly. Send your changes for ${ownerName} to review.`,
          retry: null,
          send: { label: "Send changes", run: () => void sendShareChanges() },
        });
        return;
      }
      const stale = result.writes.filter((write) => write.result === "stale");
      const refused = result.writes.filter(
        (write): write is Extract<DirectWriteRow, { result: "refused" }> => write.result === "refused",
      );
      if (stale.length > 0) {
        // Bring in the owner's version, so the person sees what changed.
        void refreshShareView().catch(() => undefined);
        showNotice({
          kind: "direct-write-stale",
          message: `${writesLabel(stale)} changed before your change reached ${ownerName}. Check the new version, or send yours as a proposal.`,
          retry: null,
          send: sendAsProposal,
        });
      }
      const lasting = result.status === "failed" && result.lasting;
      // A lasting failure shares the refused row, so it carries the refusal too.
      const refusal = refused.length > 0 ? refusalSentence(ownerName, refused) : "";
      if (refused.length > 0 && !lasting) {
        showNotice({
          kind: "direct-write-refused",
          message: `${refusal} Send ${refused.length === 1 ? "it" : "them"} as a proposal.`,
          retry: null,
          send: sendAsProposal,
        });
      }
      if (result.status !== "failed") return;
      showNotice(lasting
        ? {
            kind: "direct-write-refused",
            message: `${refusal ? `${refusal} ` : ""}${ownerName}'s share doesn't take your Collection changes directly. Send them as a proposal.`,
            retry: null,
            send: sendAsProposal,
          }
        : {
            kind: "direct-write-failed",
            message: `dohc could not send your Collection changes to ${ownerName}.${result.errorMessage ? ` ${result.errorMessage}` : ""}`,
            retry: () => void push(),
            send: null,
          });
    };

    // Anything a closed view left unsent goes now.
    void push();
    const unsubscribe = bridge().onShareDirectWritesPushed((event) => {
      if (event.workspaceId === workspaceId && !disposed) report(event.result);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [input.enabled, input.workspaceId]);
}

// Why the relay refused: its reason alone, which already starts with the
// file's path, or the file when the relay gave no reason.
function refusalSentence(ownerName: string, refused: ReadonlyArray<Extract<DirectWriteRow, { result: "refused" }>>): string {
  const reason = refused[0]!.reason.trim().replace(/[.\s]+$/u, "");
  const changes = refused.length === 1 ? "your change" : `${refused.length} of your changes`;
  return reason
    ? `${ownerName}'s server didn't take ${changes}: ${reason}.`
    : `${ownerName}'s server didn't take your change to ${writesLabel(refused)}.`;
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
