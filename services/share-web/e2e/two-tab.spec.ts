import { type BrowserContext, type Page } from "@playwright/test";
import {
  createSeededLink,
  expect,
  revokeSeededLink,
  rotateSeededLink,
  seedShare,
  type SeededLink,
  type SeededShare,
  test,
} from "./harness";

interface OpenedLink {
  page: Page;
  session: string;
}

async function openLink(
  context: BrowserContext,
  shareWebUrl: string,
  secret: string,
  fileName: string,
  heading: string,
): Promise<OpenedLink> {
  const page = await context.newPage();
  await page.goto(`${shareWebUrl}/s/#${secret}`);
  const fileButton = page
    .getByRole("navigation", { name: "Shared files" })
    .getByRole("button", { name: fileName, exact: true });
  await expect(fileButton).toBeVisible();
  await fileButton.click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  const session = new URL(page.url()).pathname.slice("/s/".length);
  expect(session).toMatch(/^[A-Za-z0-9_-]{12}$/u);
  return { page, session };
}

async function expectRefused(opened: OpenedLink): Promise<void> {
  await opened.page.reload();
  await expect(opened.page.getByText("This link isn't available.", { exact: true })).toBeVisible();
}

async function expectUsable(opened: OpenedLink, heading: string): Promise<void> {
  await opened.page.reload();
  await expect(opened.page.getByRole("heading", { name: heading })).toBeVisible();
}

async function exerciseIsolation(
  context: BrowserContext,
  stack: { relayUrl: string; shareWebUrl: string },
  firstShare: SeededShare,
  firstLink: SeededLink,
  firstFile: string,
  firstHeading: string,
  secondShare: SeededShare,
  secondLink: SeededLink,
  secondFile: string,
  secondHeading: string,
): Promise<void> {
  expect(firstLink.grantId).not.toBe(secondLink.grantId);
  const first = await openLink(
    context,
    stack.shareWebUrl,
    firstLink.secret,
    firstFile,
    firstHeading,
  );
  const second = await openLink(
    context,
    stack.shareWebUrl,
    secondLink.secret,
    secondFile,
    secondHeading,
  );
  expect(first.session).not.toBe(second.session);
  const cookieNames = (await context.cookies()).map((cookie) => cookie.name);
  expect(cookieNames).toContain(`dohc_share_${first.session}`);
  expect(cookieNames).toContain(`dohc_share_${second.session}`);

  await rotateSeededLink(stack.relayUrl, firstShare, firstLink.grantId);
  await expectRefused(first);
  await expectUsable(second, secondHeading);

  await revokeSeededLink(stack.relayUrl, secondShare, secondLink.grantId);
  await expectRefused(second);
  await first.page.close();
  await second.page.close();
}

test("keeps two View tabs isolated across different and shared selectors", async ({
  browser,
  stack,
}) => {
  const first = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/alpha.md", content: "# Alpha share\n" }],
  });
  const second = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/beta.md", content: "# Beta share\n" }],
  });
  const context = await browser.newContext();
  try {
    await exerciseIsolation(
      context,
      stack,
      first,
      { grantId: first.grantId, secret: first.secret },
      "alpha.md",
      "Alpha share",
      second,
      { grantId: second.grantId, secret: second.secret },
      "beta.md",
      "Beta share",
    );

    const sameShare = await seedShare({
      relayUrl: stack.relayUrl,
      files: [{ path: "docs/shared.md", content: "# Shared selector\n" }],
    });
    const otherLink = await createSeededLink(stack.relayUrl, sameShare);
    await exerciseIsolation(
      context,
      stack,
      sameShare,
      { grantId: sameShare.grantId, secret: sameShare.secret },
      "shared.md",
      "Shared selector",
      sameShare,
      otherLink,
      "shared.md",
      "Shared selector",
    );
  } finally {
    await context.close();
  }
});
