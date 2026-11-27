import { test, expect, chromium, type Page } from "@playwright/test";
import https from "node:https";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCookies } from "better-auth/cookies";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createRelayDatasetHost } from "../../sync-relay/src/datasetHost";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { createShareWebApplication } from "../src/server";
import { testCertificate } from "./testCertificate";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [DATASET, TABLE, KEY, ITEM, AMOUNT, PAID, LIST, CREATE, EDIT] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
].map(id) as [string, string, string, string, string, string, string, string, string];
const field = (
  fieldId: string,
  name: string,
  sqlColumn: string,
  type: "text" | "number" | "checkbox",
) => ({ fieldId, name, sqlColumn, type, required: false, unique: false }) as const;
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: DATASET,
  name: "Trip budget",
  schemaPath: "trip/schema.sql",
  operationsPath: "trip/operations.js",
  tables: [
    {
      tableId: TABLE,
      name: "Trip budget",
      sqlName: "records",
      primaryKey: "id",
      fields: [
        {
          ...field(KEY, "Record ID", "id", "text"),
          required: true,
          unique: true,
          generated: "record-id",
        },
        field(ITEM, "Item", "item", "text"),
        field(AMOUNT, "Amount", "amount", "number"),
        field(PAID, "Paid", "paid", "checkbox"),
      ],
    },
  ],
  operations: [
    {
      operationId: LIST,
      name: "records.list",
      label: "View records",
      tableId: TABLE,
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [KEY, ITEM, AMOUNT, PAID],
    },
    {
      operationId: CREATE,
      name: "records.create",
      label: "Create record",
      tableId: TABLE,
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [ITEM, AMOUNT, PAID],
    },
    {
      operationId: EDIT,
      name: "records.edit",
      label: "Edit record",
      tableId: TABLE,
      kind: "edit",
      access: "helper",
      readOnly: false,
      fieldIds: [ITEM, AMOUNT, PAID],
    },
  ],
};
const schemaSql = `CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL,item TEXT,amount REAL,paid INTEGER,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
const operationSource = generateDatasetOperations(definition);
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const owner = { kind: "named", workspaceId: "w", userId: "owner" } as const;
const stamp = {
  workspaceId: "w",
  datasetId: DATASET,
  revision: 1,
  revisionSha256: revision.revisionSha256,
};

async function tripWorkspace(root: string) {
  const storage = openSyncRelayStorage(join(root, "relay.sqlite")) as StorageContext;
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  const host = await createRelayDatasetHost({
    storage,
    directory: join(root, "datasets"),
    limits: { maxFiles: 20, maxMetadataBytes: 65536, maxBundleBytes: 65536 },
    publicEditRelease: undefined,
    onShutdownError(error) {
      throw error;
    },
  });
  await host.activate(owner, {
    workspaceId: "w",
    revision,
    schemaSql,
    operationSource,
    capacityBytes: 1 << 20,
  });
  const manifest = JSON.stringify({ datasetId: DATASET });
  storage.putBlob({
    workspaceId: "w",
    sha256: sha(manifest),
    content: Buffer.from(manifest),
    createdAtMs: 1,
  });
  storage.appendLogBatch({
    workspaceId: "w",
    originId: "desktop",
    ops: [
      {
        originSeq: 0,
        opKind: "moment.append",
        recordedAtMs: 1,
        payloadJson: JSON.stringify({
          momentId: "manifest",
          versionId: "main",
          objectId: "dataset",
          path: "trip/dataset.json",
          recordedAtMs: 1,
          operation: "write",
          beforePresent: "null",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: sha(manifest),
          payloadAfterPath: "trip/dataset.json",
          payloadAfterContentKind: "text",
          payloadAfterByteLength: Buffer.byteLength(manifest),
          metadata: { origin: "api" },
        }),
      },
    ],
  });
  for (const [key, item, amount] of [
    ["flights", "Flights", 2560],
    ["hotel", "Hotel", 960],
    ["museum", "Museum passes", 120],
  ] as const)
    await host.invoke(owner, {
      ...stamp,
      operationId: CREATE,
      input: { values: { [ITEM]: item, [AMOUNT]: amount, [PAID]: false } },
      idempotencyKey: key,
    });
  for (const userId of ["ben", "cara"])
    storage.createShare({
      share: {
        shareId: `${userId}-share`,
        workspaceId: "w",
        granterUserId: "owner",
        selectorJson: JSON.stringify({ paths: ["trip"], versionId: null }),
        createdAtMs: 1,
      },
      grant: {
        grantId: `${userId}-grant`,
        shareId: `${userId}-share`,
        principalKind: "user",
        principalUserId: userId,
        principalEmail: null,
        access: "edit",
        generation: 1,
        status: "active",
        createdAtMs: 1,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
  host.setDataGrant(owner, {
    workspaceId: "w",
    datasetId: DATASET,
    grantId: "ben-grant",
    grant: {
      operationIds: [LIST, EDIT],
      discover: true,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  const ownerRows = async () =>
    (
      (
        await host.invoke(owner, {
          ...stamp,
          operationId: LIST,
          input: {},
          idempotencyKey: crypto.randomUUID(),
        })
      ).result as { rows: { id: string; version: number; values: Record<string, unknown> }[] }
    ).rows;
  return { storage, host, ownerRows };
}

test("a teammate invited by name edits a Collection's records in the browser, and the owner sees each change", async ({}, testInfo) => {
  const viewer = "https://viewer.example.com";
  const root = mkdtempSync(join(tmpdir(), "dohc-named-collection-"));
  const { storage, host, ownerRows } = await tripWorkspace(root);
  const exchangeKey = "named-collection-relay-exchange-key-with-more-than-thirty-two-bytes";
  const account = getCookies({ baseURL: viewer });
  const cookies = {
    ben: `${account.sessionToken.name}=ben-account-secret`,
    cara: `${account.sessionToken.name}=cara-account-secret`,
  };
  const userOf = (cookie: string | null) =>
    (Object.entries(cookies).find(([, value]) => value === cookie)?.[0] ?? null) as
      | "ben"
      | "cara"
      | null;
  const relay = createSyncRelayHandler({
    storage,
    datasetHost: host,
    relayExchangeKey: exchangeKey,
    shareWebOrigin: viewer,
    resolveActor: (request, workspaceId) => {
      const userId = userOf(request.headers.get("cookie"));
      if (!userId) throw Error("Unknown account");
      return { userId, workspaceId };
    },
    resolveAccountSession: async (request) => {
      const cookie = request.headers.get("cookie"),
        userId = userOf(cookie);
      if (!userId) throw Error("Unknown account");
      return {
        userId,
        sessionId: cookie!,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        clientKind: "browser",
      };
    },
  });
  const signedIn = new Set<string>();
  const requests = {
    maxPendingRequests: 8,
    maxRequestBytes: 16384,
    maxResponseBytes: 65536,
    timeoutMs: 10_000,
  };
  const application = createShareWebApplication({
    publicHosts: new Set(["viewer.example.com"]),
    relayUrl: "https://relay.example.org",
    publicRelayUrl: "https://relay.example.org",
    relayExchangeKey: exchangeKey,
    viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    namedBrowserSessionLimits: requests,
    fetchRelay: relay,
    fetchAuth: async (request) => {
      const path = new URL(request.url).pathname,
        user = userOf(request.headers.get("cookie"));
      if (path === "/api/auth/get-session")
        return Response.json(
          user && signedIn.has(user)
            ? {
                user: { id: user, name: user === "ben" ? "Ben" : "Cara" },
                session: { userId: user },
              }
            : null,
        );
      if (path === "/api/auth/sign-in/email") {
        const { email } = (await request.json()) as { email: string };
        const who = email.split("@")[0] as "ben" | "cara";
        signedIn.add(who);
        return Response.json(
          { redirect: false, user: { id: who, name: who } },
          { headers: { "set-cookie": cookies[who] + "; Secure; HttpOnly; SameSite=Lax; Path=/" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const { tls, spki } = testCertificate("dohc-named-collection-test", ["viewer.example.com"]);
  const server = https.createServer(tls, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    const response = await application.handle(
      new Request(`https://${req.headers.host}${req.url}`, {
        method: req.method!,
        headers,
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      ...(response.headers.has("set-cookie")
        ? { "set-cookie": response.headers.getSetCookie() }
        : {}),
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port}`,
      "--no-proxy-server",
    ],
  });
  const failures: string[] = [];
  const open = async (who: "ben" | "cara") => {
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.route("**/api/live/named-documents", (route) =>
      route.fulfill({
        json: {
          subjectName: "Trip",
          sharerName: "Ana (owner@example.test)",
          access: "edit",
          userId: who,
          workspaceId: `named:${who}-grant`,
          shareId: `${who}-share`,
          grantId: `${who}-grant`,
          limits: {
            provider: {
              frames: {
                receive: {
                  maxFrameBytes: 2048,
                  maxStateVectorBytes: 4096,
                  maxUpdateBytes: 8192,
                  maxSyncBytes: 16384,
                },
                maxQueuedBytes: 16384,
                maxQueuedFrames: 64,
                maxControlBytes: 4096,
                maxControlFrames: 8,
                maxAssemblyBytes: 16384,
              },
              maxPendingUpdateBytes: 16384,
              maxPendingUpdates: 8,
              maxDeliveryAttempts: 4,
            },
            maxHttpResponseBytes: 16384,
            maxSocketBufferedBytes: 16384,
            connectTimeoutMs: 5000,
            sendTimeoutMs: 1000,
            drainPollMs: 10,
          },
          files: [],
        },
      }),
    );
    await page.goto(`${viewer}/s/edit/${who}-grant`);
    await page.getByLabel("Email", { exact: true }).fill(`${who}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    return page;
  };
  const amountOf = async (item: string) =>
    (await ownerRows()).find((row) => row.values[ITEM] === item)?.values[AMOUNT];
  const shoot = async (page: Page, name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: testInfo.outputPath(`${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  try {
    const page = await open("ben");
    await page.getByRole("button", { name: "Trip budget" }).click();
    const table = page.getByRole("region", { name: "Trip budget" });
    await expect(table.getByRole("columnheader")).toHaveText(["Item", "Amount", "Paid"]);
    await expect(table.getByRole("row")).toHaveCount(4);
    await shoot(page, "collection-table");

    const hotel = table.getByRole("button", { name: "Edit Amount: 960" });
    await hotel.focus();
    await page.keyboard.press("Enter");
    const input = table.getByRole("spinbutton", { name: "Amount, Hotel" });
    await expect(input).toBeFocused();
    await input.fill("1010");
    await shoot(page, "collection-editing");
    await page.keyboard.press("Enter");
    await expect(table.getByRole("button", { name: "Edit Amount: 1010" })).toBeFocused();
    await expect(page.getByRole("status")).toContainText("Saved");
    expect(await amountOf("Hotel")).toBe(1010);

    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    await table.getByRole("button", { name: "Edit Item: Museum passes" }).click();
    await page.keyboard.type(" and tours");
    await page.keyboard.press("Escape");
    await expect(table.getByRole("button", { name: "Edit Item: Museum passes" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.type(" and tours");
    await page.keyboard.press("Enter");
    await expect(
      table.getByRole("button", { name: "Edit Item: Museum passes and tours" }),
    ).toBeFocused();

    await table.getByRole("button", { name: "Edit Amount: 1010" }).click();
    await input.selectText();
    await page.keyboard.type("1-2");
    await page.keyboard.press("Enter");
    expect(await input.evaluate((control: HTMLInputElement) => control.validity.badInput)).toBe(
      true,
    );
    await expect(input).toBeFocused();
    expect(await amountOf("Hotel")).toBe(1010);
    await page.keyboard.press("Escape");

    await table.getByRole("button", { name: "Edit Amount: 2560" }).click();
    await table.getByRole("spinbutton", { name: "Amount, Flights" }).fill("2400");
    const flights = (await ownerRows()).find((row) => row.values[ITEM] === "Flights")!;
    await host.invoke(owner, {
      ...stamp,
      operationId: EDIT,
      input: { id: flights.id, expectedVersion: flights.version, values: { [AMOUNT]: 2600 } },
      idempotencyKey: crypto.randomUUID(),
    });
    await page.keyboard.press("Enter");
    await expect(table.getByRole("alert")).toHaveText(/This row changed since it loaded/);
    await expect(table.getByRole("spinbutton", { name: "Amount, Flights" })).toHaveValue("2400");
    expect(await amountOf("Flights")).toBe(2600);
    await shoot(page, "collection-stale");
    await table.getByRole("button", { name: "Load current row" }).click();
    await expect(table.getByRole("alert")).toHaveCount(0);
    await table.getByRole("spinbutton", { name: "Amount, Flights" }).press("Enter");
    await expect(table.getByRole("button", { name: "Edit Amount: 2400" })).toBeVisible();
    expect(await amountOf("Flights")).toBe(2400);

    await table.getByRole("button", { name: "Edit Paid: No" }).first().click();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await expect(table.getByRole("button", { name: "Edit Paid: Yes" })).toHaveCount(1);
    await page.close();

    const cara = await open("cara");
    await expect(cara.getByRole("navigation", { name: "Shared files" })).toContainText(
      "Refresh files",
    );
    await expect(cara.getByRole("button", { name: "Trip budget" })).toHaveCount(0);
    await cara.close();
    expect(failures).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    storage.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
