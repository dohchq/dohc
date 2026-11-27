import { appWords } from "@dohc/interface-words/apps";
import { describe, expect, it } from "vitest";
import type { MemberConsent } from "../server/phoneApps";
import { appState, reviewControls, reviewStatus } from "./reviewControls";

const owner = { approved: false, revocable: false, member: null };
const member = (consent: MemberConsent, approved = false, revocable = false) => ({
  approved,
  revocable,
  member: { name: "tracker", author: "Ana", consent },
});
const writes = { phoneWrites: true, canOpen: true };
const readOnly = { phoneWrites: false, canOpen: false };

describe("an app review's controls", () => {
  it("offers Approve for the owner's app and Allow and open for a Member app, only with phone writes", () => {
    expect(reviewControls(owner, writes)).toEqual({
      open: false,
      approve: appWords.approve,
      revoke: false,
    });
    expect(reviewControls(member("none"), writes)).toEqual({
      open: false,
      approve: appWords.allowAndOpen,
      revoke: false,
    });
    expect(reviewControls(owner, readOnly).approve).toBeNull();
    expect(reviewControls(member("changed"), readOnly).approve).toBeNull();
  });

  it("opens an approved app only in a build that runs apps", () => {
    expect(reviewControls({ ...owner, approved: true, revocable: true }, writes)).toMatchObject({
      open: true,
      approve: null,
    });
    expect(reviewControls(member("current", true, true), readOnly).open).toBe(false);
  });

  it("keeps Revoke without phone writes, and for a Member app that needs another review", () => {
    expect(reviewControls({ ...owner, approved: true, revocable: true }, readOnly).revoke).toBe(
      true,
    );
    expect(reviewControls(member("changed", false, true), readOnly)).toEqual({
      open: false,
      approve: null,
      revoke: true,
    });
    expect(reviewControls(member("changed", false, true), writes)).toEqual({
      open: false,
      approve: appWords.allowAndOpen,
      revoke: true,
    });
  });

  it("says what a review waits for", () => {
    expect(reviewStatus(owner, true)).toBe(appWords.approveToOpen);
    expect(reviewStatus(owner, false)).toBe(appWords.notApproved);
    expect(reviewStatus({ ...owner, approved: true }, false)).toBe(appWords.approvedOnPhones);
    expect(reviewStatus(member("none"), true)).toBe(appWords.reviewToOpen);
    expect(reviewStatus(member("changed"), true)).toBe(appWords.changedToOpen);
    expect(reviewStatus(member("changed"), false)).toBe(appWords.updated);
    expect(reviewStatus(member("current", true), false)).toBe(appWords.allowedEverywhere);
  });

  it("marks a Member app in the list until it's allowed, and a changed one as updated", () => {
    expect(appState(member("none"), true)).toBe(appWords.toReview);
    expect(appState(member("changed"), false)).toBe(appWords.updated);
    expect(appState(member("current", true), false)).toBeNull();
  });

  it("marks the owner's app for review, as updated once another version was approved", () => {
    expect(appState({ approved: false, member: null }, false)).toBe(appWords.toReview);
    expect(appState({ approved: false, member: null }, true)).toBe(appWords.updated);
    expect(appState({ approved: true, member: null }, true)).toBeNull();
  });
});
