import type { ChatAttachmentRecord } from "../../ipc/bridgeContract";
import type { ChatFileReferenceToken } from "@dohc/workspace-contracts/chat-mentions";

export interface FileMentionNavigationTarget {
  path: string;
  headingAnchor?: string;
}

export function fileReferenceKey(reference: {
  path: string;
  headingAnchor?: string;
}): string {
  return `${reference.path}\u0000${reference.headingAnchor ?? ""}`;
}

function sameHeading(
  token: Pick<ChatFileReferenceToken, "headingAnchor">,
  attachment: Pick<ChatAttachmentRecord, "headingAnchor">,
): boolean {
  return (token.headingAnchor ?? "") === (attachment.headingAnchor ?? "");
}

// Body text is immutable display copy, while attachment pathHint is the
// engine's authoritative, permission-checked navigation target. Most tokens
// match it exactly. Hand-typed compatibility forms can have edge spaces that
// main intentionally trims only after exact lookup. Reconcile unique
// references in two passes so exact space-named files always
// win, followed only by the explicit edge-space compatibility form. Never
// bind by heading/order alone: CLI callers can attach an independent file that
// happens to share a heading with a literal token in the message body.
export function resolveFileMentionNavigationTargets(
  tokens: readonly ChatFileReferenceToken[],
  attachments: readonly ChatAttachmentRecord[],
): Map<string, FileMentionNavigationTarget> {
  const references = Array.from(
    new Map(tokens.map((token) => [fileReferenceKey(token), token])).values(),
  );
  const available = attachments.filter(
    (attachment): attachment is ChatAttachmentRecord & { pathHint: string } =>
      typeof attachment.pathHint === "string" && attachment.pathHint.length > 0,
  );
  const unused = new Set(available.map((_, index) => index));
  const targets = new Map<string, FileMentionNavigationTarget>();

  const assign = (
    predicate: (
      token: ChatFileReferenceToken,
      attachment: ChatAttachmentRecord & { pathHint: string },
    ) => boolean,
  ) => {
    for (const token of references) {
      const key = fileReferenceKey(token);
      if (targets.has(key)) continue;
      const index = available.findIndex(
        (attachment, at) => unused.has(at) && predicate(token, attachment),
      );
      if (index < 0) continue;
      const attachment = available[index];
      if (!attachment) continue;
      unused.delete(index);
      targets.set(key, {
        path: attachment.pathHint,
        ...(attachment.headingAnchor
          ? { headingAnchor: attachment.headingAnchor }
          : {}),
      });
    }
  };

  assign(
    (token, attachment) =>
      attachment.pathHint === token.path && sameHeading(token, attachment),
  );
  assign(
    (token, attachment) =>
      token.path.trim() !== token.path &&
      attachment.pathHint === token.path.trim() &&
      sameHeading(token, attachment),
  );

  return targets;
}
