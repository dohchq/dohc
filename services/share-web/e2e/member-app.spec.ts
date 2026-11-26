import { test, expect, chromium } from "@playwright/test";
import https from "node:https";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCookies } from "better-auth/cookies";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createRelayDatasetHost } from "../../sync-relay/src/datasetHost";
import { setMemberAppSetting } from "../../sync-relay/src/storage/memberApps";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { createShareWebApplication } from "../src/server";
import { testCertificate } from "./testCertificate";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const record = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const limits = { maxFiles: 20, maxMetadataBytes: 65536, maxBundleBytes: 65536 };
const schemaSql = "CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const operationSource = `globalThis.operations={
  read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE people SET name=? WHERE id=?',[input.name,input.id]);return true;}
};`;
const field = (fieldId: string, name: string, sqlColumn: string) =>
  ({ fieldId, name, sqlColumn, type: "text", required: true, unique: sqlColumn === "id" }) as const;
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Registrations",
  schemaPath: "registrations/schema.sql",
  operationsPath: "registrations/operations.js",
  tables: [
    {
      tableId: id(2),
      name: "People",
      sqlName: "people",
      primaryKey: "id",
      fields: [field(id(3), "ID", "id"), field(id(4), "Name", "name")],
    },
  ],
  operations: [
    {
      operationId: id(6),
      name: "read",
      label: "Read",
      tableId: id(2),
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [id(3), id(4)],
    },
    {
      operationId: id(7),
      name: "edit",
      label: "Edit",
      tableId: id(2),
      kind: "edit",
      access: "helper",
      readOnly: false,
      fieldIds: [id(4)],
    },
  ],
};

/** A workspace where Ana, a Member, shares an app over Registrations that Ben, another Member, opens. */
async function memberWorkspace(root: string) {
  const storage = openSyncRelayStorage(join(root, "relay.sqlite")) as StorageContext;
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  const host = await createRelayDatasetHost({
    storage,
    directory: join(root, "datasets"),
    limits,
    publicEditRelease: undefined,
    onShutdownError(error) {
      throw error;
    },
  });
  const owner = { kind: "named", workspaceId: "w", userId: "owner" } as const;
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  await host.activate(owner, {
    workspaceId: "w",
    revision,
    schemaSql,
    operationSource,
    capacityBytes: 1024 * 1024,
  });
  const manifest = JSON.stringify({ datasetId: definition.datasetId });
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
          path: "registrations/dataset.json",
          recordedAtMs: 1,
          operation: "write",
          beforePresent: "null",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: sha(manifest),
          payloadAfterPath: "registrations/dataset.json",
          payloadAfterContentKind: "text",
          payloadAfterByteLength: Buffer.byteLength(manifest),
          metadata: { origin: "api" },
        }),
      },
    ],
  });
  for (const [userId, email] of [
    ["ana", "ana@example.test"],
    ["ben", "ben@example.test"],
  ] as const)
    storage.inviteWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      workspaceName: "Team",
      email,
      recipientUserId: userId,
      newMemberId: () => `${userId}-entry`,
      newGrantId: () => `${userId}-grant`,
      newShareId: () => "members",
      nowMs: 5,
    });
  storage.setWorkspaceMemberLevel({
    workspaceId: "w",
    actorUserId: "owner",
    level: "edit",
    workspaceName: undefined,
    newShareId: () => "unused",
    nowMs: 6,
  });
  for (const grantId of ["ana-grant", "ben-grant"])
    host.setDataGrant(owner, {
      workspaceId: "w",
      datasetId: definition.datasetId,
      grantId,
      grant: {
        operationIds: [id(6), id(7)],
        discover: true,
        revision: 1,
        revisionSha256: revision.revisionSha256,
      },
    });
  setMemberAppSetting(storage, { workspaceId: "w", actorUserId: "owner", membersCanShare: true });
  return { storage, host, revision };
}

/** Ana's app as her computer uploads it: the build, then every source and bundle byte it names. */
function memberAppUpload(revision: ReturnType<typeof describeDatasetRevision>) {
  const source = Buffer.from("export const greeting = 'Registrations tracker';\n");
  const bundle = Buffer.from(
    "document.getElementById('root').textContent='Registrations tracker is open';",
  );
  const inputs = [{ path: "app/index.ts", sha256: sha(source), byteLength: source.byteLength }];
  const files = [
    {
      path: "bundle.js",
      sha256: sha(bundle),
      byteLength: bundle.byteLength,
      contentType: "text/javascript; charset=utf-8",
    },
  ];
  const compilerIdentity = {
    recipe: "closed-esbuild",
    version: "0.28.1",
    binarySha256: "6".repeat(64),
  } as const;
  const sourceDigest = record("dohc-app-source-v2", {
    entry: "app/index.ts",
    files: inputs,
    packages: [],
  });
  const dependencyLockDigest = record("dohc-app-dependencies-v1", inputs);
  const bundleDigest = record("dohc-app-bundle-v1", files);
  const candidate = parseAppPublicationCandidate(
    {
      versionId: "main",
      appRoot: "app",
      entryPath: "app/index.ts",
      packageMap: {},
      sourceRevision: "1".repeat(64),
      sourceDigest,
      dependencyLockDigest,
      bundleDigest,
      buildDigest: record("dohc-app-build-v1", {
        sourceDigest,
        dependencyLockDigest,
        compiler: compilerIdentity,
        bundleDigest,
      }),
      compilerIdentity,
      inputs,
      dependencies: ["app/index.ts"],
      files,
      capabilities: [
        resolveAppDatasetCapability(
          {
            kind: "dataset",
            datasetId: definition.datasetId,
            revision: 1,
            revisionSha256: revision.revisionSha256,
            operationIds: [id(6), id(7)],
          },
          revision,
        ),
      ],
    },
    limits,
  );
  const header = Buffer.from(JSON.stringify({ slug: "registrations-tracker", candidate }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.byteLength);
  const blobs = [source, bundle].sort((a, b) => sha(a).localeCompare(sha(b)));
  return { body: Buffer.concat([length, header, ...blobs]), source };
}

test("a workspace member reviews another member's app, reads its source, allows it, and opens it", async ({}, testInfo) => {
  const viewer = "https://viewer.example.com";
  const root = mkdtempSync(join(tmpdir(), "dohc-member-app-"));
  const { storage, host, revision } = await memberWorkspace(root);
  const exchangeKey = "member-app-relay-exchange-key-with-more-than-thirty-two-bytes";
  const account = getCookies({ baseURL: viewer }),
    sessionCookie = `${account.sessionToken.name}=ben-account-secret`;
  let signedIn = false;
  const relay = createSyncRelayHandler({
    storage,
    datasetHost: host,
    appPublicationLimits: limits,
    relayExchangeKey: exchangeKey,
    shareWebOrigin: viewer,
    lookupUserDisplayName: async (userId: string) => (userId === "ana" ? "Ana Reyes" : null),
    resolveActor: (request, workspaceId) => {
      if (request.headers.get("cookie") === sessionCookie) return { userId: "ben", workspaceId };
      if (request.headers.get("authorization") === "Bearer session-ana")
        return { userId: "ana", workspaceId };
      throw Error("Unknown account");
    },
  });
  const upload = memberAppUpload(revision);
  const published = await relay(
    new Request("https://relay.example.org/sync/w/member-apps", {
      method: "POST",
      headers: { authorization: "Bearer session-ana", "content-type": "application/octet-stream" },
      body: upload.body,
    }),
  );
  expect(published.status).toBe(200);
  const { publicationId } = (await published.json()) as { publicationId: string };
  const application = createShareWebApplication({
    publicHosts: new Set(["viewer.example.com"]),
    relayUrl: "https://relay.example.org",
    publicRelayUrl: "https://relay.example.org",
    relayExchangeKey: exchangeKey,
    appLaunch: { viewerOrigin: viewer, appDomain: "example.net" },
    viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    fetchRelay: relay,
    fetchAuth: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session")
        return Response.json(
          signedIn && request.headers.get("cookie") === sessionCookie
            ? { user: { id: "ben", name: "Ben" }, session: { userId: "ben" } }
            : null,
        );
      if (path === "/api/auth/sign-in/email") {
        signedIn = true;
        return Response.json(
          { redirect: false, user: { id: "ben", name: "Ben" } },
          { headers: { "set-cookie": sessionCookie + "; Secure; HttpOnly; SameSite=Lax; Path=/" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const { tls, spki } = testCertificate("dohc-member-app-test", [
    "viewer.example.com",
    "*.example.net",
  ]);
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
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`,
      "--no-proxy-server",
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.goto(`${viewer}/s/apps/w/${publicationId}`);
    await page.getByLabel("Email", { exact: true }).fill("ben@example.test");
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const review = page.getByRole("main", { name: "Review app" });
    await expect(review.getByRole("heading", { name: "Review this app" })).toBeVisible();
    await expect(page.getByText("Made by Ana Reyes")).toBeVisible();
    await expect(review).toContainText("Registrations · Edit access");
    await expect(review).toContainText("edit (changes data)");
    await review.getByText("Source files").click();
    await review.getByRole("button", { name: "View" }).click();
    await expect(review.locator("pre")).toHaveText(upload.source.toString());
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: testInfo.outputPath(`member-app-review-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await review.getByRole("button", { name: "Allow and open" }).click();
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    await expect(page.frameLocator("iframe").locator("#root")).toHaveText(
      "Registrations tracker is open",
    );
    await page.screenshot({ path: testInfo.outputPath("member-app-open.png") });
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    storage.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
