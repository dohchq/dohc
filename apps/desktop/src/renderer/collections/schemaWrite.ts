import {
  COLLECTION_SCHEMA_FILENAME,
  type CollectionSchema,
} from "@dohc/workspace-contracts/collection";
import { bridge } from "../bridge";
import { serializeCollectionSchema } from "./schemaAuthoring";

// One schema rewrite: read the current schema from the engine's index
// (collections.get), read the schema file's current identity, apply the
// mutation to the model, serialize, and replace through the authored write
// path. The expectedContentHash makes a concurrent edit surface as a
// conflict instead of a lost write; the caller retries from fresh state.

export type SchemaWriteResult =
  | { status: "written" }
  | { status: "conflict" }
  | { status: "error"; detail: string | null };

export async function rewriteCollectionSchema(options: {
  workspaceId: string;
  collectionPath: string;
  mutate: (schema: CollectionSchema) => CollectionSchema;
}): Promise<SchemaWriteResult> {
  const { workspaceId, collectionPath, mutate } = options;
  const relativePath = `${collectionPath}/${COLLECTION_SCHEMA_FILENAME}`;
  try {
    const details = await bridge().getCollection({ workspaceId, collectionPath });
    const read = await bridge().readWorkspaceText({ workspaceId, relativePath });
    if (read.truncated) return { status: "error", detail: null };
    const result = await bridge().writeWorkspaceText({
      workspaceId,
      relativePath,
      text: serializeCollectionSchema(mutate(details.schema)),
      expectedContentHash: read.contentHash,
    });
    return result.status === "written"
      ? { status: "written" }
      : { status: "conflict" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
