import { createDatasetReplica, type DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import { parseDatasetRevision, parseDatasetDescription, type DatasetDescription } from "@dohc/security-contract/dataset";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OwnerDatasetData } from "./remoteDataset";
import { DatasetCopyOfflineError } from "./remoteDatasetReplica";

/** An owner-bound copy retains committed reads only. It never becomes a second writer. */
export async function createOwnerDatasetCopy(options: Parameters<typeof createDatasetReplica>[0]) {
  const replica = await createDatasetReplica(options);
  let denied = false;
  const markerPath = join(options.directory, "archived.json");
  const binding = createHash("sha256").update(JSON.stringify([options.scope,options.ownerKey,new URL(options.origin).origin])).digest("hex");
  const markerSchema = z.object({ binding: z.literal(binding), dataset: z.unknown().transform(value => parseDatasetDescription(value)), savedAtMs: z.number().int().nonnegative() }).strict();
  let archived: z.infer<typeof markerSchema> | null = null, metadataPending: Promise<unknown> = Promise.resolve();
  try {
    const info = await lstat(markerPath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error("The saved Collection status is damaged. Reconnect to its server.");
      archived = markerSchema.parse(JSON.parse(await readFile(markerPath,"utf8")));
      if (archived.dataset.datasetId !== options.scope.datasetId) throw Error("The saved status belongs to another Collection.");
    }
  } catch (error) { await replica.close(); throw error; }
  const enqueueMetadata = <T>(work: () => Promise<T>): Promise<T> => {
    const result = metadataPending.then(work,work); metadataPending = result.catch(() => undefined); return result;
  };
  const clearArchive = async () => { await rm(markerPath,{force:true}); archived=null; };
  const revoke = async () => { denied=true; await metadataPending; await replica.revoke(); await clearArchive(); };
  const archivedResult = () => archived && { dataset: { ...archived.dataset, archived:true }, copy:{offline:true,savedAtMs:archived.savedAtMs} };
  return {
    // Called inside source requests. Revoke after catchUp settles, avoiding its serialized work queue.
    accessLost() { denied = true; },
    revoke,
    close: async () => { await metadataPending; await replica.close(); },
    data(remote: OwnerDatasetData, source: DatasetReplicaSource, signal: AbortSignal): OwnerDatasetData {
      const authorize = () => {
        options.assertOwner(); signal.throwIfAborted();
        if (denied) throw Error("This Collection copy is unavailable. Restore access, then reopen the workspace.");
      };
      const selected = (datasetId: string) => { authorize(); if (datasetId !== options.scope.datasetId) throw Error("This copy belongs to another Collection."); };
      const remoteDescribe: (datasetId: string, options?: { includeArchived?: boolean }) => ReturnType<OwnerDatasetData["describe"]> = remote.describe;
      const describeRemote = (datasetId: string, metadata?: { includeArchived?: boolean }) => enqueueMetadata(async () => {
        authorize(); const dataset = await remoteDescribe(datasetId,metadata); authorize();
        if ("archived" in dataset && dataset.archived === true) {
          const { archived: _archived, ...description } = dataset;
          const value = markerSchema.parse({binding,dataset:description,savedAtMs:Date.now()}), temporary = `${markerPath}.${randomUUID()}`;
          try {
            const file = await open(temporary,"wx",0o600);
            try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
            authorize(); await rename(temporary,markerPath); archived=value;
          } finally { await rm(temporary,{force:true}); }
        } else if (archived) await clearArchive();
        authorize(); return dataset;
      });
      const describe = (definitionJson: string): DatasetDescription => {
        const approved = parseDatasetRevision(JSON.parse(definitionJson));
        return { datasetId: approved.datasetId, name: approved.definition.name, revision: approved.revision,
          revisionSha256: approved.revisionSha256,
          tables: approved.definition.tables.map(table => ({ tableId: table.tableId, name: table.name,
            fields: table.fields.map(({ sqlColumn: _column, ...field }) => field) })), operations: approved.definition.operations };
      };
      const capture = async () => {
        authorize(); let offline = false; const priorArchived = archived;
        try {
          await replica.catchUp(source, signal);
          // The host refuses replica capture while archived; a successful capture confirms restoration.
          if (priorArchived) await enqueueMetadata(async () => { authorize(); if (archived === priorArchived) await clearArchive(); });
        }
        catch (error) {
          if (denied) { await revoke(); throw error; }
          authorize(); if (!(error instanceof DatasetCopyOfflineError)) throw error;
          offline = true;
        }
        if (offline && archived) return archivedResult()!;
        authorize(); const state = replica.state();
        if (!state) throw Error("Download this Collection before opening it offline.");
        return { dataset: describe(state.checkpoint.definitionJson), copy: { offline, savedAtMs: state.savedAtMs } };
      };
      return {
        ...remote,
        async inspect(datasetId, metadata?: { includeArchived?: boolean }) {
          selected(datasetId);
          try {
            const dataset = await describeRemote(datasetId, metadata); authorize();
            if ("archived" in dataset && dataset.archived === true) return { dataset };
          } catch (error) {
            authorize();
            if (!(error instanceof TypeError)) {
              try { await source.capture(signal); }
              catch (captureError) { if (denied) { await revoke(); throw captureError; } }
              throw error;
            }
            // The replica source independently classifies network failure and detects revoked access.
          }
          return capture();
        },
        async describe(datasetId, metadata?: { includeArchived?: boolean }) {
          selected(datasetId);
          // Sidebar discovery reads bounded metadata, never every Collection's database bytes.
          try { const dataset = await describeRemote(datasetId, metadata); authorize(); return dataset; }
          catch (error) {
            authorize();
            try { await source.capture(signal); }
            catch (captureError) {
              if (denied) { await revoke(); throw captureError; }
              authorize();
              if (!(error instanceof TypeError) || !(captureError instanceof DatasetCopyOfflineError)) throw error;
              if (archived) return archivedResult()!.dataset;
              const saved = replica.state(); if (!saved) throw captureError;
              return describe(saved.checkpoint.definitionJson);
            }
            throw error;
          }
        },
        async invoke(input) {
          selected(input.datasetId);
          const state = await capture();
          if ("archived" in state.dataset && state.dataset.archived === true) throw Error("This Collection is archived. Reconnect and restore it before using its records.");
          const operation = state.dataset.operations.find(operation => operation.operationId === input.operationId);
          if (!operation?.readOnly) {
            if (state.copy.offline) throw Error("This Collection copy is read-only. Reconnect to make changes.");
            return remote.invoke(input);
          }
          const result = await replica.read(input); authorize();
          return { result: result.result, revision: result.revision, replayed: false, copy: state.copy };
        },
      };
    },
  };
}
