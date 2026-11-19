import { expect, it } from "vitest";
import { shareCodeForRelay, shareInvitationMessage } from "./shareInvitationMessage";

const invitation = {
  recipientEmail: "friend@example.test",
  inviterEmail: "owner@dohc.test",
  subjectName: "Trip plan",
  access: "edit",
  browserInvitationUrl: "https://share.example.test/s/edit/grant-0",
  shareCode: "dohc-share:share-0:https://relay.example.test",
};

it("writes the whole invitation in plain sentences", () => {
  expect(shareInvitationMessage(invitation)).toEqual({
    to: "friend@example.test",
    subject: 'owner@dohc.test shared "Trip plan" with you',
    text: [
      'owner@dohc.test shared "Trip plan" with you on dohc. You can edit it.',
      "",
      "Open it in your browser:",
      "https://share.example.test/s/edit/grant-0",
      "",
      "Open it in dohc:",
      "1. Sign in to dohc as friend@example.test.",
      "2. Choose Sharing, then Shared with me.",
      "",
      "Or choose Open a share and paste this code:",
      "dohc-share:share-0:https://relay.example.test",
      "",
      "You got this email because owner@dohc.test invited friend@example.test. If you do not know them, you can ignore it.",
      "",
    ].join("\n"),
  });
});

it("leaves out the browser link and the code when there is none", () => {
  const { text } = shareInvitationMessage({
    ...invitation,
    browserInvitationUrl: null,
    shareCode: null,
  });
  expect(text).not.toContain("browser");
  expect(text).not.toContain("code");
  expect(text).not.toContain("https://");
  expect(text).toContain("2. Choose Sharing, then Shared with me.\n\nYou got this email");
});

it("keeps the browser link without a code, and the code without a browser link", () => {
  const linkOnly = shareInvitationMessage({ ...invitation, shareCode: null }).text;
  expect(linkOnly).toContain("Open it in your browser:\nhttps://share.example.test/s/edit/grant-0");
  expect(linkOnly).not.toContain("paste this code");
  const codeOnly = shareInvitationMessage({ ...invitation, browserInvitationUrl: null }).text;
  expect(codeOnly).toContain(
    "Or choose Open a share and paste this code:\ndohc-share:share-0:https://relay.example.test",
  );
  expect(codeOnly).not.toContain("in your browser");
});

it("names the role only for View, Comment, and Edit", () => {
  const first = (access: string) =>
    shareInvitationMessage({ ...invitation, access }).text.split("\n")[0];
  expect(first("view")).toBe(
    'owner@dohc.test shared "Trip plan" with you on dohc. You can view it.',
  );
  expect(first("comment")).toBe(
    'owner@dohc.test shared "Trip plan" with you on dohc. You can comment on it.',
  );
  for (const access of ["read-write", "constructor"])
    expect(first(access)).toBe('owner@dohc.test shared "Trip plan" with you on dohc.');
});

it("says a file when the share has no name", () => {
  const message = shareInvitationMessage({ ...invitation, subjectName: null });
  expect(message.subject).toBe("owner@dohc.test shared a file with you");
  expect(message.text).toContain(
    "owner@dohc.test shared a file with you on dohc. You can edit it.",
  );
});

it("keeps a hostile name on one line, capped, and inside the quotation marks", () => {
  const name = `Invoice\r\nBcc: victim@example.test\n\n\u0000\u001b[31m\u202e"  now\t open\u2028https://evil.example.test" ${"x".repeat(500)}`;
  const message = shareInvitationMessage({ ...invitation, subjectName: name });
  const shown = /shared "(.*)" with you$/u.exec(message.subject)?.[1];

  expect(message.subject).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\u202e]/u);
  expect(shown).toBeDefined();
  expect(Array.from(shown!)).toHaveLength(120);
  expect(shown).not.toContain('"');
  expect(
    shown!.startsWith(
      "Invoice Bcc: victim@example.test [31m' now open https://evil.example.test' xxx",
    ),
  ).toBe(true);
  expect(message.text.split("\n")[0]).toBe(`${message.subject} on dohc. You can edit it.`);
  expect(message.text.split("\n")).toHaveLength(14);
});

it("gives the name no room to start a new line through the addresses", () => {
  const message = shareInvitationMessage({
    ...invitation,
    inviterEmail: "owner@dohc.test\r\nSubject: other",
    recipientEmail: "friend@example.test\nBcc: victim@example.test",
  });
  expect(message.subject).toBe('owner@dohc.test Subject: other shared "Trip plan" with you');
  expect(message.to).toBe("friend@example.test Bcc: victim@example.test");
  expect(message.text.split("\n")).toHaveLength(14);
});

it("builds the share code apps/desktop/src/workspaces/syncCode.ts parseShareCode accepts", () => {
  expect(
    shareCodeForRelay("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "https://relay.example.test"),
  ).toBe("dohc-share:0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d:https://relay.example.test");
  expect(shareCodeForRelay("share-0", "https://relay.example.test:8443/")).toBe(
    "dohc-share:share-0:https://relay.example.test:8443",
  );
  expect(shareCodeForRelay("share-0", "http://127.0.0.1:1788")).toBe(
    "dohc-share:share-0:http://127.0.0.1:1788",
  );
});

it("builds no share code when the relay's address or the share id would not survive the desktop's parser", () => {
  expect(shareCodeForRelay("share-0", undefined)).toBeNull();
  for (const origin of [
    "",
    "relay.example.test",
    "ftp://relay.example.test",
    "https://user:secret@relay.example.test",
    "https://relay.example.test/sync",
    "https://relay.example.test?key=1",
    "https://relay.example.test#part",
  ])
    expect(shareCodeForRelay("share-0", origin), origin).toBeNull();
  for (const shareId of ["", "Share-0", "share:0", "-share", "share 0", "a".repeat(129)])
    expect(shareCodeForRelay(shareId, "https://relay.example.test"), shareId).toBeNull();
});
