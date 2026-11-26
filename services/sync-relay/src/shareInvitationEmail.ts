import type { SendEmail } from "@dohc/workspace-auth/smtp";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import { shareCodeForRelay, shareInvitationMessage } from "./shareInvitationMessage";
import type { SyncRelayStorage } from "./storage";
import {
  admitShareInvitationEmail,
  forgetShareInvitationEmailGrant,
} from "./storage/shareInvitationEmails";

export const SHARE_INVITATION_EMAIL_DAILY_LIMIT = 50;
export const SHARE_INVITATION_EMAIL_WINDOW_HOURS = 24;
export const SHARE_INVITATION_EMAIL_GRANT_INTERVAL_SECONDS = 60;
export const SHARE_INVITATION_EMAIL_TIMEOUT_MS = 5_000;

const ONE_MAILBOX = /^[^\s<>()@,;:"\\\p{C}]+@[^\s<>()@,;:"\\\p{C}]+$/u;

export type ShareInvitationEmailAnswer =
  | { invitationEmail: "sent" | "unavailable" | "recent" | "failed" }
  | {
      invitationEmail: "limit";
      invitationEmailLimit: { limit: number; windowHours: number; sent: number };
    };

export type ShareInvitation = {
  /** A workspace invite names the workspace; anything else is shared work. */
  kind?: "workspace";
  inviterUserId: string;
  shareId: string;
  grantId: string;
  subjectName: string | null;
  access: string;
  browserInvitationUrl: string | null;
  /**
   * Set for a resend, or any email whose grant can change while it is
   * looked up. The grant then gets one email a minute. It runs after the
   * address lookups, with nothing awaited between it and the send, and answers
   * what the grant gives now. What it throws reaches the caller, with nothing
   * counted and nothing sent.
   */
  beforeResend?: () => { access: string; browserInvitationUrl: string | null };
} & ({ recipientEmail: string } | { recipientUserId: string });

export function createShareInvitationEmailer(options: {
  storage: SyncRelayStorage;
  nowMs: () => number;
  sendEmail: SendEmail | undefined;
  lookupVerifiedUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined;
  lookupUserDisplayName?: LookupUserDisplayName;
  relayPublicOrigin: string | undefined;
  timeoutMs?: number;
}): (invitation: ShareInvitation) => Promise<ShareInvitationEmailAnswer> {
  const { sendEmail, timeoutMs = SHARE_INVITATION_EMAIL_TIMEOUT_MS } = options;
  return async (invitation) => {
    if (!sendEmail) return { invitationEmail: "unavailable" };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    let answered = false;
    let refused: { error: unknown } | undefined;
    const assertInTime = () => {
      if (answered || performance.now() - startedAt >= timeoutMs) throw new Error("timed out");
    };
    const email = async (): Promise<ShareInvitationEmailAnswer> => {
      // The name lookup has its own short deadline and answers null on failure.
      const [inviterEmail, inviterName] = await Promise.all([
        options.lookupVerifiedUserEmail?.(invitation.inviterUserId),
        accountDisplayName(options.lookupUserDisplayName, invitation.inviterUserId),
      ]);
      if (!inviterEmail) return { invitationEmail: "unavailable" };
      const recipientEmail =
        "recipientEmail" in invitation
          ? invitation.recipientEmail
          : (await options.lookupVerifiedUserEmail?.(invitation.recipientUserId))
              ?.trim()
              .toLowerCase();
      assertInTime();
      let granted: { access: string; browserInvitationUrl: string | null } = invitation;
      try {
        granted = invitation.beforeResend?.() ?? invitation;
      } catch (error) {
        refused = { error };
        throw error;
      }
      const admission = admitShareInvitationEmail(options.storage, {
        inviterUserId: invitation.inviterUserId,
        grantId: invitation.grantId,
        nowMs: options.nowMs(),
        limit: SHARE_INVITATION_EMAIL_DAILY_LIMIT,
        windowMs: SHARE_INVITATION_EMAIL_WINDOW_HOURS * 60 * 60 * 1000,
        grantIntervalMs: invitation.beforeResend
          ? SHARE_INVITATION_EMAIL_GRANT_INTERVAL_SECONDS * 1000
          : null,
      });
      if (!admission.admitted && admission.refused === "recent")
        return { invitationEmail: "recent" };
      if (!admission.admitted)
        return {
          invitationEmail: "limit",
          invitationEmailLimit: {
            limit: SHARE_INVITATION_EMAIL_DAILY_LIMIT,
            windowHours: SHARE_INVITATION_EMAIL_WINDOW_HOURS,
            sent: admission.sent,
          },
        };
      let sending = false;
      try {
        if (!recipientEmail || !ONE_MAILBOX.test(recipientEmail))
          throw new Error("not one mailbox");
        const message = shareInvitationMessage({
          workspace: invitation.kind === "workspace",
          recipientEmail,
          inviterEmail,
          inviterName,
          subjectName: invitation.subjectName,
          access: granted.access,
          browserInvitationUrl: granted.browserInvitationUrl,
          shareCode: shareCodeForRelay(invitation.shareId, options.relayPublicOrigin),
        });
        assertInTime();
        sending = true;
        await sendEmail(message);
      } catch (error) {
        if (!sending)
          try {
            forgetShareInvitationEmailGrant(options.storage, {
              attemptId: admission.attemptId,
              inviterUserId: invitation.inviterUserId,
              grantId: invitation.grantId,
            });
          } catch {}
        throw error;
      }
      return { invitationEmail: "sent" };
    };
    try {
      const emailing = email();
      emailing.catch(() => undefined);
      return await Promise.race([
        emailing,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            answered = true;
            reject(new Error("timed out"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      if (refused) throw refused.error;
      console.error(`[sync-relay] share invitation email failed for share ${invitation.shareId}`);
      return { invitationEmail: "failed" };
    } finally {
      clearTimeout(deadline);
    }
  };
}
