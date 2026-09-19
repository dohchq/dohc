import { expect, test } from "@playwright/test";
import { startAccountServer } from "./harness";
import { mailLinks } from "./smtpCapture";

let server: Awaited<ReturnType<typeof startAccountServer>>;
test.beforeAll(async () => { server = await startAccountServer(); });
test.afterAll(async () => { await server?.close(); });

test("a new account verifies email, approves desktop, denies another device, and recovers its password", async ({ page, request }) => {
  const email = `browser-${Date.now()}@example.test`;
  const password = "local-browser-proof-password-123";
  const replacement = "recovered-browser-proof-password-456";
  expect((await request.get(`${server.origin}/ready`)).status()).toBe(200);
  expect(await (await request.get(`${server.origin}/.well-known/dohc-server`)).json()).toMatchObject({
    version: 1, authUrl: server.origin, relayUrl: server.origin, shareUrl: server.origin,
  });
  const device = await (await request.post(`${server.origin}/api/auth/device/code`, { data: { client_id: "dohc-desktop" } })).json();
  await page.goto(device.verification_uri_complete);
  await page.getByRole("link", { name: /create (an )?account|sign up/i }).click();
  await page.getByLabel(/^name$/i).fill("Browser account proof");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await expect(page).toHaveURL(/\/account\/verify-email\?next=/);
  await expect.poll(() => server.mail.messages.length).toBe(1);
  const verification = mailLinks(server.mail.messages[0]!).find(link => link.includes("verify-email"));
  expect(verification).toBeTruthy();
  await page.goto(verification!);
  await page.getByRole("link", { name: "Continue connecting your device" }).click();
  if (await page.getByLabel(/^password$/i).isVisible()) {
    await page.getByLabel(/^email$/i).fill(email);
    await page.getByLabel(/^password$/i).fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
  }
  await page.getByRole("button", { name: /^approve|allow/i }).click();
  await expect(page.getByText(/approved|connected|return to dohc/i).first()).toBeVisible();
  const token = await request.post(`${server.origin}/api/auth/device/token`, { data: {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "dohc-desktop",
  } });
  expect(token.status()).toBe(200);
  const session = await token.json();
  expect(session.access_token).toBeTruthy();
  expect(await (await request.get(`${server.origin}/api/auth/get-session`, { headers: { Authorization: `Bearer ${session.access_token}` } })).json()).toMatchObject({user: {email, emailVerified: true}});

  const denied = await (await request.post(`${server.origin}/api/auth/device/code`, {data: {client_id: "dohc-desktop"}})).json();
  await page.goto(denied.verification_uri_complete);
  await page.getByRole("button", {name: /^deny$/i}).click();
  await expect(page.getByText(/did not connect|refused/i).first()).toBeVisible();
  expect(await (await request.post(`${server.origin}/api/auth/device/token`, {data: {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: denied.device_code, client_id: "dohc-desktop",
  }})).json()).toMatchObject({error: "access_denied"});

  const expired = await (await request.post(`${server.origin}/api/auth/device/code`, {data: {client_id: "dohc-desktop"}})).json();
  await server.pool.query('UPDATE "deviceCode" SET "expiresAt" = NOW() - INTERVAL \'1 minute\' WHERE "deviceCode"=$1', [expired.device_code]);
  await page.goto(expired.verification_uri_complete);
  await expect(page.getByText(/expired/i).first()).toBeVisible();
  await expect(page.getByRole("button", {name: /^approve|allow/i})).toHaveCount(0);

  await page.goto(`${server.origin}/account/forgot-password`);
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByRole("button", {name: /send|reset/i}).click();
  await expect.poll(() => server.mail.messages.length).toBe(2);
  const reset = mailLinks(server.mail.messages[1]!).find(link => link.includes("reset-password"));
  expect(reset).toBeTruthy();
  await page.goto(reset!);
  await page.getByLabel(/^new password$|^password$/i).fill(replacement);
  const confirmation = page.getByLabel(/confirm/i);
  if (await confirmation.count()) await confirmation.fill(replacement);
  await page.getByRole("button", {name: /reset|save|change/i}).click();
  await expect(page.getByText("Your password is saved.")).toBeVisible();
  expect(await (await request.get(`${server.origin}/api/auth/get-session`, { headers: { Authorization: `Bearer ${session.access_token}` } })).json()).toBeNull();
  await page.goto(`${server.origin}/account/sign-in`);
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(replacement);
  await page.getByRole("button", {name: /^sign in$/i}).click();
  await expect(page.getByText(/signed in|account/i).first()).toBeVisible();
  expect(server.logs()).not.toContain(device.device_code);
  expect(server.logs()).not.toContain(session.access_token);
  expect(server.logs()).not.toContain("token=");
});


test("account pages fit mobile and support keyboard use in both themes", async ({ page }, testInfo) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto(`${server.origin}/account/sign-up`);
    await expect(page.locator(".server")).toHaveText(`This account belongs to ${new URL(server.origin).host}.`);
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`account-mobile-${colorScheme}.png`), fullPage: true });
  }
});


test("failed SMTP shows a recoverable error after signup and password reset", async ({ page }) => {
  const email = `delivery-failure-${Date.now()}@example.test`;
  server.mail.refuseNextMessage();
  await page.goto(`${server.origin}/account/sign-up`);
  await page.getByLabel("Name", { exact: true }).fill("Mail failure proof");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("mail-failure-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("could not send the email");
  await page.getByRole("link", { name: "Send a verification link" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  const beforeResend = server.mail.messages.length;
  await page.getByRole("button", { name: "Send a new link" }).click();
  await expect.poll(() => server.mail.messages.length).toBe(beforeResend + 1);
  await expect(page.getByRole("status")).toContainText("for a verification link");
  server.mail.refuseNextMessage();
  await page.goto(`${server.origin}/account/forgot-password`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send the reset link" }).click();
  await expect(page.getByRole("status")).toContainText("could not send the email");
  await expect(page.getByRole("button", { name: "Send the reset link" })).toBeEnabled();
});


test("anonymous mail failures do not reveal which accounts exist", async ({ request }) => {
  const email = `mail-privacy-${Date.now()}@example.test`;
  const signup = await request.post(`${server.origin}/api/auth/sign-up/email`, { headers: { origin: server.origin }, data: { name: "Privacy", email, password: "mail-privacy-password-123" } });
  expect(signup.status()).toBe(200);
  await request.post(`${server.origin}/api/auth/sign-out`, { headers: { origin: server.origin }, data: {} });
  for (const route of ["request-password-reset", "send-verification-email"]) {
    server.mail.refuseNextMessage();
    const existing = await request.post(`${server.origin}/api/auth/${route}`, { headers: { origin: server.origin }, data: { email } });
    const missing = await request.post(`${server.origin}/api/auth/${route}`, { headers: { origin: server.origin }, data: { email: `missing-${Date.now()}@example.test` } });
    expect(existing.status()).toBe(200);
    expect(missing.status()).toBe(existing.status());
    expect(await missing.json()).toEqual(await existing.json());
    expect((await request.get(`${server.origin}/ready`)).status()).toBe(200);
    expect(server.logs()).toContain("Account email could not be delivered");
  }
});
