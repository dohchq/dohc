import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
import type { LocalAppExternal } from "./localAppExternal";
import { createHash } from "node:crypto";
import { openedLocalState } from "../testing/preparedLocalState";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import {
  createLocalDatasetHost,
  type LocalDatasetAgent,
  type LocalDatasetHost,
} from "./localDatasetHost";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { createDatasetHandler } from "../ipc/datasetIpc";
import { DatasetResult } from "@dohc/cli/dataset";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./localAppLaunch";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";
import { recordNewCollectionsHolder, type CollectionsHolderCheck } from "./collectionsHolder";
import { writeDatasetRecoveryExport } from "./datasetRecoveryExport";

const compileFixture = createDatasetFixtureCompiler();

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Registrations",
  schemaPath: "data/schema.sql",
  operationsPath: "data/operations.js",
  tables: [
    {
      tableId: id(2),
      name: "Responses",
      sqlName: "responses",
      primaryKey: "id",
      fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        {
          fieldId: id(4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: id(5),
          name: "Receipt",
          sqlColumn: "receipt",
          type: "attachment",
          required: false,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: id(6),
      name: "submit",
      label: "Submit",
      tableId: id(2),
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [id(4), id(5)],
    },
    {
      operationId: id(7),
      name: "list",
      label: "List",
      tableId: id(2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [id(3), id(4), id(5)],
    },
    {
      operationId: id(8),
      name: "fileRead",
      label: "Read receipt",
      tableId: id(2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [id(5)],
    },
  ],
};
const roots: string[] = [],
  hosts: LocalDatasetHost[] = [],
  launchers: LocalAppLaunchHost[] = [];
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sourceAdapter = (files: Map<string, string>) => sourceCaptureAdapter(files);
async function fixture(
  agentRun?: () => LocalDatasetAgent | null,
  holder: CollectionsHolderCheck = unguardedCollections,
  {
    customRead = true,
    schema = "",
    external,
  }: { customRead?: boolean; schema?: string; external?: LocalAppExternal } = {},
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-dataset-app-"));
  roots.push(workspaceRoot);
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  if (holder.required()) await recordNewCollectionsHolder(workspaceRoot, "w", holder.here());
  const host = await createLocalDatasetHost({
    holder,
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot,
    capacityBytes: 1024 * 1024,
    compile: compileFixture,
    ...(agentRun ? { agentRun } : {}),
    ...(external ? { external } : {}),
  });
  hosts.push(host);
  const generated = generateDatasetSources(definition);
  const files = new Map(Object.entries(generated.files));
  if (customRead)
    files.set(
      definition.operationsPath,
      files.get(definition.operationsPath) +
        `\nglobalThis.operations.fileRead=(ctx,input)=>{
    if(input.echo)return {echo:input.fileId};
    if(input.extra)return {fileId:input.fileId,extra:true};
    if(input.guess)return {fileId:input.fileId};
    return {fileId:ctx.db.query('SELECT receipt FROM responses WHERE receipt=?',[input.fileId])[0]?.receipt||null};
  };`,
    );
  files.set(definition.schemaPath, files.get(definition.schemaPath) + schema);
  const adapter = sourceAdapter(files);
  const prepared = await host.prepare({ descriptorPath: "data/dataset.json", adapter });
  const revision = await host.approve({
    preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256,
  });
  async function prepareApp(appRoot: string, operationIds = [id(6)], fieldIds = [id(4), id(5)]) {
    const generated = generateDatasetFormSources({
      datasetPath: "data/dataset.json",
      approvedRevision: revision,
      tableId: id(2),
      createOperationId: id(6),
      appRoot,
      fieldIds,
    });
    for (const [path, source] of Object.entries(generated.files))
      files.set(`${appRoot}/${path}`, source);
    const manifest = JSON.parse(files.get(`${appRoot}/app.publish.json`)!);
    manifest.dataset.operationIds = operationIds;
    if (!operationIds.includes(id(6))) delete manifest.dataset.createFields;
    files.set(`${appRoot}/app.publish.json`, JSON.stringify(manifest));
    return prepareLocalAppPublication(
      { workspaceId: "w", appRoot },
      {
        deferredWrites: [],
        adapter,
        compile: compileClosedApp,
        signal: new AbortController().signal,
        assertCurrent() {},
        async resolveDatasetRevision(binding) {
          return host.approvedArtifacts(binding.datasetId).revision;
        },
      },
    );
  }
  const app = await prepareApp("app");
  const published = await host.apps.activate(app, new AbortController().signal);
  const invocation = (name = "Alex", key = "submit-one") => ({
    authorityRevision: published.authorityRevision,
    operation: "submit",
    idempotencyKey: key,
    input: { values: { [id(4)]: name } },
  });
  return { host, workspaceRoot, revision, files, prepareApp, app, published, invocation };
}

describe("local approved dataset apps", () => {
  it("refuses a running app's next write once another computer keeps the Collections, with nothing else asked first", async () => {
    const f = await fixture(undefined, {
      here: () => ({ installId: "install-here", label: "Studio" }),
      required: () => true,
    });
    expect(
      await f.host.apps.request(f.published.publicationId, "invoke", f.invocation()),
    ).toMatchObject({ replayed: false });
    await writeFile(
      join(f.workspaceRoot, ".dohc", "collections.json"),
      JSON.stringify({
        version: 1,
        workspaceId: "w",
        installId: "install-laptop",
        label: "Laptop",
        storeId: null,
      }),
    );
    await expect(
      f.host.apps.request(f.published.publicationId, "invoke", f.invocation("Blake", "submit-two")),
    ).rejects.toThrow("These Collections are on Laptop.");
    await expect(
      f.host.apps.request(f.published.publicationId, "invoke", f.invocation()),
    ).rejects.toThrow("These Collections are on Laptop.");
  });

  it("still holds a standard operation to its own input limit", async () => {
    const f = await fixture();
    await expect(
      f.host.apps.request(f.published.publicationId, "invoke", {
        ...f.invocation(),
        input: { values: { [id(4)]: "x".repeat(200 * 1024) } },
      }),
    ).rejects.toThrow(/limit of 65536 bytes/);
  });

  it("upgrades the baseline app tables without losing artifacts or charging root rows", async () => {
    const f = await fixture();
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.exec(
      "PRAGMA foreign_keys=ON; DROP TABLE IF EXISTS local_app_roots; DROP TABLE IF EXISTS local_app_approval_provenance",
    );
    expect(db.prepare("PRAGMA table_info(local_dataset_apps)").all()).toHaveLength(7);
    const before = db
      .prepare("SELECT path,hex(content) AS content FROM local_dataset_app_artifacts ORDER BY path")
      .all();
    const budget = db.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes;
    expect(before.length).toBeGreaterThan(0);
    db.close();
    const reopened = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: f.workspaceRoot,
    });
    hosts.push(reopened);
    expect(reopened.apps.browserPublication(f.published.publicationId).files.length).toBe(
      before.length,
    );
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      expect(
        inspection
          .prepare(
            "SELECT path,hex(content) AS content FROM local_dataset_app_artifacts ORDER BY path",
          )
          .all(),
      ).toEqual(before);
      expect(
        inspection
          .prepare(
            "SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root='app'",
          )
          .get(),
      ).toMatchObject({
        revision: f.published.authorityRevision,
        active_kind: "dataset",
        active_publication_id: f.published.publicationId,
      });
      expect(inspection.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes).toBe(
        budget,
      );
    } finally {
      inspection.close();
    }
  });

  it("adopts a baseline-shaped approval below the saved root revision without reviving old sessions", async () => {
    const f = await fixture();
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    const prior = await f.host.apps.activate(f.app, new AbortController().signal);
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    const old = db
      .prepare("SELECT * FROM local_dataset_apps WHERE publication_id=?")
      .get(f.published.publicationId)!;
    try {
      db.prepare("DELETE FROM local_dataset_apps WHERE dataset_id=?").run(id(1));
      db.prepare("INSERT INTO local_dataset_apps VALUES(?,?,?,?,?,?,1)").run(
        old.publication_id,
        old.app_root,
        old.dataset_id,
        1,
        old.candidate,
        old.storage_bytes,
      );
      for (const file of f.app.files)
        db.prepare("INSERT INTO local_dataset_app_artifacts VALUES(?,?,?)").run(
          f.published.publicationId,
          file.path,
          file.bytes,
        );
    } finally {
      db.close();
    }
    const reopened = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: f.workspaceRoot,
    });
    hosts.push(reopened);
    const [adopted] = reopened.apps.list("app");
    expect(adopted.active).toBe(true);
    expect(adopted.authorityRevision).toBeGreaterThan(prior.authorityRevision);
    expect(() =>
      reopened.apps.assertBrowserPublication(
        f.published.publicationId,
        f.published.authorityRevision,
      ),
    ).toThrow(/approval changed/);
    expect(() =>
      reopened.apps.assertBrowserPublication(prior.publicationId, prior.authorityRevision),
    ).toThrow(/approval changed/);
    expect(await reopened.apps.activate(f.app, new AbortController().signal)).toEqual({
      publicationId: adopted.publicationId,
      authorityRevision: adopted.authorityRevision,
    });
    expect(
      await reopened.apps.request(adopted.publicationId, "invoke", {
        ...f.invocation(),
        authorityRevision: adopted.authorityRevision,
      }),
    ).toMatchObject({ replayed: false });
    await reopened.close();
    const again = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: f.workspaceRoot,
    });
    hosts.push(again);
    expect(again.apps.list("app")).toMatchObject([
      { active: true, authorityRevision: adopted.authorityRevision },
    ]);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      expect(
        inspection.prepare("SELECT revision FROM local_app_roots WHERE app_root='app'").get()!
          .revision,
      ).toBe(adopted.authorityRevision);
      expect(
        inspection
          .prepare("SELECT * FROM local_app_approval_provenance WHERE publication_id=?")
          .get(adopted.publicationId),
      ).toBeUndefined();
    } finally {
      inspection.close();
    }
  });

  it("keeps one exact pending form submission across tabs and restart within its app authority", async () => {
    const f = await fixture(),
      invocation = f.invocation();
    const other = await f.host.apps.activate(
      await f.prepareApp("other"),
      new AbortController().signal,
    );
    const envelope = {
      authorityRevision: invocation.authorityRevision,
      operation: invocation.operation,
    };
    const first = (await f.host.apps.request(f.published.publicationId, "attempt", {
      ...envelope,
      action: "save",
      idempotencyKey: invocation.idempotencyKey,
      input: invocation.input,
    })) as { attempt: { token: string; input: unknown } };
    expect(first.attempt.input).toEqual(invocation.input);
    expect(
      await f.host.apps.request(f.published.publicationId, "attempt", {
        ...envelope,
        action: "save",
        idempotencyKey: "second-tab",
        input: { values: { [id(4)]: "Other" } },
      }),
    ).toEqual(first);
    await expect(
      f.host.apps.request(f.published.publicationId, "attempt", {
        ...envelope,
        action: "clear",
        token: "A".repeat(43),
      }),
    ).rejects.toThrow(/Another submission/);
    await expect(
      f.host.apps.activate(await f.prepareApp("replacement"), new AbortController().signal),
    ).rejects.toThrow(/response is pending/);
    expect(
      await f.host.apps.request(other.publicationId, "attempt", {
        authorityRevision: other.authorityRevision,
        operation: "submit",
        action: "get",
      }),
    ).toEqual({ attempt: null });
    await f.host.close();
    const restarted = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: f.workspaceRoot,
    });
    hosts.push(restarted);
    expect(
      await restarted.apps.request(f.published.publicationId, "attempt", {
        ...envelope,
        action: "get",
      }),
    ).toEqual(first);
    expect(
      await restarted.apps.request(f.published.publicationId, "attempt", {
        ...envelope,
        action: "clear",
        token: first.attempt.token,
      }),
    ).toEqual({ attempt: null });
    await expect(
      restarted.apps.request(f.published.publicationId, "attempt", {
        ...envelope,
        operation: "list",
        action: "get",
      }),
    ).rejects.toThrow(/not approved/);
    await restarted.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(
      restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "get" }),
    ).rejects.toThrow(/approval changed/);
  });
  it("refuses an uncommitted submission before fencing local writes and allows transfer after confirmation", async () => {
    const f = await fixture(),
      invocation = f.invocation(),
      envelope = {
        authorityRevision: invocation.authorityRevision,
        operation: invocation.operation,
      };
    await f.host.apps.request(f.published.publicationId, "attempt", {
      ...envelope,
      action: "save",
      idempotencyKey: invocation.idempotencyKey,
      input: invocation.input,
    });
    let imported = false;
    const target = {
      async importRecovery() {
        imported = true;
        throw Error("Target is offline.");
      },
    };
    await expect(
      f.host.transferToShared({ datasetId: id(1), targetOrigin: "https://relay.example", target }),
    ).rejects.toThrow(/submission is unconfirmed/);
    expect(imported).toBe(false);
    expect(f.host.transferStatus(id(1))).toBeNull();
    expect(
      await f.host.apps.request(f.published.publicationId, "invoke", invocation),
    ).toMatchObject({ replayed: false });
    await expect(
      f.host.transferToShared({ datasetId: id(1), targetOrigin: "https://relay.example", target }),
    ).rejects.toThrow("Target is offline.");
    expect(imported).toBe(true);
    expect(f.host.transferStatus(id(1))?.state).toBe("ready");
  });
  it("runs a generated form through real loopback transport into its existing Collection", async () => {
    const f = await fixture(),
      lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({
      backend: f.host.apps,
      lifetime: lifetime.signal,
    });
    launchers.push(launcher);
    const url = new URL(await launcher.launch(f.published.publicationId, lifetime.signal));
    const post = (path: string, body: unknown, proof?: string) =>
      fetch(url.origin + path, {
        method: "POST",
        headers: {
          origin: url.origin,
          "content-type": "application/json",
          ...(proof ? { "x-dohc-app-proof": proof } : {}),
        },
        body: JSON.stringify(body),
      });
    const session = (await (await post("/session", { handoff: url.hash.slice(1) })).json()) as {
      html: string;
      proof: string;
    };
    expect(session.html).not.toMatch(/CREATE TABLE|globalThis.operations|data\/schema/);
    const { authorityRevision: _, ...invoke } = f.invocation();
    const response = await post(
      "/backend",
      { id: "one", op: "backend.invoke", ...invoke },
      session.proof,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { id: expect.any(String) },
      replayed: false,
    });
    const data = await f.host.query({
      datasetId: id(1),
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      operationId: id(7),
      input: {},
      idempotencyKey: "owner-read",
    });
    expect(data.result).toMatchObject({ rows: [{ values: { [id(4)]: "Alex" } }] });
    const forbidden = await post(
      "/backend",
      { id: "two", op: "backend.invoke", operation: "list", input: {}, idempotencyKey: "read" },
      session.proof,
    );
    expect(forbidden.status).toBe(404);
  });

  it("publishes a second app over the same records and requires an approved read result for files", async () => {
    const f = await fixture();
    const uploaded = (await f.host.apps.request(f.published.publicationId, "upload", {
      authorityRevision: f.published.authorityRevision,
      idempotencyKey: "receipt",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-"),
    })) as { file: { fileId: string } };
    const invoke = f.invocation();
    invoke.input.values[id(5)] = uploaded.file.fileId;
    await f.host.apps.request(f.published.publicationId, "invoke", invoke);
    await expect(
      f.host.apps.readBrowserFile(f.published.publicationId, {
        authorityRevision: 1,
        fileId: uploaded.file.fileId,
        operation: "list",
        input: {},
      }),
    ).rejects.toThrow(/approved read/);
    const admin = await f.host.apps.activate(
      await f.prepareApp("admin", [id(7), id(8)]),
      new AbortController().signal,
    );
    await expect(
      f.host.apps.readBrowserFile(admin.publicationId, {
        authorityRevision: admin.authorityRevision,
        fileId: uploaded.file.fileId,
        operation: "list",
        input: {},
      }),
    ).rejects.toThrow(/does not grant/);
    const request = {
      authorityRevision: admin.authorityRevision,
      fileId: uploaded.file.fileId,
      operation: "fileRead",
      input: { fileId: uploaded.file.fileId },
    };
    expect(await f.host.apps.readBrowserFile(admin.publicationId, request)).toMatchObject({
      bytes: Uint8Array.from(Buffer.from("%PDF-")),
    });
    await expect(
      f.host.apps.readBrowserFile(admin.publicationId, {
        ...request,
        input: { ...request.input, echo: true },
      }),
    ).rejects.toThrow(/does not grant/);
    await expect(
      f.host.apps.readBrowserFile(admin.publicationId, {
        ...request,
        input: { ...request.input, extra: true },
      }),
    ).rejects.toThrow(/does not grant/);
    const pending = await f.host.upload({
      datasetId: id(1),
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      idempotencyKey: "owner-pending",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytesBase64: "JVBERi0=",
    });
    await expect(
      f.host.apps.readBrowserFile(admin.publicationId, {
        ...request,
        fileId: pending.file.fileId,
        input: { fileId: pending.file.fileId, guess: true },
      }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      f.host.apps.request(admin.publicationId, "upload", {
        authorityRevision: admin.authorityRevision,
        idempotencyKey: "other",
        name: "receipt.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("%PDF-"),
      }),
    ).rejects.toThrow(/cannot upload/);
    const disclosure = f.host.apps.readBrowserFile(admin.publicationId, request);
    await f.host.apps.withdraw(admin.publicationId, admin.authorityRevision);
    await expect(disclosure).rejects.toThrow();
  });

  it("refuses to approve outside calls where this computer can't make them", async () => {
    const f = await fixture(undefined, unguardedCollections, {
      external: {
        unavailable: () => "Apps in synced workspaces can't call outside services yet.",
        call: vi.fn(),
      },
    });
    const withCalls = structuredClone(f.app);
    withCalls.candidate.external = parseAppExternalDeclaration({
      events: {
        method: "GET",
        url: "https://us.posthog.com/api/events/",
        secret: { name: "POSTHOG_KEY", header: "Authorization" },
      },
    });
    await expect(f.host.apps.activate(withCalls, new AbortController().signal)).rejects.toThrow(
      "synced workspaces",
    );
    expect(f.host.apps.browserPublication(f.published.publicationId).authorityRevision).toBe(
      f.published.authorityRevision,
    );
  });

  it("rejects altered capabilities and bundle bytes before replacing a working app", async () => {
    const f = await fixture();
    const forged = structuredClone(f.app);
    const cap = forged.candidate.capabilities[0];
    if (cap?.kind !== "dataset") throw Error();
    cap.operations[0]!.readOnly = true;
    await expect(f.host.apps.activate(forged, new AbortController().signal)).rejects.toThrow();
    const broken = structuredClone(f.app);
    broken.files[0]!.bytes[0] ^= 1;
    await expect(f.host.apps.activate(broken, new AbortController().signal)).rejects.toThrow(
      /bundle files changed/,
    );
    expect(f.host.apps.browserPublication(f.published.publicationId).authorityRevision).toBe(
      f.published.authorityRevision,
    );
  });

  it("refuses a queued operation when app approval ends before its commit", async () => {
    const f = await fixture();
    const pending = f.host.apps.request(f.published.publicationId, "invoke", f.invocation());
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(pending).rejects.toThrow();
    const rows = await f.host.query({
      datasetId: id(1),
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      operationId: id(7),
      input: {},
      idempotencyKey: "after-revoke",
    });
    expect(rows.result).toMatchObject({ rows: [] });
  });

  it("does not let another app attach a staged upload even when it knows its ID", async () => {
    const f = await fixture();
    const upload = {
      authorityRevision: f.published.authorityRevision,
      idempotencyKey: "same-key",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-"),
    };
    const first = (await f.host.apps.request(f.published.publicationId, "upload", upload)) as {
      file: { fileId: string };
    };
    const other = await f.host.apps.activate(
      await f.prepareApp("other"),
      new AbortController().signal,
    );
    const own = (await f.host.apps.request(other.publicationId, "upload", {
      ...upload,
      authorityRevision: other.authorityRevision,
    })) as { file: { fileId: string } };
    expect(own.file.fileId).not.toBe(first.file.fileId);
    const input = f.invocation();
    input.authorityRevision = other.authorityRevision;
    input.input.values[id(5)] = first.file.fileId;
    await expect(f.host.apps.request(other.publicationId, "invoke", input)).rejects.toThrow();
    const attach = f.invocation("First app", "attach-first");
    attach.input.values[id(5)] = first.file.fileId;
    await f.host.apps.request(f.published.publicationId, "invoke", attach);
    await expect(
      f.host.apps.request(other.publicationId, "invoke", {
        ...input,
        idempotencyKey: "steal-attached",
      }),
    ).rejects.toThrow();
    const native = { datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256 };
    const ownerUpload = await f.host.upload({
      ...native,
      idempotencyKey: "owner-file",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytesBase64: "JVBERi0=",
    });
    await f.host.action({
      ...native,
      operationId: id(6),
      idempotencyKey: "owner-attach",
      input: { values: { [id(4)]: "Owner", [id(5)]: ownerUpload.file.fileId } },
    });
    input.input.values[id(5)] = ownerUpload.file.fileId;
    await expect(
      f.host.apps.request(other.publicationId, "invoke", {
        ...input,
        idempotencyKey: "steal-owner-attached",
      }),
    ).rejects.toThrow();
    expect(
      await f.host.action({
        ...native,
        operationId: id(6),
        idempotencyKey: "owner-reuse-app",
        input: { values: { [id(4)]: "Owner reuse", [id(5)]: first.file.fileId } },
      }),
    ).toMatchObject({ replayed: false });
  });
});

it("keeps local form uploads, submissions and selected fields working through rename and restart", async () => {
  const f = await fixture();
  const restricted = await f.host.apps.activate(
    await f.prepareApp("restricted", [id(6)], [id(4)]),
    new AbortController().signal,
  );
  const admin = await f.host.apps.activate(
    await f.prepareApp("admin", [id(7), id(8)]),
    new AbortController().signal,
  );
  const original = f.host.approvedArtifacts(id(1)),
    renamed = structuredClone(original.revision.definition);
  renamed.tables[0].fields[1].name = "Full name";
  const revision = describeDatasetRevision({
    definition: renamed,
    revision: 2,
    schemaSql: original.schemaSql,
    operationSource: original.operationSource,
  });
  const preview = await f.host.prepareMigrationCandidate({
    workspaceId: "w",
    revision,
    schemaSql: original.schemaSql,
    operationSource: original.operationSource,
    expected: original.cursor,
    migrationSql: "SELECT 1;",
  });
  await f.host.approveMigrationCandidate({
    workspaceId: "w",
    datasetId: id(1),
    candidateId: preview.candidateId,
    checkpointSha256: preview.checkpointSha256,
  });
  expect(f.host.apps.list("app")).toMatchObject([
    { active: true, datasetCapability: { revision: 1 } },
  ]);
  const uploaded = (await f.host.apps.request(f.published.publicationId, "upload", {
    authorityRevision: 1,
    idempotencyKey: "renamed-receipt",
    name: "receipt.pdf",
    contentType: "application/pdf",
    bytes: Buffer.from("%PDF-"),
  })) as { file: { fileId: string } };
  const invoke = f.invocation();
  invoke.input.values[id(5)] = uploaded.file.fileId;
  const first = await f.host.apps.request(f.published.publicationId, "invoke", invoke);
  await f.host.close();
  const restarted = await createLocalDatasetHost({
    holder: unguardedCollections,
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot: f.workspaceRoot,
  });
  hosts.push(restarted);
  expect(restarted.apps.browserPublication(f.published.publicationId)).toBeDefined();
  expect(await restarted.apps.request(f.published.publicationId, "invoke", invoke)).toEqual({
    ...(first as object),
    replayed: true,
  });
  await expect(
    restarted.apps.request(restricted.publicationId, "invoke", {
      ...invoke,
      authorityRevision: restricted.authorityRevision,
    }),
  ).rejects.toThrow("cannot submit those fields");
  expect(
    await restarted.apps.readBrowserFile(admin.publicationId, {
      authorityRevision: admin.authorityRevision,
      fileId: uploaded.file.fileId,
      operation: "fileRead",
      input: { fileId: uploaded.file.fileId },
    }),
  ).toMatchObject({ bytes: Uint8Array.from(Buffer.from("%PDF-")) });
  expect(
    await restarted.apps.request(
      f.published.publicationId,
      "invoke",
      f.invocation("Next", "after-restart"),
    ),
  ).toMatchObject({ replayed: false });
  await restarted.apps.withdraw(f.published.publicationId, 1);
  await expect(restarted.apps.request(f.published.publicationId, "invoke", invoke)).rejects.toThrow(
    "approval changed",
  );
});

it("runs a multi-Collection local app with alias routing, cross-Collection file isolation, archive deactivation, and delete cleanup", async () => {
  const f = await fixture();
  const secondDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(101),
    name: "Workouts",
    schemaPath: "workouts/schema.sql",
    operationsPath: "workouts/operations.js",
    tables: [
      {
        tableId: id(102),
        name: "Sessions",
        sqlName: "sessions",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(103),
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: id(104),
            name: "Activity",
            sqlColumn: "activity",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: id(105),
            name: "Proof",
            sqlColumn: "proof",
            type: "attachment",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(106),
        name: "submit",
        label: "Log workout",
        tableId: id(102),
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [id(104), id(105)],
      },
      {
        operationId: id(107),
        name: "list",
        label: "List workouts",
        tableId: id(102),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(103), id(104), id(105)],
      },
      {
        operationId: id(108),
        name: "fileRead",
        label: "Read proof",
        tableId: id(102),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(105)],
      },
    ],
  };
  const secondGen = generateDatasetSources(secondDef);
  for (const [path, content] of Object.entries(secondGen.files)) f.files.set(path, content);
  f.files.set(
    secondDef.operationsPath,
    f.files.get(secondDef.operationsPath) +
      `\nglobalThis.operations.fileRead=(ctx,input)=>({fileId:input.fileId});`,
  );
  const adapter = sourceAdapter(f.files);
  const secondPrepared = await f.host.prepare({
    descriptorPath: "workouts/dataset.json",
    adapter,
  });
  await f.host.approve({
    preparationId: secondPrepared.preparationId,
    revisionSha256: secondPrepared.revision.revisionSha256,
  });

  f.files.set("tower/main.tsx", "export default function App() { return null; }");
  f.files.set(
    "tower/app.publish.json",
    JSON.stringify({
      version: 1,
      entryPath: "main.tsx",
      datasets: {
        expenses: {
          kind: "dataset",
          datasetPath: "data/dataset.json",
          operations: ["submit", "list", "fileRead"],
        },
        workouts: {
          kind: "dataset",
          datasetPath: "workouts/dataset.json",
          operations: ["submit", "list", "fileRead"],
        },
      },
    }),
  );
  const multiPrepared = await prepareLocalAppPublication(
    { workspaceId: "w", appRoot: "tower" },
    {
      deferredWrites: [],
      adapter,
      compile: compileClosedApp,
      signal: new AbortController().signal,
      assertCurrent() {},
      async resolveDatasetRevision(binding) {
        return f.host.approvedArtifacts(binding.datasetId).revision;
      },
    },
  );
  const activated = await f.host.apps.activate(multiPrepared, new AbortController().signal);
  expect(f.host.apps.list("tower")).toMatchObject([
    {
      publicationId: activated.publicationId,
      active: true,
      approved: true,
      datasetCapabilities: [
        { alias: "expenses", datasetId: id(1) },
        { alias: "workouts", datasetId: id(101) },
      ],
    },
  ]);

  await expect(
    f.host.apps.request(activated.publicationId, "invoke", {
      authorityRevision: activated.authorityRevision,
      operation: "list",
      idempotencyKey: "no-alias",
      input: {},
    }),
  ).rejects.toThrow(/Choose which Collection/);
  await expect(
    f.host.apps.request(activated.publicationId, "invoke", {
      authorityRevision: activated.authorityRevision,
      dataset: "unknown",
      operation: "list",
      idempotencyKey: "bad-alias",
      input: {},
    }),
  ).rejects.toThrow(/not approved/);

  const uploaded = (await f.host.apps.request(activated.publicationId, "upload", {
    authorityRevision: activated.authorityRevision,
    dataset: "expenses",
    idempotencyKey: "exp-receipt",
    name: "receipt.pdf",
    contentType: "application/pdf",
    bytes: Buffer.from("%PDF-"),
  })) as { file: { fileId: string } };
  await f.host.apps.request(activated.publicationId, "invoke", {
    authorityRevision: activated.authorityRevision,
    dataset: "expenses",
    operation: "submit",
    idempotencyKey: "exp-1",
    input: { values: { [id(4)]: "Coffee", [id(5)]: uploaded.file.fileId } },
  });
  await f.host.apps.request(activated.publicationId, "invoke", {
    authorityRevision: activated.authorityRevision,
    dataset: "workouts",
    operation: "submit",
    idempotencyKey: "wrk-1",
    input: { values: { [id(104)]: "Run 5k" } },
  });

  expect(
    await f.host.apps.readBrowserFile(activated.publicationId, {
      authorityRevision: activated.authorityRevision,
      dataset: "expenses",
      fileId: uploaded.file.fileId,
      operation: "fileRead",
      input: { fileId: uploaded.file.fileId },
    }),
  ).toMatchObject({ bytes: Uint8Array.from(Buffer.from("%PDF-")) });

  await expect(
    f.host.apps.readBrowserFile(activated.publicationId, {
      authorityRevision: activated.authorityRevision,
      dataset: "workouts",
      fileId: uploaded.file.fileId,
      operation: "fileRead",
      input: { fileId: uploaded.file.fileId },
    }),
  ).rejects.toThrow();

  await f.host.archive({ datasetId: id(101) });
  await expect(
    f.host.apps.request(activated.publicationId, "invoke", {
      authorityRevision: activated.authorityRevision,
      dataset: "expenses",
      operation: "list",
      idempotencyKey: "after-archive",
      input: {},
    }),
  ).rejects.toThrow();

  const preview = await f.host.deletePreview({ datasetId: id(101) });
  await f.host.deleteDataset({
    datasetId: id(101),
    expected: preview.cursor,
    reviewToken: preview.reviewToken,
    acknowledge: true,
  });
  expect(f.host.apps.list("tower")).toEqual([]);
  const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
  try {
    expect(
      db
        .prepare("SELECT 1 FROM dohc_dataset_bindings WHERE dataset_id=? AND app_id=?")
        .get(id(1), activated.publicationId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT bytes FROM local_collection_app_usage WHERE singleton=1").get()!.bytes,
    ).toBe(0);
  } finally {
    db.close();
  }
});

it("reclaims a withdrawn multi-Collection app on Collection deletion and allows approving a replacement at the same root", async () => {
  const f = await fixture();
  const secondDefinition: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(201),
    name: "Workouts",
    schemaPath: "workouts/schema.sql",
    operationsPath: "workouts/operations.js",
    tables: [
      {
        tableId: id(202),
        name: "Workouts",
        sqlName: "workouts",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(203),
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: id(204),
            name: "Title",
            sqlColumn: "title",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(205),
        name: "list",
        label: "List",
        tableId: id(202),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(203), id(204)],
      },
    ],
  };
  const secondSchema = "CREATE TABLE workouts(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL);";
  const secondSource = `globalThis.operations={list(ctx){return ctx.db.query("SELECT * FROM workouts");}};`;
  f.files.set("workouts/dataset.json", JSON.stringify(secondDefinition));
  f.files.set("workouts/schema.sql", secondSchema);
  f.files.set("workouts/operations.js", secondSource);
  const adapter = sourceCaptureAdapter(f.files);
  const preparedSecond = await f.host.prepare({
    descriptorPath: "workouts/dataset.json",
    adapter,
  });
  await f.host.approve({
    preparationId: preparedSecond.preparationId,
    revisionSha256: preparedSecond.revision.revisionSha256,
  });

  f.files.set("tower-withdrawn/main.js", "console.log('tower-withdrawn')");
  f.files.set(
    "tower-withdrawn/app.publish.json",
    JSON.stringify({
      version: 1,
      entryPath: "main.js",
      inputs: ["main.js"],
      datasets: {
        expenses: {
          kind: "dataset",
          datasetPath: "data/dataset.json",
          operations: ["list"],
        },
        workouts: {
          kind: "dataset",
          datasetPath: "workouts/dataset.json",
          operations: ["list"],
        },
      },
    }),
  );
  const preparedMulti = await prepareLocalAppPublication(
    { workspaceId: "w", appRoot: "tower-withdrawn" },
    {
      deferredWrites: [],
      adapter,
      assertCurrent() {},
      resolveDatasetRevision: async (binding) =>
        f.host.approvedArtifacts(binding.datasetId).revision,
      compile: compileClosedApp,
      signal: new AbortController().signal,
    },
  );
  const activated = await f.host.apps.activate(preparedMulti, new AbortController().signal);
  await f.host.apps.withdraw(activated.publicationId, activated.authorityRevision);
  expect(f.host.apps.list("tower-withdrawn")).toMatchObject([
    { publicationId: activated.publicationId, active: false },
  ]);

  await f.host.archive({ datasetId: id(201) });
  const preview = await f.host.deletePreview({ datasetId: id(201) });
  await f.host.deleteDataset({
    datasetId: id(201),
    expected: preview.cursor,
    reviewToken: preview.reviewToken,
    acknowledge: true,
  });
  expect(f.host.apps.list("tower-withdrawn")).toEqual([]);
  const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
  try {
    expect(
      db.prepare("SELECT bytes FROM local_collection_app_usage WHERE singleton=1").get()!.bytes,
    ).toBe(0);
  } finally {
    db.close();
  }

  const replacement = await f.prepareApp("tower-withdrawn");
  const replaced = await f.host.apps.activate(replacement, new AbortController().signal);
  expect(replaced.authorityRevision).toBeGreaterThan(activated.authorityRevision);
  expect(f.host.apps.list("tower-withdrawn")).toMatchObject([
    { publicationId: replaced.publicationId, active: true },
  ]);
});

describe("local app write attribution", () => {
  const watcher = "collection:registrations#tally";
  async function attributed() {
    let run: LocalDatasetAgent | null = null;
    const f = await fixture(() => run);
    f.host.automations.subscribe(id(1), {
      automationId: watcher,
      tableId: id(2),
      kinds: ["added"],
      fieldIds: null,
      definitionHash: hash(watcher),
    });
    const invoke = (key: string, activated?: boolean) =>
      f.host.apps.request(
        f.published.publicationId,
        "invoke",
        f.invocation(key, key),
        undefined,
        activated,
      );
    return {
      ...f,
      invoke,
      setRun(value: LocalDatasetAgent | null) {
        run = value;
      },
    };
  }

  it("grants an app nothing through a run and takes no actor or depth from its request", async () => {
    const f = await attributed();
    f.setRun({ depth: 1 });
    await expect(
      f.host.apps.request(f.published.publicationId, "invoke", {
        ...f.invocation("x", "listed"),
        operation: "list",
      }),
    ).rejects.toThrow(/not approved/);
    for (const forged of [
      { agent: { depth: 0 } },
      { depth: 0 },
      { actor: { kind: "owner" } },
      { activated: true },
    ]) {
      await expect(
        f.host.apps.request(f.published.publicationId, "invoke", {
          ...f.invocation("x", "forged"),
          ...forged,
        }),
      ).rejects.toThrow(/Unexpected app backend fields/);
    }
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(f.invoke("revoked")).rejects.toThrow(/approval changed/);
    expect(f.host.automations.next()).toBeNull();
    expect(f.host.history({ datasetId: id(1) }).entries).toEqual([]);
  });

  it("surfaces bound local forms in migration previews and re-approves unpinned forms without editing app.publish.json", async () => {
    const f = await fixture();
    const formManifest = JSON.parse(f.files.get("app/app.publish.json")!);
    expect(formManifest.dataset.revision).toBeUndefined();
    expect(formManifest.dataset.revisionSha256).toBeUndefined();
    expect(f.host.apps.heldDatasetApp(f.published.publicationId)?.publicationId).toBe(
      f.published.publicationId,
    );

    const abort = new AbortController();
    const adapter = sourceAdapter(f.files);
    const handler = createDatasetHandler({
      flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }),
      withWorkspaceOperation: async (_caller: string, _workspaceId, work) =>
        work({
          workspace: { workspaceId: "w", rootPath: f.workspaceRoot },
          signal: abort.signal,
          assertCurrent() {},
        }),
      hostForWorkspace: async () => f.host,
      withAdapter: async (_ws, work) => work(adapter),
      createSources: async (_ws, nextFiles) => {
        for (const [path, content] of Object.entries(nextFiles)) f.files.set(path, content);
      },
    });

    const beforePerms = DatasetResult.parse(
      await handler("window", {
        workspaceId: "w",
        action: "permissions",
        datasetPath: "data/dataset.json",
      }),
    );
    expect(beforePerms).toMatchObject({
      kind: "permissions",
      boundApps: [
        {
          scope: "local",
          publicationId: f.published.publicationId,
          appRoot: "app",
          status: "compatible",
        },
      ],
    });

    const prepared = DatasetResult.parse(
      await handler("window", {
        workspaceId: "w",
        action: "prepareSchemaChange",
        datasetPath: "data/dataset.json",
        revision: f.revision.revision,
        revisionSha256: f.revision.revisionSha256,
        change: {
          kind: "addField",
          tableId: id(2),
          field: {
            name: "Notes",
            type: "text",
            required: false,
            unique: false,
          },
        },
      }),
    );
    expect(prepared).toMatchObject({
      kind: "migration-prepared",
      boundApps: [
        {
          scope: "local",
          publicationId: f.published.publicationId,
          appRoot: "app",
          status: "needs-refresh",
        },
      ],
    });
    if (prepared.kind !== "migration-prepared") throw new Error("Expected migration-prepared");

    const migrated = DatasetResult.parse(
      await handler("window", {
        workspaceId: "w",
        action: "approveMigration",
        preparationId: prepared.preparationId,
        revisionSha256: prepared.revision.revisionSha256,
        approvalDigest: prepared.approvalDigest,
      }),
    );
    expect(migrated.kind).toBe("migrated");

    const stalePerms = DatasetResult.parse(
      await handler("window", {
        workspaceId: "w",
        action: "permissions",
        datasetPath: "data/dataset.json",
      }),
    );
    expect(stalePerms).toMatchObject({
      kind: "permissions",
      boundApps: [
        {
          scope: "local",
          publicationId: f.published.publicationId,
          appRoot: "app",
          status: "needs-refresh",
        },
      ],
    });

    const rePrepared = await prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "app" },
      {
        deferredWrites: [],
        adapter,
        compile: compileClosedApp,
        signal: abort.signal,
        assertCurrent() {},
        async resolveDatasetRevision(binding) {
          return f.host.approvedArtifacts(binding.datasetId).revision;
        },
      },
    );
    const refreshed = await f.host.apps.activate(rePrepared, abort.signal);
    const afterPerms = DatasetResult.parse(
      await handler("window", {
        workspaceId: "w",
        action: "permissions",
        datasetPath: "data/dataset.json",
      }),
    );
    expect(afterPerms).toMatchObject({
      kind: "permissions",
      boundApps: [
        {
          scope: "local",
          publicationId: refreshed.publicationId,
          appRoot: "app",
          pinnedRevision: 2,
          status: "compatible",
        },
      ],
    });
  });

  it("wakes parked /events on external writes, enforces readOnly on query reads, and aborts cleanly on withdrawal", async () => {
    const f = await fixture();
    const readWriteApp = await f.prepareApp("app-live", [id(6), id(7)]);
    const published = await f.host.apps.activate(readWriteApp, new AbortController().signal);
    const lifetime = new AbortController();
    let subscribedCount = 0;
    const watchedBackend = {
      ...f.host.apps,
      subscribeDatasetChanges(pubId: string, rev: number, onWake: () => void) {
        subscribedCount++;
        const unsub = f.host.apps.subscribeDatasetChanges!(pubId, rev, onWake);
        return () => {
          subscribedCount--;
          unsub();
        };
      },
    };
    const launcher = await createLocalAppLaunchHost({
      backend: watchedBackend,
      lifetime: lifetime.signal,
    });
    launchers.push(launcher);
    const session = await launcher.launchSession(published.publicationId, lifetime.signal, {
      keepAlive: true,
    });
    const origin = new URL(session.url).origin,
      handoff = new URL(session.url).hash.slice(1);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(origin + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const opened = (await (await post("/session", { handoff })).json()) as { proof: string };
    const headers = { "x-dohc-app-proof": opened.proof };

    const refusedWrite = await post(
      "/backend",
      {
        id: "ro-write",
        op: "backend.invoke",
        operation: "submit",
        idempotencyKey: "read-submit-1",
        input: { values: { [id(4)]: "ShouldNotWrite" } },
        readOnly: true,
      },
      headers,
    );
    expect(refusedWrite.status).toBe(404);
    const beforeRows = (await (
      await post(
        "/backend",
        {
          id: "ro-list-1",
          op: "backend.invoke",
          operation: "list",
          idempotencyKey: "read-list-1",
          input: {},
          readOnly: true,
        },
        headers,
      )
    ).json()) as { result: { rows: unknown[] }; revision: number };
    expect(beforeRows.revision).toBe(0);
    expect(beforeRows.result.rows).toHaveLength(0);

    const parked = post("/events", { since: { "": 0 }, holdMs: 10_000 }, headers);
    await expect.poll(() => subscribedCount).toBe(1);
    await f.host.invoke({
      datasetId: f.revision.datasetId,
      revision: f.revision.revision,
      revisionSha256: f.revision.revisionSha256,
      operationId: id(6),
      idempotencyKey: "external-cli-write-1",
      input: { values: { [id(4)]: "FromCLI" } },
    });
    const woken = await parked;
    expect(woken.status).toBe(200);
    const eventPayload = (await woken.json()) as {
      changed: Array<{ dataset: string; revision: number }>;
    };
    expect(eventPayload).toEqual({
      changed: [{ dataset: "", revision: 1 }],
    });
    expect(JSON.stringify(eventPayload)).not.toContain(f.revision.datasetId);

    const afterRows = (await (
      await post(
        "/backend",
        {
          id: "ro-list-2",
          op: "backend.invoke",
          operation: "list",
          idempotencyKey: "read-list-2",
          input: {},
          readOnly: true,
        },
        headers,
      )
    ).json()) as { result: { rows: Array<Record<string, unknown>> }; revision: number };
    expect(afterRows.revision).toBe(1);
    expect(afterRows.result.rows).toHaveLength(1);

    const parkedBeforeWithdraw = post("/events", { since: { "": 1 }, holdMs: 10_000 }, headers);
    await expect.poll(() => subscribedCount).toBe(1);
    await f.host.apps.withdraw(published.publicationId, published.authorityRevision);
    const withdrawnRes = await parkedBeforeWithdraw;
    expect(withdrawnRes.status).toBe(404);
    expect(session.ended.aborted).toBe(true);
    expect(session.ended.reason).toBe("needs-approval");
    expect(subscribedCount).toBe(0);
  });

  it("transfers a 15 MiB PDF over raw binary HTTP, round-trips recovery export/import, and refuses >20 MiB with limit details", async () => {
    const f = await fixture();
    const app = await f.prepareApp("app-binary", [id(6), id(7), id(8)]);
    const published = await f.host.apps.activate(app, new AbortController().signal);
    const lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({
      backend: f.host.apps,
      lifetime: lifetime.signal,
    });
    launchers.push(launcher);
    const session = await launcher.launchSession(published.publicationId, lifetime.signal, {
      keepAlive: true,
    });
    const origin = new URL(session.url).origin,
      handoff = new URL(session.url).hash.slice(1);
    const opened = (await (
      await fetch(origin + "/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ handoff }),
      })
    ).json()) as { proof: string };
    const authHeaders = { origin, "x-dohc-app-proof": opened.proof };

    const pdfBytes = Buffer.alloc(15 * 1024 * 1024, 0x41);
    pdfBytes.write("%PDF-1.7\n", 0, "ascii");
    const expectedSha = hash(pdfBytes);

    const uploadRes = await fetch(origin + "/backend", {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/octet-stream",
        "x-dohc-app-meta": encodeURIComponent(
          JSON.stringify({
            id: "up-15m",
            op: "backend.upload",
            idempotencyKey: "pdf-15m",
            name: "statement.pdf",
            contentType: "application/pdf",
          }),
        ),
      },
      body: pdfBytes,
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as {
      file: { fileId: string; byteLength: number; sha256: string };
      replayed: boolean;
    };
    expect(uploaded.replayed).toBe(false);
    expect(uploaded.file.byteLength).toBe(pdfBytes.byteLength);
    expect(uploaded.file.sha256).toBe(expectedSha);

    const attachRes = await fetch(origin + "/backend", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        id: "attach-15m",
        op: "backend.invoke",
        operation: "submit",
        idempotencyKey: "attach-15m",
        input: { values: { [id(4)]: "Annual statement", [id(5)]: uploaded.file.fileId } },
      }),
    });
    expect(attachRes.status).toBe(200);

    const downloadRes = await fetch(origin + "/file", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        id: "dl-15m",
        op: "backend.file",
        fileId: uploaded.file.fileId,
        operation: "fileRead",
        input: { fileId: uploaded.file.fileId },
      }),
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/octet-stream");
    const downloadedMeta = JSON.parse(
      decodeURIComponent(downloadRes.headers.get("x-dohc-app-file")!),
    ) as { fileId: string; byteLength: number; sha256: string };
    expect(downloadedMeta).toMatchObject({
      fileId: uploaded.file.fileId,
      byteLength: pdfBytes.byteLength,
      sha256: expectedSha,
    });
    const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(pdfBytes.byteLength);
    expect(hash(downloadedBytes)).toBe(expectedSha);

    const oversizeBytes = Buffer.alloc(20 * 1024 * 1024 + 1, 0x42);
    oversizeBytes.write("%PDF-1.7\n", 0, "ascii");
    const oversizeRes = await fetch(origin + "/backend", {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/octet-stream",
        "x-dohc-app-meta": encodeURIComponent(
          JSON.stringify({
            id: "up-over",
            op: "backend.upload",
            idempotencyKey: "pdf-over",
            name: "too-big.pdf",
            contentType: "application/pdf",
          }),
        ),
      },
      body: oversizeBytes,
    });
    expect(oversizeRes.status).toBe(413);
    expect(await oversizeRes.json()).toEqual({
      error: expect.stringMatching(/20971520 bytes.*bytes/),
    });

    const archive = await f.host.prepareExport(id(1));
    const backupPath = join(f.workspaceRoot, "large-pdf.dohc-recovery");
    await writeDatasetRecoveryExport({
      workspaceRoots: [],
      path: backupPath,
      stream: archive.stream(),
      signal: new AbortController().signal,
      maxBytes: archive.maxBytes,
      authorize() {},
    });
    await archive.dispose();

    const restoredRoot = await mkdtemp(join(tmpdir(), "dohc-local-apps-restored-"));
    roots.push(restoredRoot);
    await openedLocalState({ workspaceId: "w", rootPath: restoredRoot });
    const restoredHost = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot: restoredRoot,
    });
    hosts.push(restoredHost);
    const preparedRecovery = await restoredHost.prepareRecovery({ sourcePath: backupPath });
    await restoredHost.claimRecovery({ ...preparedRecovery, oldHostStopped: true });
    const restoredFile = await restoredHost.file({
      datasetId: id(1),
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      fileId: uploaded.file.fileId,
    });
    expect(restoredFile.file.byteLength).toBe(pdfBytes.byteLength);
    expect(restoredFile.file.sha256).toBe(expectedSha);
    expect(hash(Buffer.from(restoredFile.bytesBase64, "base64"))).toBe(expectedSha);
  });
});
