import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createLocalAppLaunchHost, type LocalAppLaunchBackend } from "../src/workspaces/localAppLaunch";

// A Collection app that writes when it loads, when its button is pressed, and when its page asks it to, all with no input of its own.
const app = `
  const button = document.createElement('button');
  button.textContent = 'Vote'; button.style = 'display:block;width:200px;height:80px'; document.body.append(button);
  let port, presses = 0;
  const create = key => port.postMessage({ id: key, op: 'collection.create', idempotencyKey: key, fields: { destination: 'Tokyo' } });
  addEventListener('message', event => {
    if (event.source === parent && event.data?.kind === 'write-now' && port) { create('scripted'); return; }
    if (port || event.source !== parent || event.data?.kind !== 'dohc-app-channel') return;
    port = event.ports[0]; port.start();
    create('loaded');
    button.onclick = () => create('pressed-' + ++presses);
  });`;

// Playwright's navigation leaves the page activated, and its evaluate and locator calls run as a user gesture. This
// test reads and drives the page through the DevTools protocol, which grants none, so a real mouse press is the
// only input the page receives after load. A trace also evaluates in the page as a gesture, so it stays off.
test.use({ trace: "off" });
test("@local-app-activation credits a click inside the sandboxed app frame, and nothing the app sends on its own", async ({ page }) => {
  const writes = new Map<unknown, boolean | undefined>(), bytes = Buffer.from(app);
  const backend: LocalAppLaunchBackend = {
    browserPublication: () => ({ authorityRevision: 1, files: [{ path: "bundle.js", contentType: "text/javascript; charset=utf-8",
      sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, bytes }] }),
    assertBrowserPublication() {},
    async request(_publicationId, _action, input, _signal, activated) {
      writes.set((input as { idempotencyKey?: unknown }).idempotencyKey, activated);
      return { kind: "accepted" };
    },
    async readBrowserFile() { throw Error("This app reads no files."); },
  };
  const lifetime = new AbortController(), host = await createLocalAppLaunchHost({ backend, lifetime: lifetime.signal });
  try {
    const devtools = await page.context().newCDPSession(page);
    const run = async (expression: string) => (await devtools.send("Runtime.evaluate", { expression, returnByValue: true })).result.value as unknown;
    const activated = () => run("navigator.userActivation.isActive");
    const write = (key: string) => expect.poll(() => writes.has(key), { timeout: 15_000 }).toBe(true).then(() => writes.get(key));

    // dohc's tab: the only session that credits a click.
    await page.goto((await host.launchSession("a".repeat(64), lifetime.signal, { keepAlive: true })).url);
    // The page opens activated, and the write the app makes as it loads is still its own.
    expect(await write("loaded")).toBe(false);

    const box = await run("(() => { const frame = document.querySelector('iframe').getBoundingClientRect(); return { x: frame.x + 100, y: frame.y + 40 }; })()") as { x: number; y: number };
    await expect.poll(activated, { timeout: 15_000 }).toBe(false);
    await page.mouse.click(box.x, box.y);
    expect(await write("pressed-1")).toBe(true);
    // The press inside the sandboxed frame activated the bootstrap window.
    expect(await activated()).toBe(true);

    await expect.poll(activated, { timeout: 15_000 }).toBe(false);
    await run("document.querySelector('iframe').contentWindow.postMessage({ kind: 'write-now' }, '*')");
    expect(await write("scripted")).toBe(false);
  } finally {
    lifetime.abort();
    await host.close();
  }
});
