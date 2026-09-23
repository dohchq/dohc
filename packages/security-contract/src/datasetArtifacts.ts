import { createHash } from "node:crypto";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  parseDatasetDefinition,
  parseDatasetRevision,
  type DatasetDefinition,
  type DatasetRevision,
} from "./dataset";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ARTIFACT_BYTES = 256 * 1024;

function source(value: unknown): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > ARTIFACT_BYTES || value.includes("\0")) {
    throw new Error("Invalid dataset source artifact.");
  }
  return value;
}

/** Content identity only. The host must separately obtain owner approval. */
export function describeDatasetRevision(input: {
  definition: DatasetDefinition;
  revision: number;
  schemaSql: string;
  operationSource: string;
}): DatasetRevision {
  const definition = parseDatasetDefinition(input.definition);
  const schemaSql = source(input.schemaSql), operationSource = source(input.operationSource);
  const revision = parseDatasetRevision({
    datasetId: definition.datasetId, revision: input.revision, definition,
    definitionSha256: hash(datasetDefinitionDigestContent(definition)),
    schemaSha256: hash(schemaSql), operationsSha256: hash(operationSource), revisionSha256: "0".repeat(64),
  });
  revision.revisionSha256 = hash(datasetRevisionDigestContent(revision));
  return revision;
}

/** Verify captured bytes, not paths that may have changed since preparation. */
export function verifyDatasetArtifacts(input: {
  revision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
}): DatasetRevision {
  const revision = parseDatasetRevision(input.revision);
  const expected = describeDatasetRevision({ definition: revision.definition, revision: revision.revision,
    schemaSql: input.schemaSql, operationSource: input.operationSource });
  if (revision.definitionSha256 !== expected.definitionSha256 || revision.schemaSha256 !== expected.schemaSha256 ||
      revision.operationsSha256 !== expected.operationsSha256 || revision.revisionSha256 !== expected.revisionSha256) {
    throw new Error("Dataset artifacts do not match the prepared revision.");
  }
  return expected;
}
