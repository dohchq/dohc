import {createServer} from "node:https";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {test, expect} from "@playwright/test";
import {WebSocketServer} from "ws";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import {createLiveFrameSession, encodeLiveFrameSync, type LiveFrame} from "@dohc/live-session-contract/live-frame";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {ensureLocalhostTls} from "../src/testing/device-control/localhostTls.js";

// Real browser, HTTPS/WSS, editor and wire codec. This host fixture does not prove native durability or account authentication.
test("named invitation signs in, edits the current Y.Doc, and preserves a stopped draft for review", async ({browser}, testInfo) => {
  const service = fileURLToPath(new URL("..", import.meta.url)), tls = await ensureLocalhostTls();
  const frames = {receive: {maxFrameBytes: 2048, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384};
  const limits = {provider: {frames, maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
    maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 5000, sendTimeoutMs: 1000, drainPollMs: 10};
  const doc = markdownToYDoc("# Shared file\n\nEdit together.");
  const binding = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: "document", lineageClaimId: "a".repeat(64),
    currentPath: "docs/shared.md", selectorPaths: ["docs"], restoreFenceGeneration: 1};
  let origin = "", accept = true, cursor = 0, refuseSession: (() => void) | undefined;
  const failures: string[] = [], sockets = new WebSocketServer({noServer: true, perMessageDeflate: false, handleProtocols: protocols => protocols.has("dohc-live-v1") ? "dohc-live-v1" : false});
  const server = createServer({key: await readFile(tls.key), cert: await readFile(tls.certificate)}, async (request, response) => {
    try {
      const url = new URL(request.url!, origin), authenticated = request.headers.cookie === "fixture-account=alice";
      response.setHeader("cache-control", "private, no-store");
      const json = (value: unknown) => {response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value));};
      if (url.pathname === "/api/account/session") {json({user: authenticated ? {id: "alice", name: "Alice"} : null}); return;}
      if (url.pathname === "/api/account/sign-in") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.email !== "alice@example.test" || data.password !== "fixture-password") {response.writeHead(401).end(); return;}
        response.setHeader("set-cookie", "fixture-account=alice; Secure; HttpOnly; SameSite=Strict; Path=/"); json({ok: true}); return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!authenticated) {response.writeHead(404).end(); return;}
        if (url.pathname === "/api/live/named-documents") {json({userId: "alice", workspaceId: "workspace", shareId: "share", grantId: "grant", limits, files: [{objectId: "document", path: binding.currentPath}]}); return;}
        if (url.pathname === "/api/live/named-session") {json({discriminator: "abcdefghijkl", expiresAtMs: Date.now() + 60000}); return;}
        if (url.pathname === "/api/live/named-ticket") {json({token: "ab".repeat(32), expiresAtMs: Date.now() + 60000}); return;}
        response.writeHead(404).end(); return;
      }
      const asset = url.pathname.startsWith("/s/assets/") ? url.pathname.slice(3) : "index.html";
      if (asset.includes("..")) {response.writeHead(404).end(); return;}
      response.setHeader("content-type", asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(join(service, "viewer/dist", asset)));
    } catch (error) {failures.push(String(error)); response.writeHead(500).end();}
  });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
    const protocol = createLiveFrameSession("server", frames);
    const send = (frame: LiveFrame) => {const lease = protocol.send(frame); try {ws.send(lease.value);} finally {lease.release();}};
    refuseSession = () => send({kind: "close", reason: "route-fenced"});
    ws.on("message", bytes => {
      try {
        const lease = protocol.receive(new Uint8Array(bytes as Buffer));
        try {
          if (lease.value.frame.kind === "hello") {
            send({kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy: frames.receive});
            send({kind: "credit", grantedBytes: frames.maxQueuedBytes, grantedFrames: frames.maxQueuedFrames});
          }
          const transfer = lease.value.transfer?.value;
          if (transfer?.begin.purpose === "client-vector") {
            const output = encodeLiveFrameSync({binding, hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc, transfer.bytes)}, frames.receive);
            send({kind: "begin", purpose: "initial-sync", transferId: 1, totalBytes: output.length,
              digest: createHash("sha256").update(output).digest("hex"), appliedThroughJournalCursor: cursor});
            for (let offset = 0; offset < output.length; offset += 1900) send({kind: "chunk", transferId: 1, offset, bytes: output.subarray(offset, offset + 1900)});
          } else if (transfer?.begin.purpose === "submit-update" && accept) {
            Y.applyUpdate(doc, transfer.bytes); cursor++;
            send({kind: "result", result: "success", ack: {deliveryId: transfer.begin.deliveryId, updateDigest: transfer.begin.digest,
              journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: cursor, applicationReplayed: false}});
          }
        } finally {lease.value.transfer?.release(); lease.release();}
      } catch (error) {failures.push(String(error)); ws.close();}
    });
    ws.once("close", () => protocol.close());
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No listener");
  origin = `https://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 860}});
  try {
    const page = await context.newPage(); page.on("pageerror", error => failures.push(String(error)));
    await page.goto(`${origin}/s/edit/grant`);
    await page.getByLabel("Email", {exact: true}).fill("alice@example.test");
    await page.getByLabel("Password", {exact: true}).fill("fixture-password");
    await page.getByRole("button", {name: "Sign in", exact: true}).click();
    await page.getByRole("button", {name: "docs/shared.md", exact: true}).click();
    const editor = page.getByRole("textbox", {name: "Shared file editor"});
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(" Browser edit.");
    await expect.poll(() => yDocToMarkdown(doc)).toContain("Browser edit.");
    await expect(page.getByRole("status")).toContainText("Changes saved");
    expect(await editor.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(360);
    expect(await page.locator(".named-recipient-layout").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(2);
    await page.screenshot({path: testInfo.outputPath("named-editor-desktop.png"), fullPage: true});
    binding.currentPath = "docs/planning/" + "long-shared-file-name-".repeat(7) + "notes.md";
    await page.getByRole("button", {name: "Refresh files", exact: true}).click();
    const longFile = page.getByRole("button", {name: binding.currentPath, exact: true});
    await longFile.click(); await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(longFile).toHaveAttribute("aria-current", "page");
    await longFile.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); await expect(longFile).toBeFocused();
    expect(await longFile.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await page.screenshot({path: testInfo.outputPath("named-editor-long-path.png"), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await editor.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(360);
    await page.screenshot({path: testInfo.outputPath("named-editor-narrow.png"), fullPage: true});
    accept = false; await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(" Unsynced draft.");
    await expect(page.getByLabel("Draft recovery")).toBeVisible();
    refuseSession!(); await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(editor).toContainText("Unsynced draft.");
    await page.getByRole("button", {name: "Open current file", exact: true}).click();
    await expect(page.getByRole("dialog", {name: "Discard this draft?"})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path: testInfo.outputPath("named-editor-discard-narrow.png"), fullPage: true});
    await page.getByRole("button", {name: "Keep reviewing", exact: true}).click();
    await expect(editor).toContainText("Unsynced draft.");
    await page.screenshot({path: testInfo.outputPath("named-recipient.png"), fullPage: true});
    await page.setViewportSize({width: 1280, height: 860});
    await page.screenshot({path: testInfo.outputPath("named-editor-recovery-desktop.png"), fullPage: true});
    expect(failures).toEqual([]);
  } finally {
    await context.close(); for (const socket of sockets.clients) socket.terminate(); sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve())); doc.destroy();
  }
});
