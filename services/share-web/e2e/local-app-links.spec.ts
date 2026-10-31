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
    const link = `http://localhost:${address.port}`;
    const publicationId = "a".repeat(64);
    // The app cancels one link, and the other sits in a card and stops the click there, as a link in a clickable card does.
    const bytes = Buffer.from(`document.getElementById('root').innerHTML='<p id="state">App loaded</p><a id="handled" href="${link}/handled">Handled</a>` +
      `<div id="card"><a id="out" href="${link}/page">Outside</a></div>';document.getElementById('handled').addEventListener('click',e=>e.preventDefault());` +
      `document.getElementById('out').addEventListener('click',e=>e.stopPropagation());` +
      `document.getElementById('card').addEventListener('click',()=>{document.getElementById('state').textContent='Card opened'});`);
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
    let tabs = 0;
    page.context().on("page", () => tabs++);
    await app.locator("#handled").click();
    const [opened] = await Promise.all([page.context().waitForEvent("page"), app.locator("#out").click()]);
    await expect(opened).toHaveURL(`${link}/page`);
    await expect(opened).toHaveTitle("Outside");
    expect(tabs).toBe(1);
    await expect(app.locator("#state")).toHaveText("App loaded");
  } finally {
    lifetime.abort();
    outside.closeAllConnections(); await new Promise<void>(resolve => outside.close(() => resolve()));
  }
});
