import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import { useCallback, useRef } from "react";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { shareLevel, type MountedShare } from "../OpenSharedView";
import { useRequestSequence } from "../useRequestSequence";
import type { NoticeShare } from "./useSentNoticeProps";

export const OPEN_TO_EDIT = "Open to edit";
const LOOKUP_FAILED = "dohc could not open this share.";
const SHARE_MISSING =
  "dohc could not find this share in your account. The person who shared it may have ended it.";
const NO_LONGER_EDIT = "The owner changed your access to this share. It no longer opens to edit.";

export type EditCopy = { shareId: string; path: string | null };

export function editCopyAt(
  path: string | null,
  mounts: NonNullable<WorkspaceSummary["shareMounts"]>,
  signedIn: boolean,
): EditCopy | null {
  if (!signedIn || !path || !isSharedWithMePath(path)) return null;
  const [, label, ...inside] = path.split("/");
  const mount = mounts.find(
    (candidate) => candidate.label === label && candidate.access === "edit" && !candidate.ended,
  );
  return mount
    ? { shareId: mount.shareId, path: inside.length > 0 ? inside.join("/") : null }
    : null;
}

export function addedShareNotice(
  mounted: MountedShare,
  openToEdit: () => void,
): { message: string; action?: { label: string; run: () => void } } {
  const edit = mounted.access === "edit";
  return {
    message: mounted.alreadyAdded
      ? `${mounted.label} is already in shared-with-me.`
      : edit
        ? `Added ${mounted.label} to shared-with-me as a read-only copy.`
        : `Added ${mounted.label} to shared-with-me. Its files are read-only and stay up to date.`,
    ...(edit ? { action: { label: OPEN_TO_EDIT, run: openToEdit } } : {}),
  };
}

export function useOpenShareToEdit(input: {
  workspaceId: string;
  onOpenShare: (share: NoticeShare) => void;
  reportError: (message: string, cause: unknown, retry: (() => void) | null) => void;
}): (copy: EditCopy, stillWanted?: () => boolean) => Promise<void> {
  const requests = useRequestSequence([input.workspaceId]);
  const latest = useRef(input);
  latest.current = input;
  return useCallback(
    async function open(copy: EditCopy, stillWanted = () => true): Promise<void> {
      const request = requests.next();
      const wanted = () => requests.isCurrent(request) && stillWanted();
      const refuse = (message: string, cause: unknown) => {
        if (wanted())
          latest.current.reportError(message, cause, () => void open(copy, stillWanted));
      };
      let found;
      try {
        found = await bridge().getRelayReceivedShare({ shareId: copy.shareId });
      } catch (cause) {
        refuse(LOOKUP_FAILED, cause);
        return;
      }
      if (!wanted()) return;
      if (!found.found || "chats" in found) {
        refuse(SHARE_MISSING, new Error(SHARE_MISSING));
        return;
      }
      if (shareLevel(found.share) !== "edit") {
        refuse(NO_LONGER_EDIT, new Error(NO_LONGER_EDIT));
        return;
      }
      latest.current.onOpenShare({
        resolvedShare: { shareId: copy.shareId, shareCode: found.share.shareCode },
        level: "edit",
        path: copy.path,
      });
    },
    [requests],
  );
}
