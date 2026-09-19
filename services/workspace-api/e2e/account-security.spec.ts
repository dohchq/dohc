import { expect, test } from "@playwright/test";
import { startAccountServer } from "./harness";

let server: Awaited<ReturnType<typeof startAccountServer>>;
test.beforeAll(async () => { server = await startAccountServer(); });
test.afterAll(async () => { await server?.close(); });

test("untrusted Origin and forged forwarded addresses cannot bypass account boundaries", async ({ request }) => {
  const signup = await request.post(`${server.origin}/api/auth/sign-up/email`, {
    headers: {origin: "https://untrusted.example.test"},
    data: {name: "Cross-origin request", email: "untrusted@example.test", password: "untrusted-request-password"},
  });
  expect(signup.status()).toBe(403);
  expect(server.mail.messages).toHaveLength(0);
  const statuses: number[] = [];
  for (let index = 0; index < 12; index++) {
    const response = await request.post(`${server.origin}/api/auth/sign-in/email`, {
      headers: {"x-forwarded-for": `203.0.113.${index + 1}`, "x-dohc-auth-client-ip": `198.51.100.${index + 1}`},
      data: {email: "not-an-account@example.test", password: "not-the-password"},
    });
    statuses.push(response.status());
  }
  expect(statuses).toContain(429);
  expect(statuses[0]).toBe(401);
  expect(server.mail.messages).toHaveLength(0);
});

test("a device verification request cannot turn next into an external redirect", async ({ page }) => {
  await page.goto(`${server.origin}/account/sign-in?next=${encodeURIComponent("/\\untrusted.example.test/path")}`);
  const next = await page.locator("body").getAttribute("data-next");
  expect(next).toBeNull();
});


test("production exposes no approval or mail-capture seam and rejects invalid email tokens", async ({ page, request }) => {
  expect((await request.get(`${server.origin}/test/email/messages`)).status()).toBe(404);
  expect((await request.post(`${server.origin}/test/device/approve`, { data: { userCode: "XXXX-XXXX" } })).status()).toBe(404);
  await page.goto(`${server.origin}/account/verify-email?token=not-a-verification-token`);
  await expect(page.getByRole("status")).toContainText("Send a new link.");
  await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();
  await page.goto(`${server.origin}/account/reset-password?token=not-a-reset-token`);
  await page.getByLabel("New password", { exact: true }).fill("invalid-reset-password-123");
  await page.getByLabel("Confirm new password", { exact: true }).fill("invalid-reset-password-123");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator("#status.error")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save password" })).toBeEnabled();
});
