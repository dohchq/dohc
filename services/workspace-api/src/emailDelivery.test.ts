import { expect, it } from "vitest";
import { accountEmailDelivery } from "./emailDelivery";

it("keeps a failed delivery scoped to its request and preserves the signup session", async () => {
  const email = accountEmailDelivery(async message => {
    if (message.to === "failed@example.test") throw new Error("private SMTP response");
  });
  const handle = (to: string) => email.handle(new Request("https://server.example.test/api/auth/sign-up/email"), async () => {
    try { await email.sendEmail({ to, subject: "Test", text: "secret link" }); } catch { /* Better Auth catches this. */ }
    return Response.json({ ok: true }, { headers: { "set-cookie": "session=opaque; HttpOnly", "content-length": "11" } });
  });
  const [failed, passed] = await Promise.all([handle("failed@example.test"), handle("passed@example.test")]);
  expect(failed.status).toBe(503);
  expect(failed.headers.get("set-cookie")).toContain("session=opaque");
  expect(failed.headers.get("content-length")).toBeNull();
  expect(await failed.text()).not.toMatch(/private SMTP|secret link/);
  expect(passed.status).toBe(200);
});
