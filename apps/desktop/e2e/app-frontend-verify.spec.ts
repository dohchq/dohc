import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type {
  OwnerAppPublicationRequest,
  OwnerAppPublicationResult,
} from "@dohc/cli/app-publication";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
} from "./helpers/workspace";

const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate((input) => window.dohcDesktop!.publishOwnerApp(input), request);

async function dataset(page: Page, request: DatasetRequest): Promise<DatasetResult> {
  const result = await page.evaluate(
    async (input) => JSON.stringify(await window.dohcDesktop!.dataset(JSON.parse(input))),
    JSON.stringify(request),
  );
  return JSON.parse(result) as DatasetResult;
}

const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const WORKSHOP_BOOK_OP_ID = uuid("f1000000", 6);
const WORKSHOP_LIST_OP_ID = uuid("f1000000", 7);
const WORKSHOP_DEF = {
  formatVersion: 1 as const,
  datasetId: uuid("f1000000", 1),
  name: "Pottery Workshop",
  schemaPath: "workshop/schema.sql",
  operationsPath: "workshop/backend.ts",
  tables: [
    {
      tableId: uuid("f1000000", 2),
      name: "Bookings",
      sqlName: "bookings",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("f1000000", 3),
          name: "ID",
          sqlColumn: "id",
          type: "text" as const,
          required: true,
          unique: true,
        },
        {
          fieldId: uuid("f1000000", 4),
          name: "Name",
          sqlColumn: "name",
          type: "text" as const,
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("f1000000", 5),
          name: "Seats",
          sqlColumn: "seats",
          type: "number" as const,
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: WORKSHOP_BOOK_OP_ID,
      name: "bookSeat",
      label: "Book a seat",
      tableId: uuid("f1000000", 2),
      kind: "action" as const,
      access: "link" as const,
      readOnly: false,
      fieldIds: [],
    },
    {
      operationId: WORKSHOP_LIST_OP_ID,
      name: "listBookings",
      label: "List bookings",
      tableId: uuid("f1000000", 2),
      kind: "read" as const,
      access: "owner" as const,
      readOnly: true,
      fieldIds: [uuid("f1000000", 3), uuid("f1000000", 4), uuid("f1000000", 5)],
    },
  ],
};

const WORKSHOP_SCHEMA = `CREATE TABLE "bookings" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL, "seats" INTEGER NOT NULL);\n`;
const WORKSHOP_BACKEND = `globalThis.operations = {
  bookSeat(ctx, input) {
    const seats = Number(input?.seats ?? 1);
    if (!Number.isInteger(seats) || seats < 1) ctx.refuse("invalid_seats", "Choose at least 1 seat.");
    const taken = Number(ctx.db.query("SELECT COALESCE(SUM(seats), 0) AS taken FROM bookings")[0].taken);
    if (taken + seats > 8) ctx.refuse("workshop_full", "All 8 seats are booked.");
    ctx.db.execute("INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)", [ctx.requestId, String(input?.name ?? ""), seats]);
    return { id: ctx.requestId, seats };
  },
  listBookings(ctx) {
    return { rows: ctx.db.query("SELECT id, name, seats FROM bookings ORDER BY id") };
  },
};\n`;

const CHANNEL_HELPER = `
let channelPort;
const pending = new Map();
const queue = [];
function send(message) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const frame = { id, ...message };
    pending.set(id, { resolve, reject });
    if (channelPort) channelPort.postMessage(frame);
    else queue.push(frame);
  });
}
window.addEventListener("message", (event) => {
  if (channelPort || event.source !== window.parent || event.data?.kind !== "dohc-app-channel" || event.data?.version !== 1 || event.ports.length !== 1) return;
  channelPort = event.ports[0];
  channelPort.onmessage = ({ data }) => {
    const req = pending.get(data?.id);
    if (!req) return;
    pending.delete(data.id);
    if (data.ok) req.resolve(data.value);
    else req.reject(new Error(data.error?.message ?? ("HTTP " + data.status)));
  };
  channelPort.start();
  while (queue.length) channelPort.postMessage(queue.shift());
});
`;

test("@app-frontend-verify runs sandboxed Electron verification, catches broken frontends, preserves live data, and blocks external network", async () => {
  test.setTimeout(240_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let externalHits = 0;
  const externalServer = createServer((_req, res) => {
    externalHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ leaked: true }));
  });
  await new Promise<void>((resolve) => externalServer.listen(0, "127.0.0.1", resolve));
  const externalPort = (externalServer.address() as { port: number }).port;
  const externalUrl = `http://127.0.0.1:${externalPort}/probe`;

  const writeApp = async (dir: string, files: Record<string, string>) => {
    await mkdir(join(workspace.rootPath, dir), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(workspace.rootPath, dir, name), content, "utf8");
    }
  };

  try {
    await writeApp("workshop", {
      "dataset.json": JSON.stringify(WORKSHOP_DEF, null, 2),
      "schema.sql": WORKSHOP_SCHEMA,
      "backend.ts": WORKSHOP_BACKEND,
    });

    desktop = await launchDesktopApp({ workspace });
    const { workspaceId } = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, workspaceId, "workshop/dataset.json");
    await waitForWorkspaceFile(desktop.page, workspaceId, "workshop/schema.sql");
    await waitForWorkspaceFile(desktop.page, workspaceId, "workshop/backend.ts");

    const dataPrepared = await dataset(desktop.page, {
      action: "prepare",
      workspaceId,
      descriptorPath: "workshop/dataset.json",
    });
    if (dataPrepared.kind !== "prepared") throw new Error("Expected dataset preparation.");
    const dataApproved = await dataset(desktop.page, {
      action: "approve",
      workspaceId,
      preparationId: dataPrepared.preparationId,
      revisionSha256: dataPrepared.revision.revisionSha256,
    });
    if (dataApproved.kind !== "approved") throw new Error("Expected approved dataset.");
    const rev = dataApproved.revision;

    // Seed one live booking (6 seats). Dry-run verification must start empty and never mutate this row.
    const seeded = await dataset(desktop.page, {
      action: "invoke",
      workspaceId,
      datasetPath: "workshop/dataset.json",
      revision: rev.revision,
      revisionSha256: rev.revisionSha256,
      operationId: WORKSHOP_BOOK_OP_ID,
      idempotencyKey: "live-seed-1",
      input: { name: "Live Guest", seats: 6 },
    });
    expect(seeded).toMatchObject({ kind: "invoked", replayed: false });

    const bookingManifest = (operationIds: string[], extraInputs: string[] = []) =>
      JSON.stringify(
        {
          version: 1,
          entryPath: "index.html",
          inputs: ["index.html", ...extraInputs],
          packageMap: {},
          dataset: {
            kind: "dataset",
            datasetPath: "workshop/dataset.json",
            revision: rev.revision,
            revisionSha256: rev.revisionSha256,
            operationIds,
          },
        },
        null,
        2,
      );

    // 1. Working booking app
    await writeApp("apps/booking", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html": [
        "<!doctype html><html><body>",
        "<h1>Pottery Workshop</h1>",
        '<form id="booking-form">',
        '<input id="guest-name" name="name" type="text" required />',
        '<input id="seat-count" name="seats" type="number" value="1" required />',
        '<button id="submit-btn" type="submit">Book</button>',
        "</form>",
        '<p id="status"></p>',
        '<script type="module" src="./app.js"></script>',
        "</body></html>",
      ].join("\n"),
      "app.js": `${CHANNEL_HELPER}
const form = document.getElementById("booking-form");
const statusEl = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("guest-name").value;
  const seats = Number(document.getElementById("seat-count").value);
  try {
    const res = await send({ op: "backend.invoke", operation: "bookSeat", input: { name, seats }, idempotencyKey: crypto.randomUUID() });
    statusEl.textContent = "Booked " + res.result.seats + " seats";
  } catch (error) {
    statusEl.textContent = error.message;
  }
});`,
    });

    // 2. Working startup read app (control tower style)
    await writeApp("apps/control-tower", {
      "app.publish.json": bookingManifest([WORKSHOP_LIST_OP_ID], ["app.js"]),
      "index.html":
        '<!doctype html><html><body><p id="summary">Loading</p><p id="binding"></p><script type="module" src="./app.js"></script></body></html>',
      "app.js": `${CHANNEL_HELPER}
document.getElementById("binding").textContent = "binding:" + typeof globalThis.__dohcVerifyObserve;
(async () => {
  const res = await send({ op: "backend.invoke", operation: "listBookings", input: {}, idempotencyKey: crypto.randomUUID() });
  document.getElementById("summary").textContent = "Rows: " + res.result.rows.length;
})();`,
    });

    // 3. Broken frontends
    await writeApp("apps/missing-input", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html": '<!doctype html><script type="module" src="./app.js"></script>',
    });

    await writeApp("apps/syntax-error", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html": '<!doctype html><script type="module" src="./app.js"></script>',
      "app.js": "export const broken = ;\n",
    });

    await writeApp("apps/csp-inline", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html", "app.js"],
        packageMap: {},
      }),
      "index.html":
        '<!doctype html><html><body><script type="module" src="./app.js"></script></body></html>',
      "app.js":
        'const s = document.createElement("script"); s.textContent = "window.__inlineRan = 1;"; document.body.appendChild(s);',
    });

    await writeApp("apps/csp-form", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
      }),
      "index.html":
        '<!doctype html><html><body><form action="https://example.invalid/submit"><button id="go" type="submit">Go</button></form></body></html>',
    });

    await writeApp("apps/runtime-crash", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html", "app.js"],
        packageMap: {},
      }),
      "index.html": '<!doctype html><script type="module" src="./app.js"></script>',
      "app.js": "const missing = null; missing.crashNow();",
    });

    await writeApp("apps/bad-broker-keys", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html": '<!doctype html><script type="module" src="./app.js"></script>',
      "app.js": `${CHANNEL_HELPER}
send({ op: "backend.invoke", operation: "bookSeat", input: {} }).catch(() => {});`,
    });

    await writeApp("apps/unapproved-op", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html": '<!doctype html><script type="module" src="./app.js"></script>',
      "app.js": `${CHANNEL_HELPER}
send({ op: "backend.invoke", operation: "listBookings", input: {}, idempotencyKey: "k1" }).catch(() => {});`,
    });

    await writeApp("apps/external-fetch", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html", "app.js"],
        packageMap: {},
      }),
      "index.html":
        '<!doctype html><body><p id="out">wait</p><script type="module" src="./app.js"></script></body>',
      "app.js": `fetch(${JSON.stringify(externalUrl)}).then(() => { document.getElementById("out").textContent = "leaked"; }).catch(() => { document.getElementById("out").textContent = "blocked"; });`,
    });

    await writeApp("apps/disabled-click", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html"],
        packageMap: {},
      }),
      "index.html":
        '<!doctype html><body><button id="disabled-btn" disabled>Disabled</button></body>',
    });

    await writeApp("apps/prefill-click", {
      "app.publish.json": bookingManifest([WORKSHOP_BOOK_OP_ID], ["app.js"]),
      "index.html":
        '<!doctype html><body><input id="q" /><button id="noop" type="button">Noop</button><script type="module" src="./app.js"></script></body>',
      "app.js": `${CHANNEL_HELPER}
document.getElementById("q").addEventListener("input", () => {
  send({ op: "backend.invoke", operation: "bookSeat", idempotencyKey: "fill-1", input: { name: "Pre", seats: 1 } }).catch(() => {});
});`,
    });

    await writeApp("apps/stalled-startup", {
      "app.publish.json": JSON.stringify({
        version: 1,
        entryPath: "index.html",
        inputs: ["index.html", "app.js"],
        packageMap: {},
      }),
      "index.html": '<!doctype html><body><script type="module" src="./app.js"></script></body>',
      "app.js": "const end = Date.now() + 4000; while (Date.now() < end) {}",
    });

    await waitForWorkspaceFile(desktop.page, workspaceId, "apps/stalled-startup/app.js");

    // Verify working booking app (5 seats -> 200, then 4 seats -> 409 workshop_full)
    const bookingVerify = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/booking",
      steps: [
        { kind: "fill", selector: "#guest-name", value: "Ada" },
        { kind: "fill", selector: "#seat-count", value: "5" },
        {
          kind: "click",
          selector: "#submit-btn",
          expectBackend: { op: "backend.invoke", operation: "bookSeat", status: 200 },
        },
        { kind: "waitFor", selector: "#status", textIncludes: "Booked 5 seats" },
        { kind: "fill", selector: "#guest-name", value: "Bob" },
        { kind: "fill", selector: "#seat-count", value: "4" },
        {
          kind: "click",
          selector: "#submit-btn",
          expectBackend: {
            op: "backend.invoke",
            operation: "bookSeat",
            status: 409,
            refusalCode: "workshop_full",
          },
        },
        { kind: "waitFor", selector: "#status", textIncludes: "All 8 seats are booked." },
      ],
    });
    expect(bookingVerify).toMatchObject({
      kind: "frontendVerified",
      ok: true,
      stage: "complete",
      startupOk: true,
      stepsOk: true,
      handshake: { delivered: true },
      diagnostics: [],
    });

    // Confirm live Collection is untouched (still only the 1 seeded row: Live Guest, 6 seats)
    const liveAfter = await dataset(desktop.page, {
      action: "invoke",
      workspaceId,
      datasetPath: "workshop/dataset.json",
      revision: rev.revision,
      revisionSha256: rev.revisionSha256,
      operationId: WORKSHOP_LIST_OP_ID,
      idempotencyKey: "live-list-after-verify",
      input: {},
    });
    expect(liveAfter).toMatchObject({
      kind: "invoked",
      result: { rows: [{ name: "Live Guest", seats: 6 }] },
    });

    // Approve booking locally and verify via CLI socket with publicationId ONLY (no appRoot)
    const prepared = await publish(desktop.page, {
      action: "prepareLocal",
      workspaceId,
      appRoot: "apps/booking",
    });
    if (prepared.kind !== "prepared") throw new Error("Expected local preparation.");
    const approved = await publish(desktop.page, {
      action: "approve",
      workspaceId,
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
    if (approved.kind !== "published") throw new Error("Expected local publication.");

    const cliPubVerify = (await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "appPublication",
        args: {
          cwd: workspace.rootPath,
          actor: "agent",
          request: {
            action: "verifyFrontend",
            workspaceId,
            publicationId: approved.publicationId,
            steps: [
              { kind: "fill", selector: "#guest-name", value: "Cara" },
              { kind: "fill", selector: "#seat-count", value: "3" },
              {
                kind: "click",
                selector: "#submit-btn",
                expectBackend: { op: "backend.invoke", operation: "bookSeat", status: 200 },
              },
              { kind: "waitFor", selector: "#status", textIncludes: "Booked 3 seats" },
            ],
          },
        },
      },
      { stateDir: workspace.homeDir },
    )) as OwnerAppPublicationResult;
    expect(cliPubVerify).toMatchObject({
      kind: "frontendVerified",
      ok: true,
      stage: "complete",
      target: {
        kind: "publication",
        publicationId: approved.publicationId,
        appRoot: "apps/booking",
      },
    });

    // Verify startup read app starts with empty DB (Rows: 0, NOT Live Guest!)
    const controlTowerVerify = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/control-tower",
      expectStartupBackend: [{ op: "backend.invoke", operation: "listBookings", status: 200 }],
      steps: [
        { kind: "waitFor", selector: "#summary", textIncludes: "Rows: 0" },
        { kind: "waitFor", selector: "#binding", textIncludes: "binding:undefined" },
      ],
    });
    expect(controlTowerVerify, JSON.stringify(controlTowerVerify)).toMatchObject({
      kind: "frontendVerified",
      ok: true,
    });

    // Broken apps must all fail with actionable diagnostics and zero secret/path leaks
    const missingInput = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/missing-input",
    });
    expect(missingInput).toMatchObject({
      kind: "frontendVerified",
      ok: false,
      stage: "compile",
      diagnostics: [{ code: "missing_input" }],
    });

    const syntaxErr = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/syntax-error",
    });
    expect(syntaxErr).toMatchObject({
      kind: "frontendVerified",
      ok: false,
      stage: "compile",
      diagnostics: [{ code: "compile_error", path: "apps/syntax-error/app.js", line: 1 }],
    });

    const cspInline = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/csp-inline",
    });
    expect(cspInline).toMatchObject({ kind: "frontendVerified", ok: false, stage: "runtime" });
    if (cspInline.kind === "frontendVerified") {
      expect(cspInline.diagnostics.some((d) => d.code === "csp_violation")).toBe(true);
    }

    const cspForm = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/csp-form",
      steps: [{ kind: "click", selector: "#go" }],
    });
    expect(cspForm).toMatchObject({ kind: "frontendVerified", ok: false, stage: "steps" });
    if (cspForm.kind === "frontendVerified") {
      expect(cspForm.diagnostics.some((d) => d.code === "csp_violation")).toBe(true);
    }

    const runtimeCrash = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/runtime-crash",
    });
    expect(runtimeCrash).toMatchObject({ kind: "frontendVerified", ok: false, stage: "runtime" });
    if (runtimeCrash.kind === "frontendVerified") {
      expect(runtimeCrash.diagnostics.some((d) => d.code === "page_exception")).toBe(true);
    }

    const badKeys = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/bad-broker-keys",
    });
    expect(badKeys).toMatchObject({ kind: "frontendVerified", ok: false, stage: "runtime" });
    if (badKeys.kind === "frontendVerified") {
      expect(badKeys.diagnostics.some((d) => d.code === "broker_invalid_keys")).toBe(true);
    }

    const unapprovedOp = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/unapproved-op",
    });
    expect(unapprovedOp).toMatchObject({ kind: "frontendVerified", ok: false, stage: "runtime" });
    if (unapprovedOp.kind === "frontendVerified") {
      expect(unapprovedOp.diagnostics.some((d) => d.code === "broker_operation_not_approved")).toBe(
        true,
      );
    }

    // External HTTP blocked cleanly: 0 server hits, warning diagnostic, no fatal failure when caught
    const extVerify = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/external-fetch",
      steps: [{ kind: "waitFor", selector: "#out", textIncludes: "blocked" }],
    });
    expect(externalHits).toBe(0);
    expect(extVerify).toMatchObject({
      kind: "frontendVerified",
      ok: true,
      externalRequestsBlocked: 1,
    });
    if (extVerify.kind === "frontendVerified") {
      expect(
        extVerify.diagnostics.some(
          (d) => d.code === "external_network_blocked" && d.severity === "warning",
        ),
      ).toBe(true);
    }

    // Disabled button click must fail with step_not_clickable
    const disabledClick = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/disabled-click",
      steps: [{ kind: "click", selector: "#disabled-btn" }],
    });
    expect(disabledClick).toMatchObject({ kind: "frontendVerified", ok: false, stage: "steps" });
    if (disabledClick.kind === "frontendVerified") {
      expect(disabledClick.diagnostics.some((d) => d.code === "step_not_clickable")).toBe(true);
    }

    // Earlier-step in-flight backend call must not satisfy a later no-op click's expectBackend
    const prefillClick = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/prefill-click",
      timeoutMs: 1500,
      steps: [
        { kind: "fill", selector: "#q", value: "hi" },
        {
          kind: "click",
          selector: "#noop",
          expectBackend: { op: "backend.invoke", operation: "bookSeat", status: 200 },
        },
      ],
    });
    expect(prefillClick).toMatchObject({ kind: "frontendVerified", ok: false, stage: "steps" });
    if (prefillClick.kind === "frontendVerified") {
      expect(prefillClick.diagnostics.some((d) => d.code === "expected_backend_missing")).toBe(
        true,
      );
    }

    // Long valid selector + textIncludes must not exceed result schema remedy max length
    const longSelector = `#status, .${"a".repeat(185)}`;
    const longText = "x".repeat(200);
    const longWaitFor = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/booking",
      timeoutMs: 1200,
      steps: [{ kind: "waitFor", selector: longSelector, textIncludes: longText }],
    });
    expect(longWaitFor).toMatchObject({ kind: "frontendVerified", ok: false, stage: "steps" });
    if (longWaitFor.kind === "frontendVerified") {
      expect(longWaitFor.diagnostics[0]?.code).toBe("step_text_mismatch");
      expect((longWaitFor.diagnostics[0]?.remedy.length ?? 0) <= 320).toBe(true);
    }

    // Stalled startup must time out within budget and release the verification queue for the next run
    const stalled = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/stalled-startup",
      timeoutMs: 1000,
    });
    expect(stalled).toMatchObject({ kind: "frontendVerified", ok: false, stage: "runtime" });
    const afterStall = await publish(desktop.page, {
      action: "verifyFrontend",
      workspaceId,
      appRoot: "apps/booking",
    });
    expect(afterStall).toMatchObject({ kind: "frontendVerified", ok: true, stage: "complete" });

    // No result leaks workspace host path, loopback URLs, or proof tokens
    const allSerialized = JSON.stringify([
      bookingVerify,
      cliPubVerify,
      controlTowerVerify,
      missingInput,
      syntaxErr,
      cspInline,
      cspForm,
      runtimeCrash,
      badKeys,
      unapprovedOp,
      extVerify,
      disabledClick,
      prefillClick,
      longWaitFor,
      stalled,
      afterStall,
    ]);
    expect(allSerialized).not.toContain(workspace.rootPath);
    expect(allSerialized).not.toContain("127.0.0.1");
    expect(allSerialized).not.toContain("x-dohc-app-proof");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => externalServer.close(() => resolve()));
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
