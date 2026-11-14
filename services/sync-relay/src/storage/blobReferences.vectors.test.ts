import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { referencedBlobShas } from "./blobReferences";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../crates/dohc-engine-sync/tests/blob-references/vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    opKind: string;
    workspaceId: string;
    recordedAtMs: number;
    payload: unknown;
    blobs: Record<string, ("text" | "binary" | "ydoc")[]>;
  }[];
};

it.each(vectors.vectors)(
  "names the same blobs as the engine: $name",
  ({ opKind, workspaceId, recordedAtMs, payload, blobs }) => {
    const actual = referencedBlobShas(opKind, JSON.stringify(payload), {
      workspaceId,
      recordedAtMs,
    });
    expect([...new Set(actual)].sort()).toEqual(Object.keys(blobs).sort());
  },
);
