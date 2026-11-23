import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  unmatchedExpectations,
  type AppFrontendBrowserVerifyInput,
} from "../window/appFrontendVerifyBrowser";
import { createDiagnosticScrubber, verifyLocalAppFrontend } from "./appFrontendVerifier";
import { compileClosedApp } from "./closedAppCompiler";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const BOOK_OP_ID = uuid("b9000000", 6);
const LIST_OP_ID = uuid("b9000000", 7);
const CANCEL_OP_ID = uuid("b9000000", 8);

const WORKSHOP_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("b9000000", 1),
  name: "Workshop",
  schemaPath: "workshop/schema.sql",
  operationsPath: "workshop/backend.ts",
  tables: [
    {
      tableId: uuid("b9000000", 2),
      name: "Bookings",
      sqlName: "bookings",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("b9000000", 3),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: uuid("b9000000", 4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("b9000000", 5),
          name: "Seats",
          sqlColumn: "seats",
          type: "number",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: BOOK_OP_ID,
      name: "bookSeat",
      label: "Book a seat",
      tableId: uuid("b9000000", 2),
      kind: "action",
      access: "link",
      readOnly: false,
      fieldIds: [],
    },
    {
      operationId: LIST_OP_ID,
      name: "listBookings",
      label: "List bookings",
      tableId: uuid("b9000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [uuid("b9000000", 3), uuid("b9000000", 4), uuid("b9000000", 5)],
    },
    {
      operationId: CANCEL_OP_ID,
      name: "cancelBooking",
      label: "Cancel booking",
      tableId: uuid("b9000000", 2),
      kind: "action",
      access: "link",
      readOnly: false,
      fieldIds: [],
    },
  ],
};

const WORKSHOP_SCHEMA = `CREATE TABLE "bookings" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL, "seats" INTEGER NOT NULL);`;
const WORKSHOP_BACKEND = `globalThis.operations = {
  bookSeat(ctx, input) {
    const seats = Number(input?.seats ?? 1);
    const taken = Number(ctx.db.query("SELECT COALESCE(SUM(seats), 0) AS t FROM bookings")[0].t);
    if (taken + seats > 8) ctx.refuse("workshop_full", "All 8 seats are booked.");
    ctx.db.execute("INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)", [ctx.requestId, String(input?.name ?? ""), seats]);
    return { id: ctx.requestId, seats };
  },
  listBookings(ctx) {
    return { rows: ctx.db.query("SELECT id, name, seats FROM bookings ORDER BY id") };
  },
  cancelBooking(ctx, input) {
    ctx.db.execute("DELETE FROM bookings WHERE name = ?", [String(input?.name ?? "")]);
    return { cancelled: true };
  },
};`;

const WORKSHOP_REVISION: DatasetRevision = (() => {
  const draft: DatasetRevision = {
    datasetId: WORKSHOP_DEF.datasetId,
    revision: 1,
    revisionSha256: "0".repeat(64),
    definitionSha256: sha(datasetDefinitionDigestContent(WORKSHOP_DEF)),
    schemaSha256: sha(WORKSHOP_SCHEMA),
    operationsSha256: sha(WORKSHOP_BACKEND),
    definition: WORKSHOP_DEF,
  };
  draft.revisionSha256 = sha(datasetRevisionDigestContent(draft));
  return draft;
})();

function makeMemoryAdapter(files: Record<string, string>): VersionedLiveAdapter {
  const encode = (text: string) => new TextEncoder().encode(text);
  const workspaceRef = `mem-${Math.random()}`;
  return {
    workspace: workspaceRef,
    async listTextFileMetadata(input: { under?: string }) {
      return Object.entries(files)
        .filter(
          ([path]) => !input.under || path === input.under || path.startsWith(`${input.under}/`),
        )
        .map(([path, text]) => {
          const bytes = encode(text);
          return {
            path,
            sha256: sha(bytes),
            byteLength: bytes.byteLength,
            hasYdocMarker: false,
          };
        });
    },
    async captureSourceMetadata(input: {
      workspaceId: string;
      versionId: string;
      paths: string[];
    }) {
      const captured = input.paths.map((path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`${path} does not exist`);
        const bytes = encode(text);
        return { path, sha256: sha(bytes), byteLength: bytes.byteLength };
      });
      return {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        sourceDigest: sha(JSON.stringify(captured)),
        files: captured,
      };
    },
    async hydrateCapturedSources(metadata: {
      files: Array<{ path: string; sha256: string; byteLength: number }>;
    }) {
      return metadata.files.map((item) => ({
        ...item,
        bytes: encode(files[item.path]!),
      }));
    },
  } as unknown as VersionedLiveAdapter;
}

async function exchangeLaunchProof(url: string) {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const handoff = parsed.hash.slice(1);
  const boot = await fetch(`${origin}/bootstrap`);
  expect(boot.status).toBe(200);
  const bootHtml = await boot.text();
  expect(bootHtml).toContain("__dohcVerifyObserve");
  const sessionRes = await fetch(`${origin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ handoff }),
  });
  expect(sessionRes.status).toBe(200);
  const { proof, html } = (await sessionRes.json()) as { proof: string; html: string };
  const backend = (body: unknown) =>
    fetch(`${origin}/backend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-dohc-app-proof": proof,
      },
      body: JSON.stringify(body),
    });
  return { origin, proof, html, backend };
}

describe("verifyLocalAppFrontend", () => {
  it("scrubs host paths, loopback origins, tokens, and control characters from diagnostics", () => {
    const scrub = createDiagnosticScrubber(
      "C:\\Users\\alice\\my-workspace",
      "http://127.0.0.1:54321",
    );
    const cleaned = scrub(
      "Error at C:\\Users\\alice\\my-workspace\\apps\\a.js\nfrom http://127.0.0.1:54321/bootstrap#abc123 Bearer secret-tok token=xyz /Users/bob/private.txt",
    );
    expect(cleaned).not.toContain("alice");
    expect(cleaned).not.toContain("127.0.0.1");
    expect(cleaned).not.toContain("secret-tok");
    expect(cleaned).not.toContain("abc123");
    expect(cleaned).not.toContain("/Users/bob");
    expect(cleaned).toContain("<workspace>");
    expect(cleaned).toContain("<local-app>");
    expect(cleaned).toContain("<redacted>");
    expect(cleaned).toContain("<path>");
  });

  it("classifies missing manifest, missing input, and JS syntax errors as compile diagnostics", async () => {
    const controller = new AbortController();
    const runBrowser = vi.fn();
    const baseDeps = (files: Record<string, string>) => ({
      workspaceId: "ws-1",
      workspaceRoot: "C:\\workspace",
      signal: controller.signal,
      assertCurrent: () => {},
      flushCapture: async () => ({ deferredWrites: [] }),
      withAdapter: async <T>(work: (adapter: VersionedLiveAdapter) => Promise<T>) =>
        work(makeMemoryAdapter(files)),
      compile: (req: Parameters<typeof compileClosedApp>[0]) => compileClosedApp(req),
      compileDataset: (src: string, path: string) => compileDatasetOperations(src, path),
      datasetRuntime: {},
      approvedArtifacts: async () => ({
        revision: WORKSHOP_REVISION,
        schemaSql: WORKSHOP_SCHEMA,
        operationSource: WORKSHOP_BACKEND,
        active: true,
      }),
      verificationPublication: vi.fn(),
      runBrowser,
    });

    const noManifest = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/empty" },
      baseDeps({ "apps/empty/index.html": "<!doctype html><h1>Hi</h1>" }),
    );
    expect(noManifest.ok).toBe(false);
    expect(noManifest.stage).toBe("compile");
    expect(noManifest.diagnostics[0]?.code).toBe("manifest_error");

    const syntaxErr = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/bad" },
      baseDeps({
        "apps/bad/app.publish.json": JSON.stringify({
          version: 1,
          entryPath: "index.html",
          inputs: ["index.html", "app.js"],
          packageMap: {},
        }),
        "apps/bad/index.html": '<!doctype html><script type="module" src="./app.js"></script>',
        "apps/bad/app.js": "const x = ;\n",
      }),
    );
    expect(syntaxErr.ok).toBe(false);
    expect(syntaxErr.stage).toBe("compile");
    expect(syntaxErr.diagnostics[0]?.code).toBe("compile_error");
    expect(syntaxErr.diagnostics[0]?.path).toBe("apps/bad/app.js");
    expect(syntaxErr.diagnostics[0]?.line).toBe(1);
    expect(runBrowser).not.toHaveBeenCalled();
  });

  it("runs ephemeral dataset dry-run against real launch host with capacity refusal and unapproved op rejection", async () => {
    const controller = new AbortController();
    const files: Record<string, string> = {
      "workshop/dataset.json": JSON.stringify(WORKSHOP_DEF),
      "apps/booking/app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html", "app.js"],
        packageMap: {},
        dataset: {
          kind: "dataset",
          datasetPath: "workshop/dataset.json",
          revision: 1,
          revisionSha256: WORKSHOP_REVISION.revisionSha256,
          operationIds: [BOOK_OP_ID, CANCEL_OP_ID],
        },
      }),
      "apps/booking/index.html": '<!doctype html><script type="module" src="./app.js"></script>',
      "apps/booking/app.js": "console.log('ready');",
    };

    const result = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/booking" },
      {
        workspaceId: "ws-1",
        workspaceRoot: "C:\\workspace",
        signal: controller.signal,
        assertCurrent: () => {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(makeMemoryAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: async () => ({
          revision: WORKSHOP_REVISION,
          schemaSql: WORKSHOP_SCHEMA,
          operationSource: WORKSHOP_BACKEND,
          active: true,
        }),
        verificationPublication: vi.fn(),
        runBrowser: async (browserInput: AppFrontendBrowserVerifyInput) => {
          const started = await browserInput.startSession();
          try {
            const { backend } = await exchangeLaunchProof(started.url);

            const okRes = await backend({
              id: "r1",
              op: "backend.invoke",
              operation: "bookSeat",
              idempotencyKey: "k1",
              input: { name: "Ada", seats: 5 },
            });
            expect(okRes.status).toBe(200);
            expect(await okRes.json()).toMatchObject({ result: { seats: 5 }, replayed: false });

            const replayRes = await backend({
              id: "r2",
              op: "backend.invoke",
              operation: "bookSeat",
              idempotencyKey: "k1",
              input: { name: "Ada", seats: 5 },
            });
            expect(replayRes.status).toBe(200);
            expect(await replayRes.json()).toMatchObject({ replayed: true });

            // Reusing the same idempotencyKey on a different write operation must fail like the live journal.
            const crossOpConflict = await backend({
              id: "r2b",
              op: "backend.invoke",
              operation: "cancelBooking",
              idempotencyKey: "k1",
              input: { name: "Ada" },
            });
            expect(crossOpConflict.status).toBe(404);
            expect(
              browserInput.consumeBackendHint("backend.invoke", "cancelBooking"),
            ).toMatchObject({
              reasonCode: "runtime_error",
              diagnosticCode: "broker_runtime_error",
            });

            const fullRes = await backend({
              id: "r3",
              op: "backend.invoke",
              operation: "bookSeat",
              idempotencyKey: "k2",
              input: { name: "Bob", seats: 4 },
            });
            expect(fullRes.status).toBe(409);
            expect(await fullRes.json()).toEqual({
              code: "workshop_full",
              message: "All 8 seats are booked.",
            });

            const unapprovedRes = await backend({
              id: "r4",
              op: "backend.invoke",
              operation: "listBookings",
              idempotencyKey: "k3",
              input: {},
            });
            expect(unapprovedRes.status).toBe(404);
            expect(browserInput.consumeBackendHint("backend.invoke", "listBookings")).toMatchObject(
              {
                reasonCode: "operation_not_approved",
                diagnosticCode: "broker_operation_not_approved",
              },
            );

            const uploadRes = await backend({
              id: "r5",
              op: "backend.upload",
              idempotencyKey: "k4",
              name: "a.txt",
              contentType: "text/plain",
              bytesBase64: "YQ==",
            });
            expect(uploadRes.status).toBe(404);
            expect(browserInput.consumeBackendHint("backend.upload", undefined)).toMatchObject({
              reasonCode: "unsupported_in_dry_run",
              diagnosticCode: "broker_unsupported_in_dry_run",
            });
          } finally {
            await started.stop();
          }

          return {
            ok: true,
            stage: "complete",
            startupOk: true,
            stepsOk: true,
            handshake: { delivered: true, messageCount: 6 },
            brokerCalls: [],
            steps: [],
            diagnostics: [],
            externalRequestsBlocked: 0,
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.target).toMatchObject({ kind: "candidate", appRoot: "apps/booking" });
  });

  it("supports in-memory document Collection dry-run and unconnected refusal", async () => {
    const controller = new AbortController();
    const collectionYaml = "version: 1\nname: Signups\nfields:\n  Name:\n    type: text\n";
    const files: Record<string, string> = {
      "signups/collection.yaml": collectionYaml,
      "apps/form/app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
        collection: {
          kind: "collection-create",
          collectionPath: "../../signups",
          allowedFields: ["Name"],
          requiredFields: ["Name"],
          readFields: ["Name"],
        },
      }),
      "apps/form/index.html": "<!doctype html><h1>Form</h1>",
      "apps/static/app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
      }),
      "apps/static/index.html": "<!doctype html><h1>Static</h1>",
    };

    const collectionResult = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/form" },
      {
        workspaceId: "ws-1",
        workspaceRoot: "C:\\workspace",
        signal: controller.signal,
        assertCurrent: () => {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(makeMemoryAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: vi.fn(),
        verificationPublication: vi.fn(),
        runBrowser: async (browserInput) => {
          const started = await browserInput.startSession();
          try {
            const { backend } = await exchangeLaunchProof(started.url);
            const created = await backend({
              id: "c1",
              op: "collection.create",
              idempotencyKey: "k1",
              fields: { Name: "Ada" },
            });
            expect(created.status).toBe(200);
            const listed = await backend({ id: "l1", op: "collection.list", limit: 10 });
            expect(listed.status).toBe(200);
            expect(await listed.json()).toMatchObject({
              records: [{ fields: { Name: "Ada" } }],
              nextPath: null,
            });
          } finally {
            await started.stop();
          }
          return {
            ok: true,
            stage: "complete",
            startupOk: true,
            stepsOk: true,
            handshake: { delivered: true, messageCount: 2 },
            brokerCalls: [],
            steps: [],
            diagnostics: [],
            externalRequestsBlocked: 0,
          };
        },
      },
    );
    expect(collectionResult.ok).toBe(true);

    const unconnectedResult = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/static" },
      {
        workspaceId: "ws-1",
        workspaceRoot: "C:\\workspace",
        signal: controller.signal,
        assertCurrent: () => {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(makeMemoryAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: vi.fn(),
        verificationPublication: vi.fn(),
        runBrowser: async (browserInput) => {
          const started = await browserInput.startSession();
          try {
            const { backend } = await exchangeLaunchProof(started.url);
            const denied = await backend({ id: "u1", op: "collection.list", limit: 10 });
            expect(denied.status).toBe(404);
            expect(browserInput.consumeBackendHint("collection.list", undefined)).toMatchObject({
              reasonCode: "unconnected",
              diagnosticCode: "broker_unconnected",
            });
          } finally {
            await started.stop();
          }
          return {
            ok: false,
            stage: "runtime",
            startupOk: false,
            stepsOk: true,
            handshake: { delivered: true, messageCount: 1 },
            brokerCalls: [],
            steps: [],
            diagnostics: [],
            externalRequestsBlocked: 0,
          };
        },
      },
    );
    expect(unconnectedResult.ok).toBe(false);
  });

  it("enforces dataset createFields restrictions and monotonic UUIDv7 request IDs in dry-run", async () => {
    const controller = new AbortController();
    const idField = uuid("b9100000", 3);
    const nameField = uuid("b9100000", 4);
    const notesField = uuid("b9100000", 5);
    const createOpId = uuid("b9100000", 6);
    const listOpId = uuid("b9100000", 7);
    const formDef: DatasetDefinition = {
      formatVersion: 1,
      datasetId: uuid("b9100000", 1),
      name: "Signups",
      schemaPath: "signups/schema.sql",
      operationsPath: "signups/backend.ts",
      tables: [
        {
          tableId: uuid("b9100000", 2),
          name: "Guests",
          sqlName: "guests",
          primaryKey: "id",
          fields: [
            {
              fieldId: idField,
              name: "ID",
              sqlColumn: "id",
              type: "text",
              required: true,
              unique: true,
            },
            {
              fieldId: nameField,
              name: "Name",
              sqlColumn: "name",
              type: "text",
              required: true,
              unique: false,
            },
            {
              fieldId: notesField,
              name: "Notes",
              sqlColumn: "notes",
              type: "text",
              required: false,
              unique: false,
            },
          ],
        },
      ],
      operations: [
        {
          operationId: createOpId,
          name: "createGuest",
          label: "Create guest",
          tableId: uuid("b9100000", 2),
          kind: "create",
          access: "link",
          readOnly: false,
          fieldIds: [nameField, notesField],
        },
        {
          operationId: listOpId,
          name: "listGuests",
          label: "List guests",
          tableId: uuid("b9100000", 2),
          kind: "read",
          access: "owner",
          readOnly: true,
          fieldIds: [idField, nameField, notesField],
        },
      ],
    };
    const formSchema = `CREATE TABLE "guests" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL, "notes" TEXT);`;
    const formBackend = `globalThis.operations = {
      createGuest(ctx, input) {
        const values = input?.values ?? {};
        const name = String(values[${JSON.stringify(nameField)}] ?? "");
        const notes = values[${JSON.stringify(notesField)}] ?? null;
        ctx.db.execute("INSERT INTO guests(id, name, notes) VALUES(?, ?, ?)", [ctx.requestId, name, notes]);
        return { id: ctx.requestId };
      },
      listGuests(ctx) {
        return { rows: ctx.db.query("SELECT id, name, notes FROM guests ORDER BY id") };
      },
    };`;
    const formRev: DatasetRevision = (() => {
      const draft: DatasetRevision = {
        datasetId: formDef.datasetId,
        revision: 1,
        revisionSha256: "0".repeat(64),
        definitionSha256: sha(datasetDefinitionDigestContent(formDef)),
        schemaSha256: sha(formSchema),
        operationsSha256: sha(formBackend),
        definition: formDef,
      };
      draft.revisionSha256 = sha(datasetRevisionDigestContent(draft));
      return draft;
    })();
    const files: Record<string, string> = {
      "signups/dataset.json": JSON.stringify(formDef),
      "apps/signup/app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
        dataset: {
          kind: "dataset",
          datasetPath: "signups/dataset.json",
          revision: 1,
          revisionSha256: formRev.revisionSha256,
          operationIds: [createOpId, listOpId],
          createFields: [{ operationId: createOpId, fieldIds: [nameField] }],
        },
      }),
      "apps/signup/index.html": "<!doctype html><h1>Signup</h1>",
    };

    const result = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/signup" },
      {
        workspaceId: "ws-1",
        workspaceRoot: "C:\\workspace",
        signal: controller.signal,
        assertCurrent: () => {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(makeMemoryAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: async () => ({
          revision: formRev,
          schemaSql: formSchema,
          operationSource: formBackend,
          active: true,
        }),
        verificationPublication: vi.fn(),
        runBrowser: async (browserInput) => {
          const started = await browserInput.startSession();
          try {
            const { backend } = await exchangeLaunchProof(started.url);

            const unapprovedField = await backend({
              id: "f-bad-1",
              op: "backend.invoke",
              operation: "createGuest",
              idempotencyKey: "bad-field",
              input: { values: { [nameField]: "Ada", [notesField]: "VIP" } },
            });
            expect(unapprovedField.status).toBe(404);
            expect(browserInput.consumeBackendHint("backend.invoke", "createGuest")).toMatchObject({
              reasonCode: "operation_not_approved",
              diagnosticCode: "broker_operation_not_approved",
            });

            const badShape = await backend({
              id: "f-bad-2",
              op: "backend.invoke",
              operation: "createGuest",
              idempotencyKey: "bad-shape",
              input: { [nameField]: "Ada" },
            });
            expect(badShape.status).toBe(404);
            expect(browserInput.consumeBackendHint("backend.invoke", "createGuest")).toMatchObject({
              reasonCode: "operation_not_approved",
              diagnosticCode: "broker_operation_not_approved",
            });

            const expectedNames: string[] = [];
            for (let i = 1; i <= 12; i++) {
              const name = `guest-${i}`;
              expectedNames.push(name);
              const res = await backend({
                id: `c-${i}`,
                op: "backend.invoke",
                operation: "createGuest",
                idempotencyKey: `k-${i}`,
                input: { values: { [nameField]: name } },
              });
              expect(res.status).toBe(200);
            }
            const listed = await backend({
              id: "l-all",
              op: "backend.invoke",
              operation: "listGuests",
              idempotencyKey: "k-list",
              input: {},
            });
            expect(listed.status).toBe(200);
            const body = (await listed.json()) as {
              result: { rows: Array<{ id: string; name: string }> };
            };
            expect(body.result.rows.map((row) => row.name)).toEqual(expectedNames);
            for (const row of body.result.rows) {
              expect(row.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
              );
            }
          } finally {
            await started.stop();
          }
          return {
            ok: true,
            stage: "complete",
            startupOk: true,
            stepsOk: true,
            handshake: { delivered: true, messageCount: 15 },
            brokerCalls: [],
            steps: [],
            diagnostics: [],
            externalRequestsBlocked: 0,
          };
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses reversible dataset actions that omit or oversize undo without committing", async () => {
    const controller = new AbortController();
    const idField = uuid("b9200000", 3);
    const nameField = uuid("b9200000", 4);
    const addOpId = uuid("b9200000", 6);
    const undoOpId = uuid("b9200000", 7);
    const listOpId = uuid("b9200000", 8);
    const revDef: DatasetDefinition = {
      formatVersion: 1,
      datasetId: uuid("b9200000", 1),
      name: "Tasks",
      schemaPath: "tasks/schema.sql",
      operationsPath: "tasks/backend.ts",
      tables: [
        {
          tableId: uuid("b9200000", 2),
          name: "Tasks",
          sqlName: "tasks",
          primaryKey: "id",
          fields: [
            {
              fieldId: idField,
              name: "ID",
              sqlColumn: "id",
              type: "text",
              required: true,
              unique: true,
            },
            {
              fieldId: nameField,
              name: "Name",
              sqlColumn: "name",
              type: "text",
              required: true,
              unique: false,
            },
          ],
        },
      ],
      operations: [
        {
          operationId: addOpId,
          name: "addTask",
          label: "Add task",
          tableId: uuid("b9200000", 2),
          kind: "action",
          access: "link",
          readOnly: false,
          fieldIds: [],
          reversedBy: "removeTask",
        },
        {
          operationId: undoOpId,
          name: "removeTask",
          label: "Remove task",
          tableId: uuid("b9200000", 2),
          kind: "action",
          access: "owner",
          readOnly: false,
          fieldIds: [],
        },
        {
          operationId: listOpId,
          name: "listTasks",
          label: "List tasks",
          tableId: uuid("b9200000", 2),
          kind: "read",
          access: "owner",
          readOnly: true,
          fieldIds: [idField, nameField],
        },
      ],
    };
    const revSchema = `CREATE TABLE "tasks" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL);`;
    const revBackend = `globalThis.operations = {
      addTask(ctx, input) {
        ctx.db.execute("INSERT INTO tasks(id, name) VALUES(?, ?)", [ctx.requestId, String(input?.name ?? "")]);
        if (input?.mode === "missing") return { id: ctx.requestId };
        if (input?.mode === "oversize") return { id: ctx.requestId, undo: { blob: "x".repeat(20_000) } };
        return { id: ctx.requestId, undo: { id: ctx.requestId } };
      },
      removeTask(ctx, input) {
        ctx.db.execute("DELETE FROM tasks WHERE id = ?", [String(input?.id ?? "")]);
        return { removed: true };
      },
      listTasks(ctx) {
        return { rows: ctx.db.query("SELECT id, name FROM tasks ORDER BY id") };
      },
    };`;
    const revRevision: DatasetRevision = (() => {
      const draft: DatasetRevision = {
        datasetId: revDef.datasetId,
        revision: 1,
        revisionSha256: "0".repeat(64),
        definitionSha256: sha(datasetDefinitionDigestContent(revDef)),
        schemaSha256: sha(revSchema),
        operationsSha256: sha(revBackend),
        definition: revDef,
      };
      draft.revisionSha256 = sha(datasetRevisionDigestContent(draft));
      return draft;
    })();
    const files: Record<string, string> = {
      "tasks/dataset.json": JSON.stringify(revDef),
      "apps/tasks/app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
        dataset: {
          kind: "dataset",
          datasetPath: "tasks/dataset.json",
          revision: 1,
          revisionSha256: revRevision.revisionSha256,
          operationIds: [addOpId, listOpId],
        },
      }),
      "apps/tasks/index.html": "<!doctype html><h1>Tasks</h1>",
    };

    const result = await verifyLocalAppFrontend(
      { action: "verifyFrontend", workspaceId: "ws-1", appRoot: "apps/tasks" },
      {
        workspaceId: "ws-1",
        workspaceRoot: "C:\\workspace",
        signal: controller.signal,
        assertCurrent: () => {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(makeMemoryAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: async () => ({
          revision: revRevision,
          schemaSql: revSchema,
          operationSource: revBackend,
          active: true,
        }),
        verificationPublication: vi.fn(),
        runBrowser: async (browserInput) => {
          const started = await browserInput.startSession();
          try {
            const { backend } = await exchangeLaunchProof(started.url);

            const missing = await backend({
              id: "u1",
              op: "backend.invoke",
              operation: "addTask",
              idempotencyKey: "k-missing",
              input: { name: "bad-1", mode: "missing" },
            });
            expect(missing.status).toBe(409);
            expect(await missing.json()).toMatchObject({ code: "undo_missing" });

            const oversize = await backend({
              id: "u2",
              op: "backend.invoke",
              operation: "addTask",
              idempotencyKey: "k-oversize",
              input: { name: "bad-2", mode: "oversize" },
            });
            expect(oversize.status).toBe(409);
            expect(await oversize.json()).toMatchObject({ code: "undo_missing" });

            const emptyList = await backend({
              id: "u3",
              op: "backend.invoke",
              operation: "listTasks",
              idempotencyKey: "k-list-1",
              input: {},
            });
            expect(emptyList.status).toBe(200);
            expect(await emptyList.json()).toMatchObject({ result: { rows: [] } });

            const okAdd = await backend({
              id: "u4",
              op: "backend.invoke",
              operation: "addTask",
              idempotencyKey: "k-ok",
              input: { name: "good-1", mode: "ok" },
            });
            expect(okAdd.status).toBe(200);

            const afterList = await backend({
              id: "u5",
              op: "backend.invoke",
              operation: "listTasks",
              idempotencyKey: "k-list-2",
              input: {},
            });
            expect(afterList.status).toBe(200);
            expect(await afterList.json()).toMatchObject({
              result: { rows: [{ name: "good-1" }] },
            });
          } finally {
            await started.stop();
          }
          return {
            ok: true,
            stage: "complete",
            startupOk: true,
            stepsOk: true,
            handshake: { delivered: true, messageCount: 5 },
            brokerCalls: [],
            steps: [],
            diagnostics: [],
            externalRequestsBlocked: 0,
          };
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  it("matches overlapping backend expectations using complete one-to-one bipartite matching", () => {
    const calls = [
      { op: "backend.invoke" as const, operation: "load", status: 200, ok: true },
      { op: "backend.invoke" as const, operation: "save", status: 200, ok: true },
    ];
    expect(unmatchedExpectations(calls, [{ op: "backend.invoke" }, { operation: "load" }])).toEqual(
      [],
    );
    expect(
      unmatchedExpectations(calls, [{ operation: "load" }, { operation: "load" }]),
    ).toHaveLength(1);
  });
});
