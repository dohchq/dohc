// @vitest-environment jsdom
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppRuntimeLauncher } from "@dohc/app-backend-runtime";
import { DEFAULT_LIMITS } from "../../../../packages/app-backend-runtime/src/protocol";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { TransactionalCollectionPage } from "../renderer/TransactionalCollectionPage";
import { transactionalDescription } from "../renderer/transactionalCollectionModel";
import { useShellError } from "../renderer/shell/useShellError";
import { WorkspaceErrorToast } from "../renderer/workbench/NoticeCenter";
import { createLocalDatasetHost } from "./localDatasetHost";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const compile = createDatasetFixtureCompiler();
const workerWait = { timeout: 2 * DEFAULT_LIMITS.deadlineMs };
const cleanups: Array<() => Promise<void>> = [];
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Items", schemaPath: "items/schema.sql", operationsPath: "items/operations.ts",
  tables: [{ tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "list", label: "List items", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "add", label: "Add item", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] },
  ],
};
afterEach(async () => {
  cleanup();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  // SQLite and child IPC return Node typed arrays in this renderer integration test.
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer.prototype).constructor);
  const root = await mkdtemp(join(tmpdir(), "dohc-local-reopen-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = { clock: Date.now(), killPrepare: false, killReplay: false, applied: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => state.clock);
  const pids: number[] = [], closedPids: number[] = [];
  const launch = vi.fn<AppRuntimeLauncher>(options => {
    const child = spawn(process.execPath, [options.entryPath], { cwd: options.cwd, env: options.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true });
    pids.push(child.pid!);
    child.on("message", options.onMessage); child.on("error", options.onError);
    child.on("close", code => { closedPids.push(child.pid!); options.onExit(code); });
    return {
      postMessage(message) {
        const request = message as { command?: { kind: string } };
        if ((request.command?.kind === "prepare" && state.killPrepare) || (request.command?.kind === "applyBatch" && state.killReplay)) {
          child.kill("SIGKILL"); return;
        }
        if (request.command?.kind === "applyBatch") state.applied++;
        child.send(message as object, error => { if (error) options.onError(error); });
      },
      kill() { child.kill("SIGKILL"); },
    };
  });
  const host = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024,
    localPersonId: () => "person", compile, runtime: { launch }, persistentRuntime: { launch } });
  cleanups.push(async () => {
    await host.close();
    expect([...closedPids].sort()).toEqual([...pids].sort());
  });
  const files = new Map([
    ["items/dataset.json", JSON.stringify(definition)],
    [definition.schemaPath, "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);"],
    [definition.operationsPath, `globalThis.operations={
      list(ctx) {return {rows:ctx.db.query('SELECT id,name FROM items ORDER BY id').map(row=>({id:row.id,version:1,values:{'${id(3)}':row.id,'${id(4)}':row.name}})),nextCursor:null};},
      add(ctx,input) {ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.name]);return {name:input.name};}
    };`],
  ]);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const selected = [...params.paths as string[]].sort().map(path => {
        const bytes = Buffer.from(files.get(path)!), sha256 = hash(bytes); blobs.set(sha256, bytes);
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files: selected,
        totalBytes: selected.reduce((sum, file) => sum + file.byteLength, 0),
        sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", selected])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  const prepared = await host.prepare({ descriptorPath: "items/dataset.json", adapter });
  const revision = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  const call = (operationId = id(5), idempotencyKey = "read", input = {}) => ({ datasetId: id(1),
    revision: revision.revision, revisionSha256: revision.revisionSha256, operationId, idempotencyKey, input });
  const write = call(id(6), "saved", { name: "Preserved" });
  const receipt = await host.action(write);
  state.killPrepare = true;
  await expect(host.query(call())).rejects.toMatchObject({ code: "worker_stopped" });
  state.killPrepare = false; state.killReplay = true;
  return { host, state, launch, call, write, receipt };
}
it("uses growing supervisor waits after repeated desktop replay worker kills", async () => {
  const f = await fixture();
  for (const delay of [5000, 10000, 20000]) {
    await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "worker_stopped", retryAfterMs: delay });
    const launches = f.launch.mock.calls.length;
    await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "dataset_reopen_wait", retryAfterMs: delay });
    f.state.clock += delay - 1;
    await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "dataset_reopen_wait", retryAfterMs: 1 });
    expect(f.launch).toHaveBeenCalledTimes(launches);
    f.state.clock++;
  }
});
it("shows the desktop reopen wait through the existing shell Try again toast and ends loading", async () => {
  const f = await fixture();
  // Establish the failure without requiring backoff, so this test independently fails on main's visible state.
  await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "worker_stopped" });
  f.state.killReplay = false;
  const launches = f.launch.mock.calls.length;
  const description = transactionalDescription(f.host.describe(id(1)));
  function Page() {
    const { shellErrors, reportShellError, retryShellError } = useShellError("w");
    return <>
      <TransactionalCollectionPage workspaceId="w" dataset={description} tableId={id(2)} onError={reportShellError}
        invoke={async (request, signal) => {
          try { return await f.host.query({ ...request, signal }); }
          catch (error) { throw new Error(`Error invoking remote method 'dohc:dataset': ${String(error)}`); }
        }} />
      {shellErrors.map(error => <WorkspaceErrorToast key={error.id} error={{ ...error, details: error.message, canRetry: error.retry !== null }} onRetry={retryShellError} />)}
    </>;
  }
  render(<Page />);
  const message = "dohc's work on this Collection stopped before it finished. Try again in 5 s.";
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message), workerWait);
  expect(screen.queryByText("Loading records…")).toBeNull();
  expect(f.launch).toHaveBeenCalledTimes(launches);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message), workerWait);
  expect(f.launch).toHaveBeenCalledTimes(launches);
  f.state.clock += 5000;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Preserved", {}, workerWait);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("recovers desktop records and the saved receipt after the reopen wait expires", async () => {
  const f = await fixture();
  await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "worker_stopped" });
  f.state.killReplay = false;
  await expect(f.host.query(f.call())).rejects.toMatchObject({ code: "dataset_reopen_wait", retryAfterMs: 5000 });
  expect(f.state.applied).toBe(0);
  f.state.clock += 5000;
  const recovered = await f.host.query(f.call());
  expect(recovered).toMatchObject({ revision: f.receipt.revision, result: { rows: [
    { id: expect.any(String), version: 1, values: { [id(4)]: "Preserved" } },
  ], nextCursor: null } });
  expect(f.state.applied).toBe(1);
  expect(await f.host.action(f.write)).toEqual({ ...f.receipt, replayed: true });
  expect(await f.host.query(f.call())).toEqual(recovered);
});
