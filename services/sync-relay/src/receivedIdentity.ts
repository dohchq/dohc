import { createHmac } from "node:crypto";
import { fileSideOf, pathVisibleThroughShare, type AnyShareSelector, type ChatShareThreadResolver } from "./shareFilter";

export type ReceivedRecipient = readonly ["user" | "link", string];
export function createReceivedIdentity(key?: string | Uint8Array) {
  const digest = (domain: string, recipient: ReceivedRecipient, workspaceId: string, objectId?: string) =>
    key ? createHmac("sha256", key).update(JSON.stringify([domain, recipient, workspaceId, ...(objectId === undefined ? [] : [objectId])])).digest("hex") : undefined;
  return {
    source(recipient: ReceivedRecipient, workspaceId: string) {
      const value = digest("dohc/received-source/v1", recipient, workspaceId);
      return value ? `share-source:v1:${value}` : undefined;
    },
    object(recipient: ReceivedRecipient, workspaceId: string, objectId: unknown) {
      if (typeof objectId !== "string" || !objectId) return undefined;
      const value = digest("dohc/received-object/v1", recipient, workspaceId, objectId);
      return value ? `share-object:v1:${value}` : undefined;
    },
  };
}
export type ReceivedIdentity = ReturnType<typeof createReceivedIdentity>;

/** Add identity only to fields whose content passed the share filter. */
export function tokenizeReceivedPayload(input: {
  identity: ReceivedIdentity; recipient: ReceivedRecipient; workspaceId: string;
  selector: AnyShareSelector; chat: ChatShareThreadResolver; opKind: string;
  original: Record<string, unknown>; served: Record<string, unknown>;
  projectPath?: (path: string) => string | null;
}): void {
  const {identity, recipient, workspaceId, selector, chat, opKind, original, served} = input;
  const token = (id: unknown) => identity.object(recipient, workspaceId, id);
  if (opKind === "moment.append") {
    const id = token(original.objectId);
    if (id) served.objectId = id;
  } else if (opKind === "version.create" && Array.isArray(served.forkSnapshots) && Array.isArray(original.forkSnapshots)) {
    for (const row of served.forkSnapshots as Record<string, unknown>[]) {
      const source = original.forkSnapshots.find(raw => raw && typeof raw === "object" && typeof raw.path === "string" && (input.projectPath ? input.projectPath(raw.path) : raw.path) === row.path);
      const id = token(source?.objectId);
      if (id) row.objectId = id;
    }
  } else if (opKind === "chat.thread.create" && typeof served.linkedPath === "string") {
    const binding = chat.threadFileBinding(String(original.threadId));
    const id = token(binding?.kind === "object" ? binding.objectId : chat.objectIdAtPath(served.linkedPath));
    if (id) { served.linkedObjectId = id; served.linkedPathHint = served.linkedPath; delete served.linkedPath; }
  } else if (opKind === "chat.attachment.add" && typeof original.objectId === "string") {
    const files = fileSideOf(selector);
    const path = chat.objectCurrentPath(original.objectId);
    if (files && typeof path === "string" && pathVisibleThroughShare(files, path)) {
      const id = token(original.objectId);
      if (id) { served.objectId = id; served.pathHint = path; }
    }
  }
}
