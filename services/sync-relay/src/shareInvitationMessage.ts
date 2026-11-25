import {
  button,
  code as codeBox,
  emailHtml,
  gap,
  heading,
  item,
  linkFallback,
  literal,
  mailto,
  note,
  paragraphBreak,
  rule,
  sender,
  steps,
  strong,
  subheading,
  webUrl,
} from "@dohc/workspace-auth/email";
import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { canonicalRelayUrl } from "@dohc/workspace-contracts/relay-values";

const NAME_MAX_CHARS = 120;
const ADDRESS_MAX_CHARS = 320;
const SHARE_CODE_ID_MAX_CHARS = 128;
const INVITER_NAME_MAX_CHARS = 40;

const ROLE_SENTENCES = new Map([
  ["view", "You can view it."],
  ["comment", "You can comment on it."],
  ["edit", "You can edit it."],
]);
const ROLE_LABELS = new Map([
  ["view", "Can view"],
  ["comment", "Can comment"],
  ["edit", "Can edit"],
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

// A name shown as the sender must not pass for an address or a website. When
// it could, the email names the inviter by address only.
export function inviterDisplayName(name: string | null): string | null {
  const shown = oneLine(name ?? "", INVITER_NAME_MAX_CHARS);
  return shown && !/[@<>]|:\/\/|[\p{L}\p{N}-]\.[A-Za-z]{2,}/u.test(shown) ? shown : null;
}

export function shareInvitationMessage(input: {
  recipientEmail: string;
  inviterEmail: string;
  inviterName: string | null;
  subjectName: string | null;
  access: string;
  browserInvitationUrl: string | null;
  shareCode: string | null;
}): EmailMessage {
  const recipient = input.recipientEmail;
  const inviterEmail = oneLine(input.inviterEmail, ADDRESS_MAX_CHARS);
  const inviterName = inviterDisplayName(input.inviterName);
  const inviter = inviterName ?? inviterEmail;
  const inviterWithAddress = inviterName ? `${inviterName} (${inviterEmail})` : inviterEmail;
  const name = oneLine(input.subjectName ?? "", NAME_MAX_CHARS).replace(/["“”„‟«»]/gu, "'");
  const what = name ? `"${name}"` : "work";
  const subject = `${inviter} shared ${what} with you`;
  const role = ROLE_SENTENCES.get(input.access);
  const browserUrl = input.browserInvitationUrl && webUrl(input.browserInvitationUrl);
  const code = input.shareCode;

  const text = [
    `${inviterWithAddress} shared ${what} with you.${role ? ` ${role}` : ""}`,
    ...(browserUrl
      ? [`Open in browser:\n${browserUrl}\nSign in or create an account with ${recipient}.`]
      : []),
    [
      browserUrl ? "Using the dohc app?" : "Open in the dohc app:",
      `Sign in with ${recipient}. Choose Sharing, then Shared with me.`,
      ...(code ? [`Or choose Open a share and paste this code:\n${code}`] : []),
    ].join(" "),
    `You got this because ${inviterWithAddress} invited ${recipient}. If you do not know them, ignore this email. Nothing happens if you do.`,
  ].join("\n\n");

  const browser = browserUrl
    ? [
        button(browserUrl, "Open in browser"),
        gap(12),
        note(
          [
            "Opens ",
            literal(new URL(browserUrl).host),
            ". Sign in or create an account with ",
            literal(recipient),
            ".",
          ],
          "below",
        ),
        rule(),
      ]
    : [];
  const html = emailHtml({
    title: subject,
    preheader: [
      role,
      browserUrl ? "Open it in your browser or the dohc app." : "Open it in the dohc app.",
    ]
      .filter(Boolean)
      .join(" "),
    card: [
      sender(inviterName, inviterEmail),
      heading("Shared work with you"),
      item(name || "Shared work", ROLE_LABELS.get(input.access) ?? null),
      gap(24),
      ...browser,
      subheading(browserUrl ? "Using the dohc app?" : "Open in the dohc app"),
      steps([
        "Sign in with ",
        literal(recipient),
        ". Choose ",
        strong("Sharing"),
        ", then ",
        strong("Shared with me"),
        ".",
        ...(code ? [" Or choose ", strong("Open a share"), " and paste this code:"] : []),
      ]),
      ...(code ? [codeBox(code)] : []),
    ],
    footer: [
      "You got this because ",
      ...(inviterName ? [inviterName, " (", mailto(inviterEmail), ")"] : [mailto(inviterEmail)]),
      " invited ",
      literal(recipient),
      ". If you do not know them, ignore this email. Nothing happens if you do.",
      ...(browserUrl ? [paragraphBreak(), linkFallback(browserUrl)] : []),
    ],
  });

  return {
    to: recipient,
    subject,
    text: `${text}\n`,
    html,
    ...(inviterName ? { fromName: inviterName } : {}),
  };
}
