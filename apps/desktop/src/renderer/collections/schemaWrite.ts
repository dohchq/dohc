import {
  COLLECTION_SCHEMA_FILENAME,
  collectionVersionError,
  type CollectionSchema,
} from "@dohc/workspace-contracts/collection";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { readError } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { serializeCollectionSchema } from "./schemaAuthoring";

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
        detail: collectionVersionError(parsed.reasons, relativePath) ?? `The ${COLLECTION_SCHEMA_FILENAME} file has entries dohc cannot read. Fix the file, then try again.`,
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
      detail: readError(error).words,
    };
  } finally {
    finishMutation?.();
  }
}
