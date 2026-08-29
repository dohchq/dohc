import { createHash, randomBytes } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import {
  createSeededLink,
  expect,
  ownerHeaders,
  seedShare,
  test,
  type SeededLink,
} from "./harness";

const ATTACK_SENTINEL = "__dohcCommentsAttackSentinel_802c4f9b";
const SENTINEL_BASELINE = "comments-unmodified-802c4f9b";

async function requireOk(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;
  throw new Error(
    `${operation} failed with ${String(response.status)}: ${await response.text()}`,
  );
}

async function appendNamedComment(input: {
  relayUrl: string;
  shareId: string;
  ownerUserId: string;
  body: string;
}): Promise<string> {
  const response = await requireOk(
    await fetch(`${input.relayUrl}/sync/shares/${encodeURIComponent(input.shareId)}/discussion`, {
      method: "POST",
      headers: ownerHeaders(input.ownerUserId, true),
      body: JSON.stringify({
        body: input.body,
        idempotencyKey: `named-${randomBytes(8).toString("hex")}`,
      }),
    }),
    "append named comment",
  );
  const body = (await response.json()) as { message?: { messageId?: unknown } };
  if (typeof body.message?.messageId !== "string") {
    throw new Error("append named comment returned no message id");
  }
  return body.message.messageId;
}

async function deleteComment(input: {
  relayUrl: string;
  shareId: string;
  ownerUserId: string;
  messageId: string;
}): Promise<void> {
  await requireOk(
    await fetch(
      `${input.relayUrl}/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
      {
        method: "POST",
        headers: ownerHeaders(input.ownerUserId, true),
        body: JSON.stringify({ action: "delete", messageId: input.messageId }),
      },
    ),
    "delete comment",
  );
}

async function openLink(
  context: BrowserContext,
  shareWebUrl: string,
  link: SeededLink,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${shareWebUrl}/s/#${link.secret}`);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
  return page;
}

test("keeps mixed View and Comment links isolated over one committed discussion", async ({
  browser,
  stack,
}) => {
  const seeded = await seedShare({
    access: "comment",
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/shared.md", content: "# Shared file\n" }],
  });
  const viewLink = await createSeededLink(stack.relayUrl, seeded, "view");
  const namedBody = "Named comment before either link opens.";
  const namedMessageId = await appendNamedComment({
    relayUrl: stack.relayUrl,
    shareId: seeded.shareId,
    ownerUserId: seeded.ownerUserId,
    body: namedBody,
  });
  const context = await browser.newContext();
  try {
    const commentPage = await openLink(
      context,
      stack.shareWebUrl,
      { grantId: seeded.grantId, secret: seeded.secret },
    );
    await expect(commentPage.locator(".badge")).toHaveText("Comment");
    await expect(commentPage.getByText(namedBody, { exact: true })).toBeVisible();
    await commentPage.getByLabel("Name (optional)").fill("Link Reader");
    await commentPage.getByLabel("Comment", { exact: true }).fill("Committed from Comment");
    await commentPage.getByRole("button", { name: "Post comment" }).click();
    await expect(commentPage.getByText("Committed from Comment", { exact: true })).toBeVisible();
    await expect(commentPage.getByText("Unverified", { exact: true })).toBeVisible();

    const viewPage = await openLink(context, stack.shareWebUrl, viewLink);
    await viewPage.reload();
    await expect(viewPage.getByRole("heading", { name: "Comments" })).toBeVisible();
    await expect(viewPage.locator(".badge")).toHaveText("View");
    await expect(viewPage.getByText(namedBody, { exact: true })).toBeVisible();
    await expect(viewPage.getByText("Committed from Comment", { exact: true })).toBeVisible();
    await expect(viewPage.getByLabel("Comment", { exact: true })).toHaveCount(0);
    await expect(viewPage.getByRole("button", { name: "Post comment" })).toHaveCount(0);

    const commentSession = new URL(commentPage.url()).pathname.slice("/s/".length);
    const viewSession = new URL(viewPage.url()).pathname.slice("/s/".length);
    expect(commentSession).not.toBe(viewSession);
    const cookieNames = (await context.cookies()).map((cookie) => cookie.name);
    expect(cookieNames).toContain(`dohc_share_${commentSession}`);
    expect(cookieNames).toContain(`dohc_share_${viewSession}`);
    expect(cookieNames.filter((name) => name.startsWith("dohc_share_profile_")))
      .toHaveLength(2);

    await deleteComment({
      relayUrl: stack.relayUrl,
      shareId: seeded.shareId,
      ownerUserId: seeded.ownerUserId,
      messageId: namedMessageId,
    });
    await Promise.all([commentPage.reload(), viewPage.reload()]);
    for (const page of [commentPage, viewPage]) {
      await expect(page.getByText("Comment deleted by the owner", { exact: true })).toBeVisible();
      await expect(page.getByText(namedBody, { exact: true })).toHaveCount(0);
      await expect(page.getByText("Committed from Comment", { exact: true })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("keeps hostile comment text inert in the real viewer", async ({
  browser,
  probe,
  stack,
}) => {
  const seeded = await seedShare({
    access: "comment",
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/hostile.md", content: "# Hostile comments fixture\n" }],
  });
  const hostileName = '<img src=x onerror=attack()>\u202e e\u0301';
  const projectedName = hostileName
    .normalize("NFC")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
  const hostileBody = [
    `<script>window.${ATTACK_SENTINEL}="script";fetch("${probe.url}/comment-script")</script>`,
    `[Markdown probe](${probe.url}/comment-markdown)`,
    `javascript:window.${ATTACK_SENTINEL}="javascript"`,
    `data:text/html,<script>window.opener.${ATTACK_SENTINEL}="data"</script>`,
    "\u202e bidi e\u0301 😀 %3Cscript%3E &lt;script&gt;",
  ].join("\n");
  const projectedBody = hostileBody.normalize("NFC");
  const context = await browser.newContext();
  const authoredProbeUrls: string[] = [];
  context.on("request", (request) => {
    if (request.url().startsWith(probe.url)) authoredProbeUrls.push(request.url());
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(
      ({ name, value }) => Reflect.set(window, name, value),
      { name: ATTACK_SENTINEL, value: SENTINEL_BASELINE },
    );
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    await expect(page.getByRole("heading", { name: "Comments", exact: true })).toBeVisible();
    await page.getByLabel("Name (optional)").fill(hostileName);
    await page.getByLabel("Comment", { exact: true }).fill(hostileBody);
    await page.getByRole("button", { name: "Post comment" }).click();

    const row = page.locator(".comment-row").filter({ hasText: projectedName });
    await expect(row).toContainText(projectedBody);
    expect(await row.locator(".comment-body").textContent()).toBe(projectedBody);
    await expect(
      row.locator("a, img, script, style, svg, iframe, object, embed, form, input, button"),
    ).toHaveCount(0);
    await expect(
      row.locator("[href], [src], [action], [data], [style], [onerror], [onload], [onclick]"),
    ).toHaveCount(0);
    const serialized = await row.evaluate((element) => element.innerHTML);
    expect(serialized).toContain("&lt;script&gt;");
    expect(serialized).not.toContain("<script>");
    const viewerUrl = page.url();
    await row.locator(".comment-body").click();
    expect(page.url()).toBe(viewerUrl);
    expect(await page.evaluate((name) => Reflect.get(window, name), ATTACK_SENTINEL))
      .toBe(SENTINEL_BASELINE);
    expect(authoredProbeUrls).toEqual([]);
    expect(probe.requests).toEqual([]);
  } finally {
    await context.close();
  }
});

test("keeps a Comment version share pinned through a main-version rename", async ({
  page,
  stack,
}) => {
  await page.clock.install();
  const pinnedContent = "# Pinned version\n\nThese bytes belong to the snapshot.";
  const seeded = await seedShare({
    access: "comment",
    relayUrl: stack.relayUrl,
    versionId: "snapshot-comments",
    files: [{ path: "docs/pinned.md", content: pinnedContent }],
  });
  const pinned = seeded.files[0]!;
  await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
  await expect(page.getByRole("heading", { name: "docs/pinned.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pinned version" })).toBeVisible();
  await page.getByLabel("Comment", { exact: true }).fill("Snapshot discussion stays writable.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("Snapshot discussion stays writable.", { exact: true }))
    .toBeVisible();

  const liveContent = "# Live main version\n\nThese bytes must stay outside the snapshot.";
  const liveSha = createHash("sha256").update(liveContent).digest("hex");
  const workspacePath = `/sync/${encodeURIComponent(seeded.workspaceId)}`;
  await requireOk(
    await fetch(`${stack.relayUrl}${workspacePath}/blobs/${liveSha}`, {
      method: "PUT",
      headers: ownerHeaders(seeded.ownerUserId),
      body: liveContent,
    }),
    "upload live main blob",
  );
  const recordedAtMs = Date.now();
  await requireOk(
    await fetch(`${stack.relayUrl}${workspacePath}/log`, {
      method: "POST",
      headers: ownerHeaders(seeded.ownerUserId, true),
      body: JSON.stringify({
        originId: `comments-version-${randomBytes(8).toString("hex")}`,
        ops: [{
          originSeq: 0,
          opKind: "moment.append",
          recordedAtMs,
          payload: {
            momentId: `comments-version-${randomBytes(8).toString("hex")}`,
            versionId: "main",
            objectId: pinned.objectId,
            path: "docs/live.md",
            recordedAtMs,
            operation: "rename",
            payloadBeforeBlobSha256: pinned.blobSha256,
            payloadBeforePath: pinned.path,
            payloadAfterBlobSha256: liveSha,
            payloadAfterPath: "docs/live.md",
            metadata: { origin: "user" },
            beforePresent: "present",
          },
        }],
      }),
    }),
    "append live main rename",
  );

  await page.clock.fastForward(4 * 60_000);
  await expect(page.getByRole("heading", { name: "docs/pinned.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pinned version" })).toBeVisible();
  await expect(page.getByText("These bytes belong to the snapshot.", { exact: true })).toBeVisible();
  await expect(page.getByText("Live main version", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Shared files" })
    .getByRole("button", { name: "live.md", exact: true })).toHaveCount(0);
  await expect(page.getByText("Snapshot discussion stays writable.", { exact: true }))
    .toBeVisible();
  await expect(page.locator('main.content textarea, main.content [contenteditable="true"]'))
    .toHaveCount(0);
});
