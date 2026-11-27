import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveFetchHandler, type DeclaredHttpsTransport } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { compileDatasetOperations } from "../../../../services/sync-relay/src/datasetCompiler";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { createServerHomeData, signedOutServer } from "./collectionsHome";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import { createRemoteDatasetData, type OwnerDatasetData } from "./remoteDataset";
import { createRemoteDatasetReplicaSource } from "./remoteDatasetReplica";

// A sync relay with a real dataset host on 127.0.0.1, and the owner's
// computers that reach it through the desktop's own Collection code.

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Entries",
  schemaPath: "schema.sql",
  operationsPath: "actions.js",
  tables: [
    {
      tableId: id(2),
      name: "Entries",
      sqlName: "entries",
      primaryKey: "id",
      fields: [
        {
          fieldId: id(3),
          name: "ID",
          sqlColumn: "id",
          type: "number",
          required: true,
          unique: true,
        },
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
      name: "add",
      label: "Add",
      kind: "create",
      tableId: id(2),
      access: "link",
      readOnly: false,
      fieldIds: [id(4)],
    },
    {
      operationId: id(6),
      name: "read",
      label: "Read",
      kind: "read",
      tableId: id(2),
      access: "owner",
      readOnly: true,
      fieldIds: [id(4)],
    },
    {
      operationId: id(7),
      name: "rename",
      label: "Rename",
      kind: "edit",
      tableId: id(2),
      access: "owner",
      readOnly: false,
      fieldIds: [id(4)],
    },
  ],
};
export const schemaSql = "CREATE TABLE entries(id INTEGER PRIMARY KEY,name TEXT NOT NULL);";
// "add" takes the values a form sends, keyed by field, and refuses the name "Full".
export const operationSource = `globalThis.operations={add(ctx,input){if(input.values['${id(4)}']==='Full')ctx.refuse('full','This list is full.');ctx.db.execute('INSERT INTO entries(name) VALUES(?)',[input.values['${id(4)}']]);return null;},read(ctx){return ctx.db.query('SELECT * FROM entries ORDER BY id');},rename(ctx,input){ctx.db.execute('UPDATE entries SET name=? WHERE id=?',[input.name,input.id]);return null;}};`;
export const revision = describeDatasetRevision({
  definition,
  revision: 1,
  schemaSql,
  operationSource,
});
const pinned = { datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256 };

/** Changes one change's request or answer on its way. */
export type Intercept = (headers: Headers, go: () => Promise<Response>) => Promise<Response>;
/** Changes any request to the server on its way, after the rest of the computer's own handling. */
export type Around = (
  path: string,
  go: () => Promise<Response>,
  signal: AbortSignal | undefined,
) => Promise<Response>;
/** Online; the connection is refused; a front answers 502 for a server that is down; or nothing answers. */
export type ServerReach = "online" | "refused" | "error" | "silent";

/** A request nothing answers: as the desktop's time limit does, it gives up after `limitMs`. */
export function unanswered(limitMs: number, signal: AbortSignal | null | undefined) {
  return new Promise<Response>((_resolve, reject) => {
    const stop = () => {
      clearTimeout(limit);
      reject(new TypeError("The server did not answer in time."));
    };
    const limit = setTimeout(stop, limitMs);
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function startTestRelay(
  options: { appExternalTransport?: DeclaredHttpsTransport } = {},
) {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "desktop-server-collections-"));
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "host"),
    limits,
    compileOperations: compileDatasetOperations,
    onShutdownError(error) {
      throw error;
    },
  });
  const handler = createSyncRelayHandler({
    storage: f.storage,
    datasetHost: host,
    appPublicationLimits: limits,
    linkKey: "server-collections-test-key",
    nowMs: () => Date.now(),
    // Only the owner calls in these tests.
    resolveActor: (_request, workspaceId) => ({ workspaceId, userId: "owner" }),
    resolveAccountSession: async () => ({
      userId: "owner",
      sessionId: "desktop",
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      clientKind: "desktop",
    }),
    ...options,
  });
  const server = serveFetchHandler({
    handler,
    maxBodyBytes: () => 4 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const computers: Array<() => Promise<void>> = [];
  const credentials = {
    serverUrl: origin,
    relayUrl: origin,
    email: "owner@example.test",
    userId: "owner",
    token: "owner",
  };
  return {
    origin,
    storage: f.storage,
    host: new URL(origin).host,
    /** The server's latest revision of an app approved on the owner's computer, which the app's requests name. */
    appRevision: (appId: string) =>
      Number(
        f.storage.db
          .prepare(
            "SELECT authority_revision FROM sync_relay_local_dataset_apps WHERE workspace_id='w' AND app_id=?",
          )
          .get(appId)?.authority_revision ?? 1,
      ),
    /** Creates the Collection on the server, as the owner. */
    activate: () =>
      host.activate(
        { kind: "named", workspaceId: "w", userId: "owner" },
        { workspaceId: "w", revision, schemaSql, operationSource },
      ),
    /** One of the owner's computers, with its own kept copies and saved list. */
    async computer(
      options: { latencyMs?: number; retryMs?: number; slowMs?: number; firstOpenMs?: number } = {},
    ) {
      const home = await mkdtemp(join(directory, "computer-"));
      const trips: string[] = [];
      let intercept: Intercept | undefined,
        around: Around | undefined,
        reach: ServerReach = "online",
        refusedAfterMs = 0,
        silentLimitMs = 1000;
      // What this computer heard changed: a Collection's id, or "list".
      const heard: string[] = [];
      const listeners = new Set<(what: string) => void>();
      const changed = (what: string) => {
        heard.push(what);
        for (const listener of listeners) listener(what);
      };
      const send = async (path: string, init: RequestInit) => {
        if (reach === "refused") {
          if (refusedAfterMs) await new Promise((resolve) => setTimeout(resolve, refusedAfterMs));
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        }
        if (reach === "error")
          return new Response("Bad Gateway", {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        if (reach === "silent") return unanswered(silentLimitMs, init.signal);
        trips.push(`${init.method ?? "GET"} ${path.replace(/^\/sync\/w\/datasets\/[^/]+/, "")}`);
        const headers = new Headers(init.headers);
        headers.set("authorization", "Bearer owner");
        if (options.latencyMs)
          await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
        const go = () => fetch(`${origin}${path}`, { ...init, headers });
        const hook = path.endsWith("/invoke") ? intercept : undefined;
        if (hook) intercept = undefined;
        const run = () => (hook ? hook(headers, go) : go());
        return around ? around(path, run, init.signal ?? undefined) : run();
      };
      const signal = new AbortController().signal;
      const remote = createRemoteDatasetData({
        workspaceId: "w",
        credentials,
        credentialGeneration: 1,
        signal,
        currentCredentialGeneration: () => 1,
        assertCurrent() {},
        async relayJson(_credentials, path, init) {
          const response = await send(path, init);
          const action = /\/datasets\/[^/]+\/([a-z-]+)/.exec(path)?.[1] ?? "describe";
          const value = await readDatasetResponse(response, action, signal);
          if (!response.ok) throw Error(`The server refused ${action}: ${JSON.stringify(value)}`);
          return value;
        },
      }) as OwnerDatasetData;
      const copies = new Map<string, ReturnType<typeof keptCopy>>(),
        open: Array<{ close(): Promise<void> }> = [];
      const keptCopy = async (datasetId: string) => {
        const copyDirectory = join(home, `copy-${datasetId}`);
        await mkdir(copyDirectory, { recursive: true });
        const copy = await createOwnerDatasetCopy({
          directory: copyDirectory,
          scope: { workspaceId: "w", datasetId },
          ownerKey: "owner",
          origin,
          assertOwner() {},
          onChanged: () => changed(datasetId),
          ...(options.retryMs ? { retryMs: options.retryMs } : {}),
          ...(options.slowMs ? { slowMs: options.slowMs } : {}),
          ...(options.firstOpenMs ? { firstOpenMs: options.firstOpenMs } : {}),
        });
        computers.push(() => copy.close());
        open.push(copy);
        const source = createRemoteDatasetReplicaSource({
          workspaceId: "w",
          datasetId,
          origin,
          credentials,
          credentialGeneration: 1,
          currentCredentialGeneration: () => 1,
          signal,
          assertCurrent() {},
          relayResponse: (_credentials, path, init) => send(path, init),
          onAccessLost() {},
        });
        return copy.data(remote, source, signal);
      };
      const savedList = join(home, "list.json");
      const saved = {
        read: async () => JSON.parse(await readFile(savedList, "utf8")) as unknown,
        update: async (change: (value: unknown) => unknown) => {
          const next = change(await readFile(savedList, "utf8").then(JSON.parse, () => undefined));
          if (next !== undefined) await writeFile(savedList, JSON.stringify(next));
        },
      };
      const data = createServerHomeData({
        host: new URL(origin).host,
        list: (page) => remote.list(page),
        copy: (datasetId) => {
          let copy = copies.get(datasetId);
          if (!copy) copies.set(datasetId, (copy = keptCopy(datasetId)));
          return copy;
        },
        saved,
        changed: () => changed("list"),
      });
      return {
        data,
        trips,
        heard,
        /**
         * This computer once no one is signed in: its copies close, as an
         * account change closes them, and its kept files open signed out.
         */
        async signOut() {
          for (const copy of open.splice(0)) await copy.close();
          const server = signedOutServer(),
            kept = new Map<string, Promise<OwnerDatasetData>>();
          const signedOut = createServerHomeData({
            host: new URL(origin).host,
            list: server.list,
            copy: (datasetId) => {
              let data = kept.get(datasetId);
              if (!data) {
                data = createOwnerDatasetCopy({
                  directory: join(home, `copy-${datasetId}`),
                  scope: { workspaceId: "w", datasetId },
                  ownerKey: "owner",
                  origin,
                  assertOwner() {},
                  signedOut: true,
                }).then((copy) => {
                  computers.push(() => copy.close());
                  return copy.data(server, server, signal);
                });
                kept.set(datasetId, data);
              }
              return data;
            },
            saved,
          });
          return {
            data: signedOut,
            read: () =>
              signedOut.invoke({
                ...pinned,
                operationId: id(6),
                input: {},
                idempotencyKey: "read",
              } as never),
            write: (operationId: string, input: Record<string, unknown>) =>
              signedOut.invoke({
                ...pinned,
                operationId,
                input,
                idempotencyKey: `change-${crypto.randomUUID()}`,
              } as never),
          };
        },
        intercept(hook: Intercept) {
          intercept = hook;
        },
        /** Changes every request that reaches the server from now on; undefined stops. */
        around(hook: Around | undefined) {
          around = hook;
        },
        /** No request reaches the server: the connection is refused. */
        offline(value: boolean) {
          reach = value ? "refused" : "online";
        },
        /**
         * How the server answers from now on. A refused connection can take a
         * while, as on Windows; a request to a silent server ends at the limit.
         */
        server(next: ServerReach, timing: { refusedAfterMs?: number; limitMs?: number } = {}) {
          reach = next;
          refusedAfterMs = timing.refusedAfterMs ?? 0;
          silentLimitMs = timing.limitMs ?? 1000;
        },
        /** Settles when this computer next hears that `what` changed. */
        updated(what: string) {
          return new Promise<void>((resolve) => {
            const listener = (value: string) => {
              if (value !== what) return;
              listeners.delete(listener);
              resolve();
            };
            listeners.add(listener);
          });
        },
        write: (operationId: string, input: Record<string, unknown>) =>
          data.invoke({
            ...pinned,
            operationId,
            input,
            idempotencyKey: `change-${crypto.randomUUID()}`,
          } as never),
        /** Opens the Collection, as its page does. */
        open: () => data.inspect!(id(1)),
        read: () =>
          data.invoke({
            ...pinned,
            operationId: id(6),
            input: {},
            idempotencyKey: "read",
          } as never),
      };
    },
    async close() {
      for (const close of computers.splice(0).reverse()) await close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await host.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    },
  };
}
