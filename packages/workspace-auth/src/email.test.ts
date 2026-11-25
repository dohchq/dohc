import { describe, expect, it } from "vitest";
import { accountEmail, button, emailHtml, item, sender, strong } from "./email";

const reset = {
  to: "person@example.com",
  subject: "Reset your dohc password",
  heading: "Reset your password",
  body: "Choose a new password for your account. This link works for 1 hour.",
  action: "Choose a new password",
  url: "https://drive.example.test/account/reset-password?token=a&next=%2Faccount",
  note: "If you did not ask for a new password, ignore this email. Your password stays as it is.",
};

describe("accountEmail", () => {
  it("puts the bare link on its own line in the text and behind the button in HTML", () => {
    const message = accountEmail(reset);
    expect(message.text).toBe(`${reset.body}\n\n${reset.url}\n\n${reset.note}\n`);
    const href = reset.url.replaceAll("&", "&amp;");
    expect(message.html!.split(`href="${href}"`)).toHaveLength(3); // button and fallback
    for (const shown of [reset.heading, reset.body, reset.action, reset.note])
      expect(message.html).toContain(shown);
  });

  it("refuses a link that is not a web link", () => {
    expect(() => accountEmail({ ...reset, url: "javascript:alert(1)" })).toThrow(/web link/u);
    expect(() => button("not a url", "Open")).toThrow(/web link/u);
  });
});

describe("emailHtml", () => {
  it("shows every string it is given as text", () => {
    const page = emailHtml({
      title: `<title>"x"`,
      preheader: "<b>early</b>",
      card: [sender(`<img src=x onerror=1>`, `a"b@example.test`), item(`<script>`, "&")],
      footer: [`</td><script>`, strong("<i>")],
    });
    expect(page).not.toMatch(/<(script|img|i)[\s>]/u);
    expect(page).not.toContain("<b>early");
    expect(page).toContain("&lt;title&gt;&quot;x&quot;");
    expect(page).toContain('href="mailto:a&quot;b@example.test"');
  });
});

describe("sender", () => {
  const initials = (name: string | null, address: string) =>
    /class="avatar"[^>]*>([^<]*)</u.exec(
      emailHtml({ title: "", preheader: "", card: [sender(name, address)], footer: [] }),
    )?.[1];

  it("shows the first letter of the first and last names, or of the address", () => {
    expect(initials("Sam Rivera", "s@example.test")).toBe("SR");
    expect(initials("sam", "s@example.test")).toBe("S");
    expect(initials("Ana María de la Cruz", "a@example.test")).toBe("AC");
    expect(initials("🙂 Émile", "e@example.test")).toBe("É");
    expect(initials("李 小龙", "l@example.test")).toBe("李小");
    expect(initials(null, "owner@example.test")).toBe("O");
    expect(initials("🙂", "+@example.test")).toBe("E");
  });
});
