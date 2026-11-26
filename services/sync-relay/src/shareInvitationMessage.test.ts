import { expect, it } from "vitest";
import {
  inviterDisplayName,
  shareCodeForRelay,
  shareInvitationMessage,
} from "./shareInvitationMessage";

const invitation = {
  recipientEmail: "friend@example.test",
  inviterEmail: "owner@dohc.test",
  inviterName: "Sam Rivera",
  subjectName: "Trip plan",
  access: "edit",
  browserInvitationUrl: "https://share.example.test/s/edit/grant-0",
  shareCode: "dohc-share:share-0:https://relay.example.test",
};

it("writes the whole invitation in plain sentences, from the inviter by name", () => {
  const { html, ...message } = shareInvitationMessage(invitation);
  expect(message).toEqual({
    to: "friend@example.test",
    subject: 'Sam Rivera shared "Trip plan" with you',
    fromName: "Sam Rivera",
    text: [
      'Sam Rivera (owner@dohc.test) shared "Trip plan" with you. You can edit it.',
      "",
      "Open in browser:",
      "https://share.example.test/s/edit/grant-0",
      "Sign in or create an account with friend@example.test.",
      "",
      "Using the dohc app? Sign in with friend@example.test. Choose Sharing, then Shared with me. Or choose Open a share and paste this code:",
      "dohc-share:share-0:https://relay.example.test",
      "",
      "You got this because Sam Rivera (owner@dohc.test) invited friend@example.test. If you do not know them, ignore this email. Nothing happens if you do.",
      "",
    ].join("\n"),
  });
  for (const shown of [
    "Shared work with you",
    "Trip plan",
    "Can edit",
    'href="https://share.example.test/s/edit/grant-0"',
    "Open in browser",
    "share.example.test</span>. Sign in or create an account with",
    "Using the dohc app?",
    "dohc-share:share-0:https://relay.example.test",
    'href="mailto:owner@dohc.test"',
    "If the button does not work, copy this link into your browser:",
    "You can edit it. Open it in your browser or the dohc app.",
  ])
    expect(html, shown).toContain(shown);
});

it("names the workspace a member invite is for, and opens the person's workspaces", () => {
  const message = shareInvitationMessage({
    ...invitation,
    workspace: true,
    subjectName: "Community",
    access: "comment",
    browserInvitationUrl: "https://share.example.test/workspaces",
  });
  expect(message.subject).toBe('Sam Rivera invited you to "Community"');
  expect(message.text).toContain(
    'Sam Rivera (owner@dohc.test) invited you to "Community". You can comment on it.',
  );
  expect(message.text).toContain("https://share.example.test/workspaces");
  for (const shown of ["Invited you to a workspace", "Community", "Can comment"])
    expect(message.html, shown).toContain(shown);
  expect(message.html).not.toContain("Shared work");
  expect(
    shareInvitationMessage({ ...invitation, workspace: true, subjectName: null }).subject,
  ).toBe("Sam Rivera invited you to a workspace");
});

it("names the inviter by address, with no sender name, when the account has no usable name", () => {
  for (const inviterName of [null, "", "  ", "sam@example.test", "https://dohc.computer"]) {
    const message = shareInvitationMessage({ ...invitation, inviterName });
    expect(message.subject).toBe('owner@dohc.test shared "Trip plan" with you');
    expect(message.fromName).toBeUndefined();
    expect(message.text).toContain("You got this because owner@dohc.test invited");
    expect(message.html).not.toContain("(<a");
  }
});

it("keeps a name only when it cannot pass for an address or a website", () => {
  expect(inviterDisplayName("  Sam\n Rivera ")).toBe("Sam Rivera");
  expect(inviterDisplayName("J.K. Rowling")).toBe("J.K. Rowling");
  expect(inviterDisplayName("محمد\u200cرضا")).toBe("محمد\u200cرضا");
  expect(inviterDisplayName("Zoë O'Neil-Ng")).toBe("Zoë O'Neil-Ng");
  for (const name of [
    "sam@example.test",
    "Sam <ceo@example.test>",
    "paypal.com",
    "Support at drive.dohc.computer",
    "http://x",
    "例え.テスト",
    "例え。テスト",
    "<b>Sam</b>",
  ])
    expect(inviterDisplayName(name), name).toBeNull();
});

it("leaves out the browser link and the code when there is none", () => {
  const { text, html } = shareInvitationMessage({
    ...invitation,
    browserInvitationUrl: null,
    shareCode: null,
  });
  expect(text).not.toContain("browser");
  expect(text).not.toContain("code");
  expect(text).not.toContain("https://");
  expect(text).toContain(
    "Open in the dohc app: Sign in with friend@example.test. Choose Sharing, then Shared with me.\n\nYou got this",
  );
  expect(html).not.toContain("https://share.example.test");
  expect(html).not.toContain("dohc-share:");
  expect(html).not.toContain("Open a share");
  expect(html).not.toContain("If the button does not work");
  expect(html).toContain("Open in the dohc app");
  expect(html).toContain("You can edit it. Open it in the dohc app.");
});

it("keeps the browser link without a code, and the code without a browser link", () => {
  const linkOnly = shareInvitationMessage({ ...invitation, shareCode: null });
  expect(linkOnly.text).toContain("Open in browser:\nhttps://share.example.test/s/edit/grant-0");
  expect(linkOnly.text).not.toContain("paste this code");
  expect(linkOnly.html).not.toContain("paste this code");
  const codeOnly = shareInvitationMessage({ ...invitation, browserInvitationUrl: null });
  expect(codeOnly.text).toContain(
    "Or choose Open a share and paste this code:\ndohc-share:share-0:https://relay.example.test",
  );
  expect(codeOnly.text).not.toContain("Open in browser");
  expect(codeOnly.html).not.toContain("Open in browser");
});

it("treats a link that is not a web link as no browser link", () => {
  const message = shareInvitationMessage({
    ...invitation,
    browserInvitationUrl: "javascript:alert(1)",
  });
  expect(message.text).not.toContain("javascript");
  expect(message.html).not.toContain("javascript");
});

it("names the role only for View, Comment, and Edit", () => {
  const shown = (access: string) => shareInvitationMessage({ ...invitation, access });
  expect(shown("view").text.split("\n")[0]).toMatch(/with you\. You can view it\.$/u);
  expect(shown("view").html).toContain("Can view");
  expect(shown("comment").text.split("\n")[0]).toMatch(/with you\. You can comment on it\.$/u);
  expect(shown("comment").html).toContain("Can comment");
  for (const access of ["read-write", "constructor"]) {
    expect(shown(access).text.split("\n")[0]).toMatch(/with you\.$/u);
    expect(shown(access).html).not.toMatch(/Can (view|comment|edit)|You can/u);
  }
});

it("says work when the share has no name", () => {
  const message = shareInvitationMessage({ ...invitation, subjectName: null });
  expect(message.subject).toBe("Sam Rivera shared work with you");
  expect(message.text).toContain("Sam Rivera (owner@dohc.test) shared work with you.");
  expect(message.html).toContain("Shared work</div>");
});

it("shows a name or item name with markup as text", () => {
  const message = shareInvitationMessage({
    ...invitation,
    inviterName: `Sam "&" <img src=x>`,
    subjectName: `<script>alert("x")</script> & 'notes'`,
  });
  expect(message.html).not.toMatch(/<script|<img/u);
  expect(message.html).toContain(
    "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &#39;notes&#39;",
  );
});

it("keeps a hostile name on one line, capped, and inside the quotation marks", () => {
  const name = `Invoice\r\nBcc: victim@example.test\n\n\u0000\u001b[31m‮"  now\t open https://evil.example.test" ${"x".repeat(500)}`;
  const message = shareInvitationMessage({ ...invitation, subjectName: name });
  const shown = /shared "(.*)" with you$/u.exec(message.subject)?.[1];

  expect(message.subject).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}‮]/u);
  expect(shown).toBeDefined();
  expect(Array.from(shown!)).toHaveLength(120);
  expect(shown).not.toContain('"');
  expect(
    shown!.startsWith(
      "Invoice Bcc: victim@example.test [31m' now open https://evil.example.test' xxx",
    ),
  ).toBe(true);
  expect(message.text.split("\n")).toHaveLength(11);
});

it("keeps the inviter's address on one line, and sends to the address it was given unchanged", () => {
  const message = shareInvitationMessage({
    ...invitation,
    inviterName: null,
    inviterEmail: "owner@dohc.test\r\nSubject: other",
  });
  expect(message.subject).toBe('owner@dohc.test Subject: other shared "Trip plan" with you');
  expect(message.to).toBe(invitation.recipientEmail);
  expect(message.text.split("\n")).toHaveLength(11);
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
