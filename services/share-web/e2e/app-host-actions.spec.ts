import { test, expect, chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { sourceCaptureAdapter } from "../../../apps/desktop/src/testing/sourceCaptureAdapter";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { prepareLocalAppPublication } from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import {
  createLocalDatasetHost,
  type LocalDatasetHost,
} from "../../../apps/desktop/src/workspaces/localDatasetHost";
import { openedLocalState } from "../../../apps/desktop/src/testing/preparedLocalState";
import { unguardedCollections } from "../../../apps/desktop/src/testing/collectionsHolder";
import {
  createLocalAppLaunchHost,
  type LocalAppLaunchHost,
} from "../../../apps/desktop/src/workspaces/localAppLaunch";
import { createAppLaunchHandler } from "../src/appLaunch";
import { testCertificate } from "./testCertificate";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(91),
  name: "Invoices",
  schemaPath: "data/schema.sql",
  operationsPath: "data/operations.js",
  tables: [
    {
      tableId: id(92),
      name: "Invoices",
      sqlName: "invoices",
      primaryKey: "id",
      fields: [
        {
          fieldId: id(93),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: id(94),
          name: "Filter",
          sqlColumn: "filter",
          type: "text",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: id(95),
      name: "summary",
      label: "Summary",
      tableId: id(92),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [],
    },
    {
      operationId: id(96),
      name: "refuseSeat",
      label: "Refuse seat",
      tableId: id(92),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [],
    },
    {
      operationId: id(97),
      name: "yearReport",
      label: "Year report",
      tableId: id(92),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [],
      profile: "bulk",
    },
  ],
};

const appSource = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, copyText, print, useApp, useDatasetQuery } from "dohc/app";

const rows = Array.from({ length: 120 }, (_, i) => i + 1);

function App() {
  const [filter, setFilter] = useState("a");
  const [copyStatus, setCopyStatus] = useState("idle");
  const [startupCopy, setStartupCopy] = useState("pending");
  const [printStatus, setPrintStatus] = useState("idle");
  const [secondPrint, setSecondPrint] = useState("idle");
  const [backendStatus, setBackendStatus] = useState("idle");
  const app = useApp();
  const q1 = useDatasetQuery<{ tag: string }>("summary", { slot: 1, filter });
  const q2 = useDatasetQuery<{ tag: string }>("summary", { slot: 2, filter });
  const q3 = useDatasetQuery<{ tag: string }>("summary", { slot: 3, filter });

  useEffect(() => {
    void copyText("startup-spam").then(
      () => setStartupCopy("unexpected-ok"),
      (err) => setStartupCopy(err?.refusal?.code ?? String(err?.status ?? "err")),
    );
  }, []);

  return (
    <div>
      <style>{\`
        body { margin: 0; font: 14px/24px sans-serif; }
        .no-print { padding: 8px; }
        #report-scroll { height: 320px; overflow: auto; }
        @media print {
          .no-print { display: none; }
          #report-scroll { height: auto; overflow: visible; }
        }
      \`}</style>
      <div className="no-print">
        <button id="copy-btn" type="button" onClick={async () => {
          try {
            await copyText("SEAT-KEY-4517");
            setCopyStatus("copied");
          } catch (err: any) {
            setCopyStatus("err:" + (err?.refusal?.code ?? err?.status));
          }
        }}>Copy key</button>
        <button id="print-btn" type="button" onClick={async () => {
          try {
            const box = document.getElementById("report-scroll");
            const extra = box ? Math.max(0, box.scrollHeight - box.clientHeight) : 0;
            await print({ height: document.documentElement.scrollHeight + extra });
            setPrintStatus("printed");
            try {
              await print();
              setSecondPrint("unexpected-second");
            } catch (err: any) {
              setSecondPrint(err?.status + ":" + err?.message);
            }
          } catch (err: any) {
            setPrintStatus("err:" + (err?.refusal?.code ?? err?.status));
          }
        }}>Print invoice</button>
        <button id="refuse-btn" type="button" onClick={async () => {
          try {
            await app.read("refuseSeat");
            setBackendStatus("unexpected-ok");
          } catch (err: any) {
            setBackendStatus("refused:" + err?.status + ":" + err?.refusal?.code);
          }
        }}>Refuse</button>
        <button id="bulk-btn" type="button" onClick={async () => {
          try {
            const report = await app.read<string>("yearReport");
            setBackendStatus("bulk:" + report.length);
          } catch (err: any) {
            setBackendStatus("bulk-err:" + err?.status);
          }
        }}>Year report</button>
        <button id="filter-b" type="button" onClick={() => setFilter("b")}>Filter B</button>
        <button id="filter-c" type="button" onClick={() => setFilter("c")}>Filter C</button>
      </div>
      <p id="startup-copy">{startupCopy}</p>
      <p id="copy-status">{copyStatus}</p>
      <p id="print-status">{printStatus}</p>
      <p id="second-print">{secondPrint}</p>
      <p id="queries">{[q1.data?.tag, q2.data?.tag, q3.data?.tag].join(",")}</p>
      <p id="backend-status">{backendStatus}</p>
      <div id="report-scroll">
        {rows.map((n) => (
          <div key={n}>{n === 120 ? "ROW-120-LOCAL-END" : "LOCAL-ROW-" + n}</div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
`;

const sharedAppSource = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { copyText, createAppClient, print } from "dohc/app";

const client = createAppClient();
const rows = Array.from({ length: 120 }, (_, i) => i + 1);

function SharedApp() {
  const [copyStatus, setCopyStatus] = useState("idle");
  const [printStatus, setPrintStatus] = useState("idle");
  const [refusal, setRefusal] = useState("idle");
  const [fullscreen, setFullscreen] = useState("idle");
  const [wall, setWall] = useState("idle");
  return (
    <div>
      <style>{\`
        body { margin: 0; font: 14px/24px sans-serif; }
        @media print { .no-print { display: none; } }
      \`}</style>
      <div className="no-print">
        <button id="copy-btn" type="button" onClick={async () => {
          await copyText("SHARED-CODE-4517");
          setCopyStatus("copied");
        }}>Copy</button>
        <button id="print-btn" type="button" onClick={async () => {
          await print();
          setPrintStatus("printed");
        }}>Print</button>
        <button id="refuse-btn" type="button" onClick={async () => {
          try {
            await client.invoke("register", {}, "seat-1");
            setRefusal("unexpected-ok");
          } catch (err: any) {
            setRefusal(err?.status + ":" + err?.refusal?.code);
          }
        }}>Register</button>
        <button id="fullscreen-btn" type="button" onClick={async () => {
          try {
            await document.documentElement.requestFullscreen();
            setFullscreen(document.fullscreenElement === document.documentElement ? "on" : "missing");
          } catch (err: any) {
            setFullscreen("err:" + err?.name);
          }
        }}>Full screen</button>
        <button id="wall-btn" type="button" onClick={async () => {
          const started = performance.now();
          const photos = Promise.allSettled(
            Array.from({ length: 100 }, (_, i) =>
              client.file("photo-" + String(i).padStart(12, "0"), "photo"),
            ),
          );
          const call = client.invoke("register", {}, "seat-2").catch(() => null);
          await call;
          const callMs = Math.round(performance.now() - started);
          const results = await photos;
          const loaded = results.filter((r) => r.status === "fulfilled").length;
          setWall(loaded + ":" + callMs + ":" + Math.round(performance.now() - started));
        }}>Photo wall</button>
      </div>
      <p id="wall">{wall}</p>
      <p id="copy-status">{copyStatus}</p>
      <p id="refusal">{refusal}</p>
      <p id="fullscreen">{fullscreen}</p>
      <p id="print-status">{printStatus}</p>
      <div>
        {rows.map((n) => (
          <div key={n}>{n === 120 ? "ROW-120-SHARED-END" : "SHARED-ROW-" + n}</div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<SharedApp />);
`;

function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const streams: string[] = [];
  const cmap = new Map<string, string>();
  const hexToUnicode = (hex: string) => {
    let out = "";
    for (let i = 0; i < hex.length; i += 4) {
      out += String.fromCodePoint(Number.parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  let pos = 0;
  while (true) {
    const start = raw.indexOf("stream", pos);
    if (start < 0) break;
    let bodyStart = start + 6;
    if (raw[bodyStart] === "\r" && raw[bodyStart + 1] === "\n") bodyStart += 2;
    else if (raw[bodyStart] === "\n") bodyStart += 1;
    const end = raw.indexOf("endstream", bodyStart);
    if (end < 0) break;
    pos = end + 9;
    let chunk = buf.subarray(bodyStart, end);
    while (chunk.length > 0 && (chunk[chunk.length - 1] === 10 || chunk[chunk.length - 1] === 13)) {
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    let text: string;
    try {
      text = inflateSync(chunk).toString("latin1");
    } catch {
      text = chunk.toString("latin1");
    }
    if (text.includes("begincmap")) {
      for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
          cmap.set(m[1]!.toUpperCase(), hexToUnicode(m[2]!));
        }
      }
      for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of block[1]!.matchAll(
          /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
        )) {
          const from = Number.parseInt(m[1]!, 16);
          const to = Number.parseInt(m[2]!, 16);
          const base = Number.parseInt(m[3]!, 16);
          const width = m[1]!.length;
          for (let code = from; code <= to; code += 1) {
            cmap.set(
              code.toString(16).toUpperCase().padStart(width, "0"),
              String.fromCodePoint(base + (code - from)),
            );
          }
        }
      }
    } else {
      streams.push(text);
    }
  }
  const decodeHex = (hex: string) => {
    let out = "";
    for (let i = 0; i < hex.length; i += 4) {
      out += cmap.get(hex.slice(i, i + 4).toUpperCase()) ?? "";
    }
    return out;
  };
  const decoded: string[] = [];
  for (const stream of streams) {
    for (const m of stream.matchAll(/\[([^\]]+)\]\s*TJ|<([0-9A-Fa-f]{4,})>\s*Tj/g)) {
      if (m[1]) {
        let line = "";
        for (const h of m[1].matchAll(/<([0-9A-Fa-f]{4,})>/g)) line += decodeHex(h[1]!);
        if (line) decoded.push(line);
      } else if (m[2]) {
        const line = decodeHex(m[2]);
        if (line) decoded.push(line);
      }
    }
  }
  return decoded.join("");
}

test.use({ trace: "off" });

test("local app copyText, multi-page print, anti-spam, and rapid parallel queries work in real Chromium with zero console errors", async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), "dohc-host-actions-local-"));
  const lifetime = new AbortController();
  let backend: LocalDatasetHost | null = null;
  let launcher: LocalAppLaunchHost | null = null;
  try {
    await openedLocalState({ workspaceId: "w", rootPath: root });
    backend = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: root,
    });
    const sources = new Map([
      ["data/dataset.json", Buffer.from(JSON.stringify(definition))],
      [
        "data/schema.sql",
        Buffer.from("CREATE TABLE invoices(id TEXT PRIMARY KEY NOT NULL, filter TEXT NOT NULL);"),
      ],
      [
        "data/operations.js",
        Buffer.from(
          `globalThis.operations = { summary(_ctx, input) { return { tag: input.filter + "-" + input.slot }; }, refuseSeat(ctx) { ctx.refuse("full", "Every seat is taken."); }, yearReport() { return "R".repeat(1536 * 1024); } };`,
        ),
      ],
      ["app/index.tsx", Buffer.from(appSource)],
    ]);
    const adapter = sourceCaptureAdapter(sources);
    const prepared = await backend.prepare({ descriptorPath: "data/dataset.json", adapter });
    const revision = await backend.approve({
      preparationId: prepared.preparationId,
      revisionSha256: prepared.revision.revisionSha256,
    });
    sources.set(
      "app/app.publish.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          entryPath: "index.tsx",
          dataset: {
            kind: "dataset",
            datasetPath: "data/dataset.json",
            revision: revision.revision,
            revisionSha256: revision.revisionSha256,
            operationIds: [id(95), id(96), id(97)],
          },
        }),
      ),
    );
    const publication = await backend.apps.activate(
      await prepareLocalAppPublication(
        { workspaceId: "w", appRoot: "app", versionId: "main" },
        {
          adapter,
          deferredWrites: [],
          compile: compileClosedApp,
          signal: lifetime.signal,
          assertCurrent() {},
          async resolveDatasetRevision() {
            return revision;
          },
        },
      ),
      lifetime.signal,
    );
    launcher = await createLocalAppLaunchHost({ backend: backend.apps, lifetime: lifetime.signal });

    const context = await browser.newContext({
      viewport: { width: 1100, height: 760 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      if (window !== top) return;
      const host = window as unknown as {
        __printCount: number;
        __printHeights: string[];
        __brokerEvents: Array<Record<string, unknown>>;
        __dohcVerifyObserve: (raw: string) => void;
      };
      host.__printCount = 0;
      host.__printHeights = [];
      host.__brokerEvents = [];
      host.__dohcVerifyObserve = (raw: string) => {
        host.__brokerEvents.push(JSON.parse(raw) as Record<string, unknown>);
      };
      const origPrint = window.print.bind(window);
      window.print = () => {
        host.__printCount += 1;
        host.__printHeights.push(document.documentElement.style.getPropertyValue("--dohc-print-h"));
        origPrint();
      };
    });

    const session = await launcher.launchSession(publication.publicationId, lifetime.signal, {
      observeBroker: true,
    });
    await page.goto(session.url);
    const cdp = await context.newCDPSession(page);
    const cdpEval = async <T>(expression: string): Promise<T> =>
      (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value as T;
    await expect
      .poll(
        () =>
          cdpEval<Record<string, unknown> | null>(
            "window.__brokerEvents?.find((e) => e.kind === 'completed' && e.op === 'host.copy') ?? null",
          ),
        { timeout: 15_000 },
      )
      .toMatchObject({
        kind: "completed",
        op: "host.copy",
        status: 409,
        ok: false,
        refusalCode: "user_activation_required",
      });
    await expect
      .poll(() => cdpEval<boolean>("navigator.userActivation?.isActive === true"), {
        timeout: 15_000,
      })
      .toBe(false);
    const app = page.frameLocator("iframe");

    await expect(app.locator("#startup-copy")).toHaveText("user_activation_required");
    await expect(app.locator("#queries")).toHaveText("a-1,a-2,a-3");

    await app.locator("#filter-b").click();
    await app.locator("#filter-c").click();
    await expect(app.locator("#queries")).toHaveText("c-1,c-2,c-3");

    await app.locator("#refuse-btn").click();
    await expect(app.locator("#backend-status")).toHaveText("refused:409:full");
    await app.locator("#bulk-btn").click();
    await expect(app.locator("#backend-status")).toHaveText(`bulk:${1536 * 1024}`);

    await app.locator("#copy-btn").click();
    await expect(app.locator("#copy-status")).toHaveText("copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("SEAT-KEY-4517");

    await app.locator("#print-btn").click();
    await expect(app.locator("#print-status")).toHaveText("printed");
    await expect(app.locator("#second-print")).toContainText("429:");
    await expect(app.locator("#second-print")).toContainText("5.5 s");
    const printState = await page.evaluate(() => ({
      count: (window as unknown as { __printCount: number }).__printCount,
      heights: (window as unknown as { __printHeights: string[] }).__printHeights,
    }));
    expect(printState.count).toBe(1);
    expect(Number.parseInt(printState.heights[0] ?? "0", 10)).toBeGreaterThan(2000);

    await page.evaluate((h) => {
      document.documentElement.style.setProperty("--dohc-print-h", h);
      document.body.classList.add("dohc-printing");
    }, printState.heights[0]!);
    const localPdfText = extractPdfText(await page.pdf());
    expect(localPdfText).toContain("LOCAL-ROW-1");
    expect(localPdfText).toContain("ROW-120-LOCAL-END");

    const sandboxAttr = await page.locator("iframe").getAttribute("sandbox");
    expect(sandboxAttr).not.toContain("allow-modals");
    expect(sandboxAttr).not.toContain("allow-same-origin");
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    lifetime.abort();
    await launcher?.close();
    await backend?.close();
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + "\\") &&
      !resolve(root).startsWith(resolve(tmpdir()) + "/")
    )
      throw Error("Invalid test cleanup directory");
    await rm(root, { recursive: true, force: true });
  }
});

test("share-web app copyText and multi-page print work over HTTPS without weakening sandbox or logging console errors", async () => {
  const compiled = await compileClosedApp({
    entryPath: "index.tsx",
    inputs: [
      {
        path: "index.tsx",
        bytes: Buffer.from(sharedAppSource),
        sha256: createHash("sha256").update(sharedAppSource).digest("hex"),
      },
    ],
    bounds: { maxInputFiles: 16, maxInputBytes: 256 * 1024, maxOutputBytes: 2 * 1024 * 1024 },
  });
  const files = compiled.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    byteLength: file.byteLength,
    contentType: file.contentType,
  }));
  const blobs = new Map(compiled.files.map((file) => [file.sha256, file]));
  const viewer = "https://viewer.example.com";
  const publicationId = "b".repeat(64);
  const photo = Buffer.alloc(64 * 1024, 7);
  const appHandler = createAppLaunchHandler({
    config: { viewerOrigin: viewer, appDomain: "example.net" },
    relayUrl: "https://relay.example.org",
    resolveMaterial: async (_d, cookie) =>
      cookie?.includes("viewer=session")
        ? {
            ok: true,
            capabilityToken: "private-server-capability",
            profileSecret: "private-profile",
            setCookie: null,
            currentCapability: async () => "private-server-capability",
          }
        : { ok: false, status: 404 },
    fetchRelay: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/backend/invoke"))
        return Response.json({ code: "full", message: "Every seat is taken." }, { status: 409 });
      if (path.endsWith("/backend/file")) {
        const { fileId } = (await request.json()) as { fileId: string };
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          file: {
            fileId,
            name: "photo.jpg",
            contentType: "image/jpeg",
            byteLength: photo.byteLength,
            sha256: createHash("sha256").update(photo).digest("hex"),
          },
          bytesBase64: photo.toString("base64"),
        });
      }
      if (path.includes("/blobs/")) {
        const sha = path.split("/").at(-1)!;
        const blob = blobs.get(sha)!;
        return new Response(Buffer.from(blob.bytes), {
          headers: { "content-type": blob.contentType },
        });
      }
      return Response.json({ publicationId, authorityRevision: 1, files });
    },
  });
  const { tls, spki } = testCertificate("dohc-host-actions-share", [
    "viewer.example.com",
    "*.example.net",
  ]);
  const server = https.createServer(tls, async (req, res) => {
    const host = req.headers.host!;
    const path = req.url!;
    if (host === "viewer.example.com" && path === "/") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "viewer=session; Secure; HttpOnly; SameSite=Strict; Path=/",
      });
      res.end(
        `<!doctype html><button id="open">Open app</button><script>document.getElementById('open').onclick=async()=>{const r=await fetch('/api/apps/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discriminator:'abcdefghijkl',publicationId:'${publicationId}'})});const launch=await r.json();const f=document.createElement('form');f.method='POST';f.action=launch.action;const i=document.createElement('input');i.type='hidden';i.name='handoff';i.value=launch.handoff;f.append(i);document.body.append(f);f.submit();};</script>`,
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    const response = await appHandler.handle(
      new Request(`https://${host}${path}`, {
        method: req.method!,
        headers,
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--disable-features=ThirdPartyStoragePartitioning"],
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`,
      "--no-proxy-server",
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      if (window !== top) return;
      (window as unknown as { __printCount: number; __printHeight: string }).__printCount = 0;
      (window as unknown as { __printHeight: string }).__printHeight = "";
      const origPrint = window.print.bind(window);
      window.print = () => {
        (window as unknown as { __printCount: number }).__printCount += 1;
        (window as unknown as { __printHeight: string }).__printHeight =
          document.documentElement.style.getPropertyValue("--dohc-print-h");
        origPrint();
      };
    });

    await page.goto(viewer);
    await page.getByRole("button", { name: "Open app" }).click();
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const app = page.frameLocator("iframe");

    await app.locator("#copy-btn").click();
    await expect(app.locator("#copy-status")).toHaveText("copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("SHARED-CODE-4517");

    await app.locator("#print-btn").click();
    await expect(app.locator("#print-status")).toHaveText("printed");
    const printState = await page.evaluate(() => ({
      count: (window as unknown as { __printCount: number }).__printCount,
      height: (window as unknown as { __printHeight: string }).__printHeight,
    }));
    expect(printState.count).toBe(1);
    expect(Number.parseInt(printState.height, 10)).toBeGreaterThan(2000);

    await page.evaluate((h) => {
      document.documentElement.style.setProperty("--dohc-print-h", h);
      document.body.classList.add("dohc-printing");
    }, printState.height);
    const sharedPdfText = extractPdfText(await page.pdf());
    expect(sharedPdfText).toContain("SHARED-ROW-1");
    expect(sharedPdfText).toContain("ROW-120-SHARED-END");
    await page.evaluate(() => document.body.classList.remove("dohc-printing"));

    await app.locator("#refuse-btn").click();
    await expect(app.locator("#refusal")).toHaveText("409:full");

    await app.locator("#wall-btn").click();
    await expect(app.locator("#wall")).toHaveText(/^100:\d+:\d+$/, { timeout: 20_000 });
    const [, callMs, wallMs] = (await app.locator("#wall").textContent())!.split(":").map(Number);
    console.log(
      `photo wall: 100 reads in ${wallMs} ms, a call during the load settled in ${callMs} ms`,
    );
    expect(callMs).toBeLessThan(wallMs!);

    expect(await page.locator("iframe").getAttribute("allow")).toBe("fullscreen");
    await app.locator("#fullscreen-btn").click();
    await expect(app.locator("#fullscreen")).toHaveText("on");
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null))
      .toBe("IFRAME");
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    const sandboxAttr = await page.locator("iframe").getAttribute("sandbox");
    expect(sandboxAttr).not.toContain("allow-modals");
    expect(sandboxAttr).not.toContain("allow-same-origin");
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
