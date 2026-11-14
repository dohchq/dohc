// @vitest-environment jsdom
import { spawn } from "node:child_process";
import { openedLocalState } from "../testing/preparedLocalState";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppRuntimeLauncher } from "@dohc/app-backend-runtime";
import { DEFAULT_LIMITS } from "../../../../packages/app-backend-runtime/src/protocol";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { TransactionalCollectionPage } from "../renderer/TransactionalCollectionPage";
import { transactionalDescription } from "../renderer/transactionalCollectionModel";
import { useShellError } from "../renderer/shell/useShellError";
import { WorkspaceErrorToast } from "../renderer/workbench/NoticeCenter";
import { ipcWireError } from "../ipc/errorWords";
import { createLocalDatasetHost } from "./localDatasetHost";
import { unguardedCollections } from "../testing/collectionsHolder";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const compile = createDatasetFixtureCompiler();
const workerWait = { timeout: 2 * DEFAULT_LIMITS.deadlineMs };
const cleanups: Array<() => Promise<void>> = [];
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Items",
  schemaPath: "items/schema.sql",
  operationsPath: "items/operations.ts",
  tables: [
    {
      tableId: id(2),
      name: "Items",
      sqlName: "items",
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
      ],
    },
  ],
  operations: [
    {
      operationId: id(5),
      name: "list",
      label: "List items",
      tableId: id(2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [id(3), id(4)],
    },
    {
      operationId: id(6),
      name: "add",
      label: "Add item",
      tableId: id(2),
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [id(4)],
    },
  ],
};
// The table's virtualizer reads offsetWidth and offsetHeight, which jsdom reports as 0, so every element
// gets a nonzero box and the page's rows render.
const offsetDescriptors = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
});
afterEach(async () => {
  cleanup();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of Object.entries(offsetDescriptors))
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
});
async function fixture() {
  // SQLite and child IPC return Node typed arrays in this renderer integration test.
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer.prototype).constructor);
  const root = await mkdtemp(join(tmpdir(), "dohc-local-reopen-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = { clock: Date.now(), killPrepare: false, killReplay: false, applied: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => state.clock);
  const pids: number[] = [],
    closedPids: number[] = [];
  const launch = vi.fn<AppRuntimeLauncher>((options) => {
    const child = spawn(process.execPath, [options.entryPath], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });
    pids.push(child.pid!);
    child.on("message", options.onMessage);
    child.on("error", options.onError);
    child.on("close", (code) => {
      closedPids.push(child.pid!);
      options.onExit(code);
    });
    return {
      postMessage(message) {
        const request = message as { command?: { kind: string } };
        if (
          (request.command?.kind === "prepare" && state.killPrepare) ||
          (request.command?.kind === "applyBatch" && state.killReplay)
        ) {
          child.kill("SIGKILL");
          return;
        }
        if (request.command?.kind === "applyBatch") {
          state.applied++;
        }
        child.send(message as object, (error) => {
          if (error) options.onError(error);
        });
      },
      kill() {
        child.kill("SIGKILL");
      },
    };
  });
  cleanups.push(async () => {
    expect([...closedPids].sort()).toEqual([...pids].sort());
  });
  async function openHost() {
    // Workers and exports live in .dohc/local, which an engine open prepares.
    await openedLocalState({ workspaceId: "w", rootPath: root });
    const host = await createLocalDatasetHost({
      holder: unguardedCollections,
      workspaceId: "w",
      workspaceRoot: root,
      capacityBytes: 1024 * 1024,
      localPersonId: () => "person",
      compile,
      runtime: { launch },
      persistentRuntime: { launch },
    });
    cleanups.push(() => host.close());
    return host;
  }
  const host = await openHost();
  const files = new Map([
    ["items/dataset.json", JSON.stringify(definition)],
    [definition.schemaPath, "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);"],
    [
      definition.operationsPath,
      `globalThis.operations={
      list(ctx) {return {rows:ctx.db.query('SELECT id,name FROM items ORDER BY id').map(row=>({id:row.id,version:1,values:{'${id(3)}':row.id,'${id(4)}':row.name}})),nextCursor:null};},
      add(ctx,input) {ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.name]);return {name:input.name};}
    };`,
    ],
  ]);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter(
    {
      close() {},
      async sendRequest(request) {
        const params = request.params as Record<string, unknown>;
        if (request.method === "versionedText.captureSources") {
          const selected = [...(params.paths as string[])].sort().map((path) => {
            const bytes = Buffer.from(files.get(path)!),
              sha256 = hash(bytes);
            blobs.set(sha256, bytes);
            return {
              path,
              objectId: path,
              contentKind: "text",
              sha256,
              byteLength: bytes.byteLength,
              latestMomentId: "m",
            };
          });
          return {
            id: request.id,
            result: {
              workspaceId: "w",
              versionId: "main",
              files: selected,
              totalBytes: selected.reduce((sum, file) => sum + file.byteLength, 0),
              sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", selected])),
            },
          };
        }
        const bytes = blobs.get(String(params.sha256))!;
        return {
          id: request.id,
          result: {
            bytesBase64: Buffer.from(bytes).toString("base64"),
            byteLength: bytes.byteLength,
          },
        };
      },
    },
    "owner",
    { workspaceId: "w" },
  );
  const prepared = await host.prepare({ descriptorPath: "items/dataset.json", adapter });
  const revision = await host.approve({
    preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256,
  });
  const call = (operationId = id(5), idempotencyKey = "read", input = {}) => ({
    datasetId: id(1),
    revision: revision.revision,
    revisionSha256: revision.revisionSha256,
    operationId,
    idempotencyKey,
    input,
  });
  const write = call(id(6), "saved", { name: "Preserved" });
  const receipt = await host.action(write);
  state.killPrepare = true;
  await expect(host.query(call())).rejects.toMatchObject({ code: "worker_stopped" });
  state.killPrepare = false;
  state.killReplay = true;
  return { host, state, launch, call, write, receipt };
}
function ShellPage({ f }: { f: Awaited<ReturnType<typeof fixture>> }) {
  const description = transactionalDescription(f.host.describe(id(1)));
  const { shellErrors, reportShellError, retryShellError, clearIdentity } = useShellError("w");
  return (
    <>
      <TransactionalCollectionPage
        workspaceId="w"
        dataset={description}
        tableId={id(2)}
        onSettled={clearIdentity}
        onError={(fallback, error, retry, identity) =>
          reportShellError(fallback, error, retry, undefined, identity)
        }
        invoke={async (request, signal) => {
          try {
            return await f.host.query({ ...request, signal });
          } catch (error) {
            throw new Error(
              `Error invoking remote method 'dohc:dataset': ${String(ipcWireError(error))}`,
            );
          }
        }}
      />
      {shellErrors.map((error) => (
        <WorkspaceErrorToast
          key={error.id}
          error={{ ...error, copy: { report: error.message }, canRetry: error.retry !== null }}
          onRetry={retryShellError}
        />
      ))}
      <ul aria-label="Notices">
        {shellErrors.map((error) => (
          <li key={error.id}>{error.message}</li>
        ))}
      </ul>
    </>
  );
}
const toastRetry = () =>
  within(screen.getByRole("alert")).getByRole("button", { name: "Try again" });
const pageRetry = () =>
  within(screen.getByRole("region", { name: "Items" })).getByRole("button", { name: "Try again" });
const noticeRows = () =>
  within(screen.getByRole("list", { name: "Notices" }))
    .queryAllByRole("listitem")
    .map((row) => row.textContent);
it("keeps one current Notices row and the wait in the page until the records load", async () => {
  const f = await fixture();
  await expect(f.host.query(f.call())).rejects.toMatchObject({
    code: "worker_stopped",
    retryAfterMs: 5000,
  });
  render(<ShellPage f={f} />);
  const page = screen.getByRole("region", { name: "Items" });
  const wait = (seconds: number) =>
    `This Collection is waiting to reopen. Try again in ${seconds} seconds.`;
  await within(page).findByText(wait(5), {}, workerWait);
  expect(noticeRows()).toEqual([`dohc could not load Items. ${wait(5)}`]);
  f.state.clock += 5000;
  fireEvent.click(pageRetry());
  await waitFor(
    () =>
      expect(noticeRows()).toEqual([
        "dohc could not load Items. It stopped before it finished. Try again.",
      ]),
    workerWait,
  );
  expect(within(page).queryByText(wait(5))).toBeNull();
  expect(within(page).getByText("dohc could not load Items.")).toBeTruthy();
  expect(pageRetry()).toBeTruthy();
  fireEvent.click(toastRetry());
  await within(page).findByText(wait(10), {}, workerWait);
  expect(noticeRows()).toEqual([`dohc could not load Items. ${wait(10)}`]);
  f.state.killReplay = false;
  f.state.clock += 10_000;
  fireEvent.click(pageRetry());
  expect(within(page).getByText("Loading records…")).toBeTruthy();
  await within(page).findByText("Preserved", {}, workerWait);
  expect(within(page).queryByText(wait(10))).toBeNull();
  expect(noticeRows()).toEqual([]);
});
it("recovers desktop records and the saved receipt after the reopen wait expires", async () => {
  const f = await fixture();
  await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "worker_stopped" });
  f.state.killReplay = false;
  await expect(f.host.query(f.call())).rejects.toMatchObject({
    code: "dataset_reopen_wait",
    retryAfterMs: 5000,
  });
  expect(f.state.applied).toBe(0);
  f.state.clock += 5000;
  const recovered = await f.host.query(f.call());
  expect(recovered).toMatchObject({
    revision: f.receipt.revision,
    result: {
      rows: [{ id: expect.any(String), version: 1, values: { [id(4)]: "Preserved" } }],
      nextCursor: null,
    },
  });
  expect(f.state.applied).toBe(1);
  expect(await f.host.action(f.write)).toEqual({ ...f.receipt, replayed: true });
  expect(await f.host.query(f.call())).toEqual(recovered);
});
