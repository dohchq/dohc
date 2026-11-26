import { appWords } from "@dohc/interface-words/apps";
import type { AppReview, PhoneApp } from "../server/phoneApps";

/**
 * Which of an app review's controls show in this build. Approve, Allow and Open write through the server, so they wait
 * for phone writes (canOpenApps.ts). Revoke shows wherever an approval or an allowing stands, even when the app needs
 * another review: an approval holds on every phone of the account, and an allowing on every device.
 */
export function reviewControls(
  review: Pick<AppReview, "approved" | "revocable" | "member">,
  build: { readonly phoneWrites: boolean; readonly canOpen: boolean },
) {
  return {
    open: review.approved && build.canOpen,
    approve:
      review.approved || !build.phoneWrites
        ? null
        : review.member
          ? appWords.allowAndOpen
          : appWords.approve,
    revoke: review.revocable,
  };
}

export function reviewStatus(
  review: Pick<AppReview, "approved" | "member">,
  phoneWrites: boolean,
): string {
  if (review.approved)
    return review.member ? appWords.allowedEverywhere : appWords.approvedOnPhones;
  if (review.member?.consent === "changed")
    return phoneWrites ? appWords.changedToOpen : appWords.updated;
  if (!phoneWrites) return appWords.notApproved;
  return review.member ? appWords.reviewToOpen : appWords.approveToOpen;
}

export function appState(
  app: Pick<PhoneApp, "approved" | "member">,
  approvedBefore: boolean,
): string | null {
  if (app.approved) return null;
  return (app.member ? app.member.consent === "changed" : approvedBefore)
    ? appWords.updated
    : appWords.toReview;
}
