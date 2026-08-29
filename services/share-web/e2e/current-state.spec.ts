import { createHash, randomBytes } from "node:crypto";
import { expect, ownerHeaders, seedShare, test } from "./harness";

const HISTORY_OPS = 100_001;
const LOG_BATCH_SIZE = 500;

async function requireOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  throw new Error(
    `${operation} failed with ${String(response.status)}: ${await response.text()}`,
  );
}

test("opens mature shares from current state and then follows forward updates", async ({
  page,
  stack,
}) => {
  test.setTimeout(180_000);
  await page.clock.install();
  const initialContent = "# Current projection\n\nOpened without replaying mature history.";
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/mature.md", content: initialContent }],
  });
  const file = seeded.files[0]!;
  const workspacePath = `/sync/${encodeURIComponent(seeded.workspaceId)}`;
  const originId = `mature-history-${randomBytes(8).toString("hex")}`;
  const startedAtMs = Date.now();
  const logRequestCursors: number[] = [];

  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname !== "/api/view/log") return;
    logRequestCursors.push(Number(requestUrl.searchParams.get("since")));
  });

  for (let offset = 0; offset < HISTORY_OPS; offset += LOG_BATCH_SIZE) {
    const count = Math.min(LOG_BATCH_SIZE, HISTORY_OPS - offset);
    const ops = Array.from({ length: count }, (_, batchIndex) => {
      const originSeq = offset + batchIndex;
      return {
        originSeq,
        opKind: "moment.append",
        recordedAtMs: startedAtMs + originSeq,
        payload: {
          momentId: `mature-moment-${String(originSeq)}`,
          versionId: "main",
          objectId: file.objectId,
          path: file.path,
          recordedAtMs: startedAtMs + originSeq,
          operation: "write",
          payloadBeforeBlobSha256: file.blobSha256,
          payloadBeforePath: file.path,
          payloadAfterBlobSha256: file.blobSha256,
          payloadAfterPath: file.path,
          metadata: { origin: "user" },
          beforePresent: "present",
        },
      };
    });
    await requireOk(
      await fetch(`${stack.relayUrl}${workspacePath}/log`, {
        method: "POST",
        headers: ownerHeaders(seeded.ownerUserId, true),
        body: JSON.stringify({ originId, ops }),
      }),
      `append mature history at ${String(offset)}`,
    );
  }

  await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
  await expect(page.getByRole("heading", { name: "mature.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current projection" })).toBeVisible();
  await expect(page.locator("article.markdown")).toContainText(
    "Opened without replaying mature history.",
  );
  expect(logRequestCursors.length).toBeGreaterThan(0);
  expect(logRequestCursors[0]).toBeGreaterThan(HISTORY_OPS);
  expect(logRequestCursors).not.toContain(0);

  const updatedContent = "# Forward update\n\nArrived after current-state startup.";
  const updatedSha = createHash("sha256").update(updatedContent).digest("hex");
  await requireOk(
    await fetch(`${stack.relayUrl}${workspacePath}/blobs/${updatedSha}`, {
      method: "PUT",
      headers: ownerHeaders(seeded.ownerUserId),
      body: updatedContent,
    }),
    "upload forward update",
  );
  await requireOk(
    await fetch(`${stack.relayUrl}${workspacePath}/log`, {
      method: "POST",
      headers: ownerHeaders(seeded.ownerUserId, true),
      body: JSON.stringify({
        originId,
        ops: [{
          originSeq: HISTORY_OPS,
          opKind: "moment.append",
          recordedAtMs: startedAtMs + HISTORY_OPS,
          payload: {
            momentId: `mature-moment-${String(HISTORY_OPS)}`,
            versionId: "main",
            objectId: file.objectId,
            path: file.path,
            recordedAtMs: startedAtMs + HISTORY_OPS,
            operation: "write",
            payloadBeforeBlobSha256: file.blobSha256,
            payloadBeforePath: file.path,
            payloadAfterBlobSha256: updatedSha,
            payloadAfterPath: file.path,
            metadata: { origin: "user" },
            beforePresent: "present",
          },
        }],
      }),
    }),
    "append forward update",
  );

  await page.clock.fastForward(4 * 60_000);
  await expect(page.getByRole("heading", { name: "Forward update" })).toBeVisible();
  await expect(page.locator("article.markdown")).toContainText(
    "Arrived after current-state startup.",
  );
});
