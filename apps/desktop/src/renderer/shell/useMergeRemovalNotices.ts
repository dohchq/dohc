import { quoteRemovedText } from "@dohc/ydoc-projection/removed-text";
import { useEffect, useMemo, useRef } from "react";
import type { CaptureRecoveryStatusResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import { engineMomentAuthorName } from "../workbench/EngineHistory";
import type { MergeRemovalNotice } from "./useShellError";

type MergeRemoval = CaptureRecoveryStatusResult["mergeRemovals"][number];

export const MERGE_REMOVAL_TITLE = "Text removed when two changes met";

// The quote keeps the removed text's own lines. A long one is cut, and Copy
// text still copies all of it. The engine sends only the text's start, longer
// than any quote, and the whole length.
export function mergeRemovalWords(
  removal: { quote: string; length: number },
  author: string | undefined,
): { message: string; lastLine?: string } {
  const { quoted, more: unquoted } = quoteRemovedText(removal.quote);
  const more = unquoted + removal.length - removal.quote.length;
  const message =
    more > 0
      ? `"${quoted}"\nAnd ${more.toLocaleString()} more characters. Copy text copies all of it.`
      : `"${quoted}"`;
  return author === undefined
    ? { message }
    : { message, lastLine: `${author}'s change deleted the line it was in.` };
}

/**
 * Tells the person about text the engine kept when a change from elsewhere
 * removed it unseen: one Notices row each, with the text quoted and Copy
 * text, until a dismissal clears it in the engine. The engine's list is read
 * when the workspace opens and again from the returned refresh, which the
 * shell runs after workspace activity. The record names the change's author
 * when the engine knew it; History names them the same way.
 */
export function useMergeRemovalNotices(input: {
  workspaceId: string;
  workspaceIsReady: boolean;
  show: (removals: readonly MergeRemovalNotice[]) => void;
  reportShellError: (fallback: string, error: unknown, retry: (() => void) | null) => void;
}) {
  const { workspaceId, workspaceIsReady } = input;
  const reads = useRequestSequence([workspaceId]);
  const latest = useRef(input);
  latest.current = input;

  // One workspace's notices. A switch starts over, and an answer for the
  // workspace the window left changes nothing.
  const notices = useMemo(() => {
    const here = () => latest.current.workspaceId === workspaceId;
    // Each record's author, read once from its History change.
    const authors = new Map<string, string | undefined>();
    // The engine's newest list.
    let listed: readonly MergeRemoval[] = [];
    // The newest Copy text click.
    let copying = 0;

    // Only a removal whose dismissal the engine refused raises its toast again.
    const publish = (raised?: string) =>
      latest.current.show(
        listed.map((removal) => ({
          momentId: removal.momentId,
          path: removal.path,
          title: MERGE_REMOVAL_TITLE,
          ...mergeRemovalWords(removal, authors.get(removal.momentId)),
          raise: removal.momentId === raised,
          copy: () => copy(removal),
          dismiss: () => clear(removal),
        })),
      );

    const copy = (removal: MergeRemoval): void => {
      const failed = (error: unknown) => {
        if (here())
          latest.current.reportShellError("dohc could not copy the removed text.", error, () =>
            copy(removal),
          );
      };
      const clipboard = navigator.clipboard;
      if (!clipboard) return failed(new Error("The clipboard is not available."));
      const request = ++copying;
      if (removal.quote.length === removal.length) {
        clipboard.writeText(removal.quote).catch(failed);
        return;
      }
      // The rest of the text is in its History change.
      bridge()
        .readEngineMoment({ workspaceId, momentId: removal.momentId })
        .then(({ moment }) => {
          // A later Copy, or leaving the workspace, wins over this one.
          if (request !== copying || !here()) return;
          if (typeof moment?.beforeText !== "string")
            throw new Error("The text is too long to copy here. Open its change in History.");
          return clipboard.writeText(moment.beforeText);
        })
        .catch(failed);
    };

    const named = async (removal: MergeRemoval): Promise<void> => {
      if (!removal.authorKnown || authors.has(removal.momentId)) return;
      const { moment } = await bridge().readEngineMoment({
        workspaceId,
        momentId: removal.momentId,
      });
      authors.set(removal.momentId, moment ? engineMomentAuthorName(moment) : undefined);
    };

    const refresh = async (): Promise<void> => {
      const request = reads.next();
      try {
        const { mergeRemovals } = await bridge().getCaptureRecoveryStatus({ workspaceId });
        if (!reads.isCurrent(request) || !here()) return;
        await Promise.all(mergeRemovals.map(named));
        if (!reads.isCurrent(request) || !here()) return;
        listed = mergeRemovals;
        publish();
      } catch (error) {
        if (!reads.isCurrent(request) || !here()) return;
        latest.current.reportShellError(
          "dohc could not check for text a change removed.",
          error,
          () => void refresh(),
        );
      }
    };

    // Persists that the person is done with this text, so its notice never
    // returns on a later launch. The text stays in History.
    const clear = (removal: MergeRemoval): void => {
      // A read already on its way may still list it.
      reads.next();
      void bridge()
        .clearCaptureRecovery({ workspaceId, momentId: removal.momentId })
        .then(() => {
          if (here()) void refresh();
        })
        .catch((error: unknown) => {
          if (!here()) return;
          // The engine still lists it, so its row comes back.
          publish(removal.momentId);
          latest.current.reportShellError(
            `dohc could not remove the notice about "${removal.path}".`,
            error,
            () => clear(removal),
          );
        });
    };

    return { refresh };
  }, [reads, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void notices.refresh();
  }, [notices, workspaceIsReady]);

  return notices;
}
