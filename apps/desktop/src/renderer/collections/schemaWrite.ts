import {
  COLLECTION_SCHEMA_FILENAME,
  type CollectionSchema,
} from "@dohc/workspace-contracts/collection";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { bridge } from "../bridge";
import { serializeCollectionSchema } from "./schemaAuthoring";

// One schema rewrite: read the schema file once, parse that exact snapshot,
// apply the mutation to the parsed model, serialize, and replace through the
// authored write path. Deriving the model from the same read that supplies
// expectedContentHash means a change elsewhere cannot slip a stale schema
// over a newer file; a concurrent edit surfaces as a conflict instead of a
// lost write, and the caller retries from fresh state. A degraded parse is
// rejected because serializeCollectionSchema writes only modeled properties
// and would silently drop whatever the parser flagged.

type SchemaWriteResult =
  | { status: "written" }
  | { status: "conflict" }
  | { status: "error"; detail: string | null };

export async function rewriteCollectionSchema(options: {
  workspaceId: string;
  collectionPath: string;
  mutate: (schema: CollectionSchema) => CollectionSchema;
  signal?: AbortSignal;
  // The caller owns an issued write until its result is known, even if its
  // component unmounts. Cancellation only stops work before this boundary.
  onMutationStarted?: () => () => void;
}): Promise<SchemaWriteResult> {
  const { workspaceId, collectionPath, mutate } = options;
  const relativePath = `${collectionPath}/${COLLECTION_SCHEMA_FILENAME}`;
  let finishMutation: (() => void) | undefined;
  try {
    options.signal?.throwIfAborted();
    const read = await bridge().readWorkspaceText({ workspaceId, relativePath });
    options.signal?.throwIfAborted();
    if (read.truncated) return { status: "error", detail: null };
    const parsed = parseCollectionSchema(read.text);
    if (parsed.status !== "valid") {
      return {
        status: "error",
        detail: `The ${COLLECTION_SCHEMA_FILENAME} file has entries dohc cannot read. Fix the file, then try again.`,
      };
    }
    const text = serializeCollectionSchema(mutate(parsed.schema));
    options.signal?.throwIfAborted();
    finishMutation = options.onMutationStarted?.();
    const result = await bridge().writeWorkspaceText({
      workspaceId,
      relativePath,
      text,
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
  } finally {
    finishMutation?.();
  }
}
