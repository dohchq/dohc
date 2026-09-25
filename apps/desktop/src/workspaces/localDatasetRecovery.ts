import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { RecoveryImportReceipt } from "@dohc/app-backend-runtime/recovery-install";
import type { DatasetRevision } from "@dohc/security-contract/dataset";

export interface DatasetRecoveryPreparation {
  transferId: string;
  manifestSha256: string;
  sourceCursor: DatasetCursor;
  revision: DatasetRevision;
}
interface Prepared extends DatasetRecoveryPreparation { install(): Promise<RecoveryImportReceipt>; dispose(): Promise<void> }

export function createLocalDatasetRecovery(options: {
  workspaceId: string; directory: string; maxBytes: number; signal: AbortSignal; assertCurrent(): void;
  prepare(input: { workspaceId: string; transferId: string; manifestSha256: string; stream: AsyncIterable<Uint8Array>; signal: AbortSignal }): Promise<Prepared>;
  claim(input: RecoveryImportReceipt & { workspaceId: string; datasetId: string; oldHostStopped: true; signal: AbortSignal }): RecoveryImportReceipt;
}) {
  const pending = new Map<string, Prepared>();
  const claims = new Map<string, Promise<RecoveryImportReceipt>>();
  const check = () => { options.signal.throwIfAborted(); options.assertCurrent(); };
  return {
    async prepare(input: { sourcePath: string; signal?: AbortSignal }): Promise<DatasetRecoveryPreparation> {
      check(); input.signal?.throwIfAborted();
      if (!isAbsolute(input.sourcePath) || !input.sourcePath.toLowerCase().endsWith(".dohc-recovery")) throw new Error("Choose an absolute path to a .dohc-recovery file.");
      if (pending.size >= 4) throw new Error("Finish or cancel an existing recovery before opening another file.");
      const info = await lstat(input.sourcePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > options.maxBytes) throw new Error("This recovery file is invalid or exceeds local storage capacity.");
      const file = await open(input.sourcePath, "r");
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("This recovery file changed. Choose it again.");
        const header = Buffer.alloc(13);
        if ((await file.read(header,0,13,0)).bytesRead !== 13 || header.subarray(0,8).toString() !== "DOHCDR01" || header[8] !== 1) throw new Error("This is not a dohc recovery file.");
        const length = header.readUInt32BE(9);
        if (!length || length > 1024*1024) throw new Error("This recovery file has an invalid header.");
        const manifest = Buffer.alloc(length);
        if ((await file.read(manifest,0,length,13)).bytesRead !== length) throw new Error("This recovery file is incomplete.");
        const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
        await mkdir(options.directory,{ recursive:true });
        const source = file.createReadStream({start:0,autoClose:false,highWaterMark:1024*1024});
        const stream = (async function* () { for await (const chunk of source) { check(); input.signal?.throwIfAborted(); yield new Uint8Array(chunk); } })();
        let prepared: Prepared;
        try { prepared = await options.prepare({ workspaceId:options.workspaceId,transferId:randomUUID(),manifestSha256,stream,signal:options.signal }); }
        finally { source.destroy(); }
        try {
          check(); input.signal?.throwIfAborted();
          if (pending.has(prepared.transferId)) await prepared.dispose();
          else pending.set(prepared.transferId,prepared);
        }
        catch(error) { await prepared.dispose(); throw error; }
        return {transferId:prepared.transferId,manifestSha256,sourceCursor:prepared.sourceCursor,revision:prepared.revision};
      } finally { await file.close(); }
    },
    claim(input: DatasetRecoveryPreparation | (RecoveryImportReceipt & { oldHostStopped: true })) {
      check();
      if (!("oldHostStopped" in input) || input.oldHostStopped !== true) return Promise.reject(new Error("Confirm that the old host stopped before restoring this Collection."));
      const previous = claims.get(input.transferId);
      if (previous) return previous;
      const task = (async () => {
        const prepared = pending.get(input.transferId);
        if (prepared) {
          if (prepared.manifestSha256 !== input.manifestSha256 || JSON.stringify(prepared.sourceCursor) !== JSON.stringify(input.sourceCursor)) throw new Error("The recovery approval changed. Choose the file again.");
          await prepared.install();
          pending.delete(input.transferId); await prepared.dispose();
        }
        check();
        return options.claim({ ...input,workspaceId:options.workspaceId,datasetId:input.sourceCursor.datasetId,oldHostStopped:true,signal:options.signal });
      })();
      claims.set(input.transferId,task);
      return task.finally(() => { claims.delete(input.transferId); });
    },
    async discard(transferId: string) { check(); if(claims.has(transferId)) throw new Error("Wait for this recovery to finish."); const prepared = pending.get(transferId); if (prepared) { pending.delete(transferId); await prepared.dispose(); } },
    async close() { await Promise.allSettled([...claims.values()]); const all = [...pending.values()]; pending.clear(); await Promise.all(all.map(value => value.dispose())); },
  };
}
