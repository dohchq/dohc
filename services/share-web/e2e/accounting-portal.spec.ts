import { test, expect, chromium } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { sourceCaptureAdapter } from "../../../apps/desktop/src/testing/sourceCaptureAdapter";
import {
  APP_PUBLICATION_LIMITS,
  prepareOwnerAppPublication,
} from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { hashLinkBearer } from "../../sync-relay/src/linkSecurity";
import { compileDatasetOperations } from "../../sync-relay/src/datasetCompiler";
import { createShareWebApplication } from "../src/server";
import { testCertificate } from "./testCertificate";

const viewerOrigin = "https://viewer.example.com";
const example = (path: string) =>
  readFileSync(new URL(`../../../examples/accounting/${path}`, import.meta.url));

async function accountingPortal() {
  const definition = parseDatasetDefinition(JSON.parse(example("dataset.json").toString()), {
    descriptorPath: "accounting/dataset.json",
  });
  const schemaSql = example("schema.sql").toString();
  const operationSource = example("operations.js").toString();
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const manifestBytes = example("portal/app.publish.json");
  const manifest = JSON.parse(manifestBytes.toString()) as { inputs: string[] };
  const sources = new Map<string, Uint8Array>([
    ["accounting/portal/app.publish.json", manifestBytes],
    ["accounting/dataset.json", example("dataset.json")],
  ]);
  for (const path of manifest.inputs) {
    const resolved = posix.join("accounting/portal", path);
    sources.set(resolved, example(resolved.slice("accounting/".length)));
  }
  const prepared = await prepareOwnerAppPublication(
    { workspaceId: "w", appRoot: "accounting/portal", shareId: "s", grantId: "g" },
    {
      shareId: "s",
      grantId: "g",
      generation: 1,
      status: "active",
      revokedAtMs: null,
      selector: { paths: ["accounting"], versionId: null },
    },
    {
      signal: new AbortController().signal,
      assertCurrent() {},
      compile: compileClosedApp,
      async resolveDatasetRevision() {
        return revision;
      },
      adapter: sourceCaptureAdapter(sources),
      deferredWrites: [],
    },
  );
  const directory = mkdtempSync(join(tmpdir(), "dohc-accounting-portal-"));
  const storage = openSyncRelayStorage(join(directory, "relay.sqlite")) as StorageContext;
  const datasetHost = await storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "workers"),
    limits: APP_PUBLICATION_LIMITS,
    compileOperations: compileDatasetOperations,
    nowMs: () => Date.now(),
    onShutdownError(error) {
      throw error;
    },
  });
  const linkKey = "accounting-portal-link-key-with-thirty-two-bytes!",
    exchangeKey = "accounting-portal-relay-exchange-key-with-thirty-two-bytes";
  const secret = "A".repeat(43);
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  const datasetFile = example("dataset.json");
  const datasetSha = createHash("sha256").update(datasetFile).digest("hex");
  storage.putBlob({ workspaceId: "w", sha256: datasetSha, content: datasetFile, createdAtMs: 1 });
  storage.appendLogBatch({
    workspaceId: "w",
    originId: "owner-desktop",
    ops: [
      {
        originSeq: 0,
        opKind: "moment.append",
        recordedAtMs: 1,
        payloadJson: JSON.stringify({
          momentId: "dataset-file-0",
          versionId: "main",
          objectId: "dataset-file",
          path: "accounting/dataset.json",
          recordedAtMs: 1,
          operation: "write",
          beforePresent: "null",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: datasetSha,
          payloadAfterPath: "accounting/dataset.json",
          payloadAfterContentKind: "text",
          payloadAfterByteLength: datasetFile.byteLength,
          metadata: { origin: "api" },
        }),
      },
    ],
  });
  storage.createFileLinkShare({
    share: {
      shareId: "s",
      workspaceId: "w",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["accounting"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "g",
      shareId: "s",
      principalKind: "link",
      principalUserId: null,
      principalEmail: null,
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
    credential: {
      credentialId: "credential",
      grantId: "g",
      secretSealed: null,
      secretHash: hashLinkBearer(secret, linkKey),
      generation: 1,
      mintedAtMs: 1,
      retiredAtMs: null,
    },
    guard() {},
  });
  const relay = createSyncRelayHandler({
    storage,
    datasetHost,
    appPublicationLimits: APP_PUBLICATION_LIMITS,
    linkKey,
    relayExchangeKey: exchangeKey,
    shareWebOrigin: viewerOrigin,
    resolveActor(request, workspaceId) {
      if (request.headers.get("authorization") === "Bearer owner")
        return { workspaceId, userId: "owner" };
      throw new UnauthorizedError();
    },
  });
  const ownerPost = async (path: string, body: unknown) => {
    const response = await relay(
      new Request(`https://relay.example.org/sync/${path}`, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw Error(`Owner ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const owner = (action: string, body: unknown) =>
    ownerPost(`w/datasets/${definition.datasetId}/${action}`, body);
  await owner("activate", {
    revision,
    schemaSql,
    operationSource,
    capacityBytes: 16 * 1024 * 1024,
  });
  const publication = storage.publishAppPublication({
    workspaceId: "w",
    shareId: "s",
    grantId: "g",
    generation: 1,
    ownerUserId: "owner",
    candidate: prepared.candidate,
    limits: APP_PUBLICATION_LIMITS,
    nowMs: Date.now(),
    blobs: prepared.files.map((file) => ({ sha256: file.sha256, bytes: file.bytes })),
  });
  await owner("binding", { publicationId: publication.publicationId, enabled: true });
  const invokes: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    status: number;
  }> = [];
  const application = createShareWebApplication({
    relayUrl: "https://relay.example.org",
    publicRelayUrl: "https://relay.example.org",
    relayExchangeKey: exchangeKey,
    publicHosts: new Set(["viewer.example.com"]),
    newProfileSecret: () => randomBytes(32).toString("base64url"),
    appLaunch: { viewerOrigin, appDomain: "example.net" },
    viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewerOrigin, upstreamUrl: "https://auth.example.org" },
    fetchAuth: async () => Response.json(null),
    fetchRelay: async (request) => {
      const isInvoke =
        request.method === "POST" && new URL(request.url).pathname.endsWith("/invoke");
      const body = isInvoke ? await request.clone().json() : null;
      const response = await relay(request);
      if (body)
        invokes.push({
          url: request.url,
          headers: new Headers(request.headers),
          body,
          status: response.status,
        });
      return response;
    },
  });
  return {
    application,
    relay,
    invokes,
    secret,
    publicationId: publication.publicationId,
    ownerInvoke: (name: string, input: unknown) =>
      owner("invoke", {
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationId: definition.operations.find((operation) => operation.name === name)!
          .operationId,
        input,
        idempotencyKey: randomUUID(),
      }),
    revoke: () =>
      ownerPost("shares/s/revoke", {
        grantId: "g",
        workspaceId: "w",
        expectedDependentGrantIds: [],
      }),
    async close() {
      await datasetHost.close();
      storage.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    },
  };
}

test("the accountant link reads reports, cannot write, and stops working when revoked", async ({}, info) => {
  test.setTimeout(120_000);
  const f = await accountingPortal(),
    failures: string[] = [];
  const { tls, spki } = testCertificate("dohc-accounting-test", [
    "viewer.example.com",
    "*.example.net",
  ]);
  const server = https.createServer(tls, async (req, res) => {
    try {
      if (req.headers.host === "viewer.example.com" && req.url === "/fixture-open") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        res.end(
          `<!doctype html><button id="open">Open books</button><p id="state"></p><script>document.getElementById('open').onclick=async()=>{const exchange=await fetch('/api/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:'${f.secret}'})});if(!exchange.ok){document.getElementById('state').textContent='Link refused '+exchange.status;return;}const {session}=await exchange.json();const r=await fetch('/api/apps/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discriminator:session,publicationId:'${f.publicationId}'})});if(!r.ok){document.getElementById('state').textContent='Launch refused '+r.status;return;}const launch=await r.json();const form=document.createElement('form');form.method='POST';form.action=launch.action;const input=document.createElement('input');input.name='handoff';input.value=launch.handoff;form.append(input);document.body.append(form);form.submit();};</script>`,
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const result = await f.application.handle(
        new Request(`https://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        ...(result.headers.has("set-cookie")
          ? { "set-cookie": result.headers.getSetCookie() }
          : {}),
      });
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No listener");
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`,
      "--no-proxy-server",
    ],
  });
  try {
    const year = new Date().getFullYear();
    await f.ownerInvoke("addFiscalYear", { year });
    const entry = (date: string, lines: Array<[string, number, number]>, memo: string) => ({
      date,
      currency: "USD",
      memo,
      lines: lines.map(([accountId, debitCents, creditCents]) => ({
        accountId,
        ...(debitCents ? { debitCents } : {}),
        ...(creditCents ? { creditCents } : {}),
      })),
    });
    await f.ownerInvoke("postJournalEntries", {
      entries: [
        entry(
          `${year}-01-02`,
          [
            ["1000", 500_000, 0],
            ["3000", 0, 500_000],
          ],
          "Opening capital",
        ),
        entry(
          `${year}-01-10`,
          [
            ["1010", 125_000, 0],
            ["4000", 0, 125_000],
          ],
          "Design retainer",
        ),
        entry(
          `${year}-01-15`,
          [
            ["6000", 180_000, 0],
            ["1000", 0, 180_000],
          ],
          "Studio rent",
        ),
      ],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }),
      page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${viewerOrigin}/fixture-open`);
    await page.getByRole("button", { name: "Open books" }).click();
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const portal = page.frameLocator("iframe");
    await expect(portal.getByRole("heading", { name: "Accountant portal" })).toBeVisible();
    await expect(portal.getByText("In balance")).toBeVisible();
    await expect(portal.getByRole("cell", { name: "$6,250.00" }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("accounting-portal-trial-balance.png") });
    await portal.getByRole("tab", { name: "Income statement" }).click();
    await expect(portal.getByRole("row", { name: /Net income/ })).toContainText("-$550.00");
    await portal.getByRole("tab", { name: "Balance sheet" }).click();
    await expect(portal.getByRole("row", { name: /Total assets/ })).toContainText("$4,450.00");
    await expect(portal.getByText("In balance")).toBeVisible();
    const [reportDownload] = await Promise.all([
      page.waitForEvent("download"),
      portal.getByRole("button", { name: "Download printable HTML" }).click(),
    ]);
    expect(reportDownload.suggestedFilename()).toMatch(/^balanceSheet-\d{4}-\d{2}-\d{2}\.html$/);
    const reportHtml = readFileSync((await reportDownload.path())!, "utf8");
    expect(reportHtml).toContain("Balance sheet");
    expect(reportHtml).toContain("$4,450.00");
    expect(reportHtml).toContain("@media print");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: info.outputPath("accounting-portal-balance-sheet-dark.png") });
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    await expect(portal.getByRole("tab", { name: "Balance sheet" })).toBeHidden();
    await page.screenshot({ path: info.outputPath("accounting-portal-print.png") });
    await page.emulateMedia({ media: "screen" });
    await portal.getByRole("tab", { name: "Account ledger" }).click();
    await expect(portal.getByRole("row", { name: /Closing balance/ })).toContainText("$3,200.00");
    await f.ownerInvoke("postJournalEntries", {
      entries: [
        entry(
          `${year}-01-20`,
          [
            ["1000", 10_000, 0],
            ["4000", 0, 10_000],
          ],
          "Late deposit",
        ),
      ],
    });
    await expect(portal.getByRole("row", { name: /Closing balance/ })).toContainText("$3,300.00", {
      timeout: 5_000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await portal.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("accounting-portal-mobile.png") });

    await page.setViewportSize({ width: 1280, height: 1000 });
    await f.ownerInvoke("postJournalEntries", {
      entries: Array.from({ length: 120 }, (_, index) =>
        entry(
          `${year}-01-03`,
          [
            ["1500", 100, 0],
            ["1010", 0, 100],
          ],
          `Tool ${index + 1}`,
        ),
      ),
    });
    await portal.getByLabel("Account", { exact: true }).selectOption("1500");
    const [ledgerDownload] = await Promise.all([
      page.waitForEvent("download"),
      portal.getByRole("button", { name: "Download printable HTML" }).click(),
    ]);
    const ledgerHtml = readFileSync((await ledgerDownload.path())!, "utf8");
    expect(ledgerHtml).toContain("Tool 1<");
    expect(ledgerHtml).toContain("Tool 120<");
    expect(ledgerHtml).toContain("Closing balance");
    expect(ledgerHtml).toContain("$120.00");

    const read = f.invokes.find(
      (call) => call.body.operation === "trialBalance" && call.status === 200,
    );
    expect(read).toBeDefined();
    const replay = (body: Record<string, unknown>) =>
      f.relay(
        new Request(read!.url, {
          method: "POST",
          headers: read!.headers,
          body: JSON.stringify(body),
        }),
      );
    for (const operation of [
      "postJournalEntry",
      "addFiscalYear",
      "lockPeriod",
      "keepDuplicateBankRow",
      "confirmDuplicateBankRow",
      "findBankMatches",
      "listEntries",
      "overview",
      "receiptAccess",
    ]) {
      const response = await replay({
        ...read!.body,
        operation,
        input:
          operation === "postJournalEntry"
            ? entry(
                `${year}-02-01`,
                [
                  ["6900", 1, 0],
                  ["1000", 0, 1],
                ],
                "Link write",
              )
            : {},
        idempotencyKey: `link-write-${operation}`,
      });
      expect(response.status, `${operation} through the accountant link`).toBeGreaterThanOrEqual(
        400,
      );
    }
    const written = (await f.ownerInvoke("listEntries", { q: "Link write" })) as {
      result: { entries: unknown[] };
    };
    expect(written.result.entries).toHaveLength(0);
    expect(
      (await replay({ ...read!.body, idempotencyKey: "link-read-before-revoke" })).status,
    ).toBe(200);

    await f.revoke();
    expect(
      (await replay({ ...read!.body, idempotencyKey: "link-read-after-revoke" })).status,
    ).toBeGreaterThanOrEqual(400);
    const after = await browser.newContext(),
      revoked = await after.newPage();
    await revoked.goto(`${viewerOrigin}/fixture-open`);
    await revoked.getByRole("button", { name: "Open books" }).click();
    await expect(revoked.locator("#state")).toHaveText(/refused/);
    await page.reload();
    await expect(page.frameLocator("iframe").getByText("In balance")).toHaveCount(0);
    await after.close();
    await context.close();
    expect(failures).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
