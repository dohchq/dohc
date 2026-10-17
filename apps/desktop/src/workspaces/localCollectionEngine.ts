import { join } from "node:path";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { LocalCollectionRefusal, type LocalCollectionEngine } from "./localCollectionApps";
import { EngineWritePolicyError, UnsupportedWorkspacePathError, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

/** Binds a workspace capture and its engine adapter as a Collection app's engine. */
export function localCollectionEngine(input: {
  workspaceId: string; rootPath: string;
  capture: Pick<WorkspaceEngineCapture, "writeAuthoredFile" | "readMoment">;
  withAdapter<T>(work: (adapter: Pick<VersionedLiveAdapter, "getActiveVersion" | "listTextFilePage" | "readTextFile">) => Promise<T>): Promise<T>;
}): LocalCollectionEngine {
  const { workspaceId } = input;
  return {
    async activeVersionId() {
      const version = await input.withAdapter(adapter => adapter.getActiveVersion({ workspaceId }));
      if (!version) throw new Error("This workspace has no active version.");
      return version.id;
    },
    listFiles: ({ versionId, folder, afterPath, limit }) => input.withAdapter(adapter => adapter.listTextFilePage({ workspaceId, versionId, under: folder, ...(afterPath === undefined ? {} : { afterPath }), limit })),
    async readText({ versionId, path }) {
      const file = await input.withAdapter(adapter => adapter.readTextFile({ workspaceId, versionId, path }));
      return file?.contentKind === "text" && typeof file.text === "string" ? file.text : null;
    },
    async create(envelope) {
      try {
        return await input.capture.writeAuthoredFile(join(input.rootPath, envelope.path), envelope.text, envelope.author,
          { createOnly: true, requestId: envelope.requestId, momentId: envelope.momentId, versionId: envelope.versionId });
      } catch (error) {
        // The saved version is no longer writable, another file holds the path, or policy refuses it.
        if ((error instanceof VersionedTextStoreError && (error.code === "invalid-version" || error.code === "target-path-exists")) ||
          error instanceof UnsupportedWorkspacePathError || error instanceof EngineWritePolicyError) throw new LocalCollectionRefusal(error.message);
        throw error;
      }
    },
    async moment(momentId) {
      const detail = await input.capture.readMoment(momentId);
      if (!detail) return null;
      // A protected moment is never a response this app wrote.
      if (detail.protected) return { workspaceId, versionId: "", objectId: "", path: "", operation: "protected", text: null };
      const { moment } = detail;
      return { workspaceId: moment.workspaceId, versionId: moment.versionId, objectId: moment.objectId, path: moment.path, operation: moment.operation, text: moment.payload.after.text };
    },
  };
}
