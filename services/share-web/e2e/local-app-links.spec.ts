import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { createLocalAppLaunchHost } from "../../../apps/desktop/src/workspaces/localAppLaunch";

test("an app opened in a browser from dohc opens a plain link to another site in a new tab", async ({ page }) => {
  const outside = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Outside</title>"); });
  await new Promise<void>(resolve => outside.listen(0, "127.0.0.1", resolve));
  const lifetime = new AbortController();
  try {
    const address = outside.address(); if (!address || typeof address === "string") throw Error("No address");
    // localhost is another origin than the launch page's 127.0.0.1.
    const link = `http://localhost:${address.port}/page`;
    const publicationId = "a".repeat(64);
    const bytes = Buffer.from(`document.getElementById('root').innerHTML='<p id="state">App loaded</p><a id="out" href="${link}">Outside</a>';`);
    const files = [{ path: "bundle.js", contentType: "text/javascript; charset=utf-8", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, bytes }];
    const host = await createLocalAppLaunchHost({
      lifetime: lifetime.signal,
      backend: {
        assertBrowserPublication: () => {},
        browserPublication: () => ({ publicationId, authorityRevision: 1, appRoot: "app", files }),
        request: async () => { throw Error("No backend"); },
        readBrowserFile: async () => { throw Error("No files"); },
      },
    });
    await page.goto(await host.launch(publicationId, lifetime.signal));
    const app = page.frameLocator("iframe");
    await expect(app.locator("#state")).toHaveText("App loaded");
    const [opened] = await Promise.all([page.context().waitForEvent("page"), app.locator("#out").click()]);
    await expect(opened).toHaveURL(link);
    await expect(opened).toHaveTitle("Outside");
    await expect(app.locator("#state")).toHaveText("App loaded");
  } finally {
    lifetime.abort();
    outside.closeAllConnections(); await new Promise<void>(resolve => outside.close(() => resolve()));
  }
});
