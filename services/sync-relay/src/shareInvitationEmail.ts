import type { SendEmail } from "@dohc/workspace-auth/smtp";
import { shareCodeForRelay, shareInvitationMessage } from "./shareInvitationMessage";
import type { SyncRelayStorage } from "./storage";
import { admitShareInvitationEmail } from "./storage/shareInvitationEmails";

export const SHARE_INVITATION_EMAIL_DAILY_LIMIT = 50;
export const SHARE_INVITATION_EMAIL_WINDOW_HOURS = 24;
export const SHARE_INVITATION_EMAIL_TIMEOUT_MS = 10_000;

const ONE_MAILBOX = /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+$/u;

export type ShareInvitationEmailAnswer =
  | { invitationEmail: "sent" | "unavailable" | "failed" }
  | {
      invitationEmail: "limit";
      invitationEmailLimit: { limit: number; windowHours: number; sent: number };
    };

export interface ShareInvitation {
  inviterUserId: string;
  recipientEmail: string;
  shareId: string;
  subjectName: string | null;
  group: boolean;
  access: string;
  browserInvitationUrl: string | null;
}

export function createShareInvitationEmailer(options: {
  storage: SyncRelayStorage;
  nowMs: () => number;
  sendEmail: SendEmail | undefined;
  lookupVerifiedUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined;
  relayPublicOrigin: string | undefined;
  timeoutMs?: number;
}): (invitation: ShareInvitation) => Promise<ShareInvitationEmailAnswer> {
  const { sendEmail, timeoutMs = SHARE_INVITATION_EMAIL_TIMEOUT_MS } = options;
  const verifiedEmail = async (userId: string): Promise<string | null> => {
    try {
      return (await options.lookupVerifiedUserEmail?.(userId)) ?? null;
    } catch {
      return null;
    }
  };
  return async (invitation) => {
    if (!sendEmail) return { invitationEmail: "unavailable" };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const admission = admitShareInvitationEmail(options.storage, {
        inviterUserId: invitation.inviterUserId,
        nowMs: options.nowMs(),
        limit: SHARE_INVITATION_EMAIL_DAILY_LIMIT,
        windowMs: SHARE_INVITATION_EMAIL_WINDOW_HOURS * 60 * 60 * 1000,
      });
      if (!admission.admitted)
        return {
          invitationEmail: "limit",
          invitationEmailLimit: {
            limit: SHARE_INVITATION_EMAIL_DAILY_LIMIT,
            windowHours: SHARE_INVITATION_EMAIL_WINDOW_HOURS,
            sent: admission.sent,
          },
        };
      if (!ONE_MAILBOX.test(invitation.recipientEmail)) throw new Error("not one mailbox");
      const sending = (async () =>
        sendEmail(
          shareInvitationMessage({
            recipientEmail: invitation.recipientEmail,
            inviterEmail: await verifiedEmail(invitation.inviterUserId),
            subjectName: invitation.subjectName,
            group: invitation.group,
            access: invitation.access,
            browserInvitationUrl: invitation.browserInvitationUrl,
            shareCode: shareCodeForRelay(invitation.shareId, options.relayPublicOrigin),
          }),
        ))();
      sending.catch(() => undefined);
      await Promise.race([
        sending,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        }),
      ]);
      return { invitationEmail: "sent" };
    } catch {
      console.error(`[sync-relay] share invitation email failed for share ${invitation.shareId}`);
      return { invitationEmail: "failed" };
    } finally {
      clearTimeout(deadline);
    }
  };
}
