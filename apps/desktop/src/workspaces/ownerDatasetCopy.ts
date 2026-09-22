import { createDatasetReplica, type DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import { parseDatasetRevision, type DatasetDescription } from "@dohc/security-contract/dataset";
import type { OwnerDatasetData } from "./remoteDataset";
import { DatasetCopyOfflineError } from "./remoteDatasetReplica";

/** An owner-bound copy retains committed reads only. It never becomes a second writer. */
export async function createOwnerDatasetCopy(options: Parameters<typeof createDatasetReplica>[0]) {
  const replica = await createDatasetReplica(options);
  let denied = false;
  return {
    // Called inside source requests. Revoke after catchUp settles, avoiding its serialized work queue.
    accessLost() { denied = true; },
    revoke: () => { denied = true; return replica.revoke(); },
    close: () => replica.close(),
    data(remote: OwnerDatasetData, source: DatasetReplicaSource, signal: AbortSignal): OwnerDatasetData {
      const authorize = () => {
        options.assertOwner(); signal.throwIfAborted();
        if (denied) throw Error("This Collection copy is no longer available.");
      };
      const selected = (datasetId: string) => { authorize(); if (datasetId !== options.scope.datasetId) throw Error("This copy belongs to another Collection."); };
      const remoteDescribe: (datasetId: string, options?: { includeArchived?: boolean }) => ReturnType<OwnerDatasetData["describe"]> = remote.describe;
      const describe = (definitionJson: string): DatasetDescription => {
        const approved = parseDatasetRevision(JSON.parse(definitionJson));
        return { datasetId: approved.datasetId, name: approved.definition.name, revision: approved.revision,
          revisionSha256: approved.revisionSha256,
          tables: approved.definition.tables.map(table => ({ tableId: table.tableId, name: table.name,
            fields: table.fields.map(({ sqlColumn: _column, ...field }) => field) })), operations: approved.definition.operations };
      };
      const capture = async () => {
        authorize(); let offline = false;
        try { await replica.catchUp(source, signal); }
        catch (error) {
          if (denied) { await replica.revoke(); throw error; }
          authorize(); if (!(error instanceof DatasetCopyOfflineError)) throw error;
          offline = true;
        }
        authorize(); const state = replica.state();
        if (!state) throw Error("Download this Collection before opening it offline.");
        return { dataset: describe(state.checkpoint.definitionJson), copy: { offline, savedAtMs: state.savedAtMs } };
      };
      return {
        ...remote,
        async inspect(datasetId, metadata?: { includeArchived?: boolean }) {
          selected(datasetId);
          try {
            const dataset = await remoteDescribe(datasetId, metadata); authorize();
            if ("archived" in dataset && dataset.archived === true) return { dataset };
          } catch (error) {
            authorize();
            if (!(error instanceof TypeError)) {
              try { await source.capture(signal); }
              catch (captureError) { if (denied) { await replica.revoke(); throw captureError; } }
              throw error;
            }
            // The replica source independently classifies network failure and detects revoked access.
          }
          return capture();
        },
        async describe(datasetId, metadata?: { includeArchived?: boolean }) {
          selected(datasetId);
          // Sidebar discovery reads bounded metadata, never every Collection's database bytes.
          try { const dataset = await remoteDescribe(datasetId, metadata); authorize(); return dataset; }
          catch (error) {
            authorize();
            try { await source.capture(signal); }
            catch (captureError) {
              if (denied) { await replica.revoke(); throw captureError; }
              authorize();
              if (!(error instanceof TypeError) || !(captureError instanceof DatasetCopyOfflineError)) throw error;
              const saved = replica.state(); if (!saved) throw captureError;
              return describe(saved.checkpoint.definitionJson);
            }
            throw error;
          }
        },
        async invoke(input) {
          selected(input.datasetId);
          const state = await capture();
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
