import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { actualFundraiserFixture, syntheticReceipt } from "./actualFundraiserFixture";
import { loadRequest, openLoadApp, publicLoadBrowser } from "./publicLoadBrowser";

function watch(page?: Page) {
  const paths: string[] = [],
    since: number[] = [],
    errors: string[] = [];
  if (!page) return { paths, since, errors };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    paths.push(path);
    if (path === "/events") since.push(JSON.parse(request.postData() ?? "{}").since);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return { paths, since, errors };
}

test("a share-link app hears another viewer's change without polling, until its link ends", async () => {
  test.setTimeout(90_000);
  const fixture = await actualFundraiserFixture({ loadScenario: "generic" });
  const harness = await publicLoadBrowser(fixture);
  try {
    let writerSeen = watch(),
      readerSeen = watch();
    const writer = await openLoadApp(harness.browser, { colorScheme: "light" }, (page) => {
      writerSeen = watch(page);
    });
    const reader = await openLoadApp(
      harness.browser,
      { colorScheme: "dark", reducedMotion: "reduce" },
      (page) => {
        readerSeen = watch(page);
      },
    );
    const readerApp = reader.page.frameLocator("iframe").locator("body");
    await expect.poll(() => readerSeen.since.includes(fixture.collectionRevision())).toBe(true);

    const upload = await loadRequest(writer.frame, {
      op: "backend.upload",
      idempotencyKey: randomUUID(),
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytes: [...syntheticReceipt],
    });
    expect(upload.ok).toBe(true);
    const before = readerSeen.paths.length;
    const submittedAtMs = Date.now();
    const submitted = await loadRequest(writer.frame, {
      op: "backend.invoke",
      operation: "submit",
      input: { fileId: upload.value.file.fileId },
      idempotencyKey: randomUUID(),
    });
    expect(submitted.ok).toBe(true);
    await expect(readerApp).toHaveAttribute("data-revision", String(fixture.collectionRevision()), {
      timeout: 5_000,
    });
    expect(Date.now() - submittedAtMs).toBeLessThan(5_000);
    expect(
      readerSeen.paths.slice(before).filter((path) => path !== "/events" && path !== "/status"),
    ).toEqual([]);
    expect(readerSeen.paths.filter((path) => path === "/backend")).toEqual([]);
    expect([...writerSeen.errors, ...readerSeen.errors]).toEqual([]);

    const forged = await writer.page.evaluate(async () => {
      const response = await fetch("/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dohc-app-proof": "F".repeat(43) },
        body: JSON.stringify({ since: 0 }),
      });
      return response.status;
    });
    expect(forged).toBe(404);

    const refused = reader.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/events" && response.status() === 404,
    );
    const endedAtMs = Date.now();
    expect(fixture.endLink().ok).toBe(true);
    await refused;
    expect(Date.now() - endedAtMs).toBeLessThan(5_000);
    const afterEnd = await loadRequest(writer.frame, {
      op: "backend.invoke",
      operation: "availability",
      input: {},
      idempotencyKey: randomUUID(),
    });
    expect(afterEnd.ok).toBe(false);
    await expect(reader.page.locator("body")).toHaveAttribute("data-state", "stopped", {
      timeout: 20_000,
    });
    expect(harness.failures).toEqual([]);
  } finally {
    await harness.close();
    await fixture.close();
  }
});
