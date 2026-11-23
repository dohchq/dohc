import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { canonicalRelayUrl } from "@dohc/workspace-contracts/relay-values";

const NAME_MAX_CHARS = 120;
const ADDRESS_MAX_CHARS = 320;
const SHARE_CODE_ID_MAX_CHARS = 128;

const ROLE_SENTENCES = new Map([
  ["view", "You can view it."],
  ["comment", "You can comment on it."],
  ["edit", "You can edit it."],
]);

function oneLine(value: string, maxChars: number): string {
  return Array.from(
    value
      .replace(/(?![\s\u200c\u200d])[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, maxChars)
    .join("")
    .trim();
}

export function shareCodeForRelay(
  shareId: string,
  relayPublicOrigin: string | undefined,
): string | null {
  const relayUrl = relayPublicOrigin === undefined ? null : canonicalRelayUrl(relayPublicOrigin);
  if (
    relayUrl === null ||
    relayUrl !== new URL(relayUrl).origin ||
    shareId.length > SHARE_CODE_ID_MAX_CHARS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(shareId)
  )
    return null;
  return `dohc-share:${shareId}:${relayUrl}`;
}

export function shareInvitationMessage(input: {
  recipientEmail: string;
  inviterEmail: string;
  subjectName: string | null;
  access: string;
  browserInvitationUrl: string | null;
  shareCode: string | null;
}): EmailMessage {
  const recipient = input.recipientEmail;
  const inviter = oneLine(input.inviterEmail, ADDRESS_MAX_CHARS);
  const name = oneLine(input.subjectName ?? "", NAME_MAX_CHARS).replace(
    /["\u201c\u201d\u201e\u201f\u00ab\u00bb]/gu,
    "'",
  );
  const shared = `${inviter} shared ${name ? `"${name}"` : "a file"} with you`;
  const role = ROLE_SENTENCES.get(input.access);
  const paragraphs = [
    `${shared} on dohc.${role ? ` ${role}` : ""}`,
    ...(input.browserInvitationUrl
      ? [`Open it in your browser:\n${input.browserInvitationUrl}`]
      : []),
    `Open it in dohc:\n1. Sign in to dohc as ${recipient}.\n2. Choose Sharing, then Shared with me.`,
    ...(input.shareCode ? [`Or choose Open a share and paste this code:\n${input.shareCode}`] : []),
    `You got this email because ${inviter} invited ${recipient}. If you do not know them, you can ignore it.`,
  ];
  return { to: recipient, subject: shared, text: `${paragraphs.join("\n\n")}\n` };
}
