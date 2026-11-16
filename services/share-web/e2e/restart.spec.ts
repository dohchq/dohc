import { createHash, randomBytes } from "node:crypto";
import { expect, ownerHeaders, seedShare, test } from "./harness";

test("an open share page goes on following its files after share-web restarts", async ({
  page,
  stack,
}) => {
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/readme.md", content: "# Before the restart\n" }],
    paths: ["docs"],
  });
  await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
  const article = page.locator("article.markdown");
  await expect(article).toContainText("Before the restart");

  await stack.restartShareWeb();

  // The owner changes the file. Only a page whose session outlasted the restart is shown the change.
  const [file] = seeded.files;
  const updated = "# After the restart\n";
  const updatedSha = createHash("sha256").update(updated).digest("hex");
  const workspacePath = `${stack.relayUrl}/sync/${encodeURIComponent(seeded.workspaceId)}`;
  const uploaded = await fetch(`${workspacePath}/blobs/${updatedSha}`, {
    method: "PUT",
    headers: ownerHeaders(seeded.ownerUserId),
    body: updated,
  });
  expect(uploaded.status, await uploaded.text()).toBe(200);
  const recordedAtMs = Date.now();
  const appended = await fetch(`${workspacePath}/log`, {
    method: "POST",
    headers: ownerHeaders(seeded.ownerUserId, true),
    body: JSON.stringify({
      originId: `origin-restart-${randomBytes(8).toString("hex")}`,
      ops: [
        {
          originSeq: 0,
          opKind: "moment.append",
          recordedAtMs,
          payload: {
            momentId: `moment-restart-${randomBytes(8).toString("hex")}`,
            versionId: "main",
            objectId: file!.objectId,
            path: file!.path,
            recordedAtMs,
            operation: "write",
            payloadBeforeBlobSha256: file!.blobSha256,
            payloadBeforePath: file!.path,
            payloadAfterBlobSha256: updatedSha,
            payloadAfterPath: file!.path,
            metadata: { origin: "user" },
            beforePresent: "present",
          },
        },
      ],
    }),
  });
  expect(appended.status, await appended.text()).toBe(200);
  // The page asks for news and waits up to 30 s for an answer, and the restart can end one such wait.
  await expect(article).toContainText("After the restart", { timeout: 70_000 });

  // A reload uses the page's address, which no longer carries the link's secret.
  await page.reload();
  await expect(article).toContainText("After the restart");
});
