import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { WorkReferenceView } from "../ipc/bridgeContract";

type WorkReferenceResolution = Awaited<ReturnType<VersionedLiveAdapter["resolveWorkReference"]>>;

/**
 * What a chat message's work link shows and where it opens, from the
 * engine's resolution of its reference. Work this workspace does not hold, or
 * no longer holds, opens nothing. A transactional table or row has no place
 * to open yet.
 */
export function workReferenceView(reference: string, resolution: WorkReferenceResolution | null): WorkReferenceView {
  const unavailable: WorkReferenceView = { reference, kind: null, label: "", open: null };
  if (resolution?.status !== "found" || resolution.state === "deleted") return unavailable;
  const { target, path, title } = resolution;
  switch (target.kind) {
    case "chat":
      return { reference, kind: "chat", label: title ?? "", open: { to: "chat-channel", channel: target.channelId } };
    case "thread":
    case "message": {
      const open = {
        to: "chat" as const,
        thread: target.threadId,
        ...(target.channelId ? { channel: target.channelId } : {}),
        ...(target.kind === "message" ? { message: target.messageId } : {}),
      };
      return { reference, kind: target.kind, label: title ?? "", open };
    }
    case "file":
    case "app":
    case "documentRecord":
    case "documentCollection": {
      if (path === undefined) return unavailable;
      const kind = target.kind === "documentRecord" ? "record" : target.kind === "documentCollection" ? "collection" : target.kind;
      return { reference, kind, label: path, open: { to: kind === "collection" ? "collection" : "file", path } };
    }
    case "transactionalCollection":
    case "transactionalRecord":
      return { reference, kind: "data", label: "", open: null };
  }
}
