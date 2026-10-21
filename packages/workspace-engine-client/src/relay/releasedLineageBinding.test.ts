import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "./releasedLineageBindingVectors.json" with { type: "json" };
import {
  canonicalReleasedLineageBinding,
  decodeReleasedLineageBinding,
  releasedLineageBindingDigest,
  releasedLineageBindingFromCanonical,
} from "./releasedLineageBinding";

describe("released-lineage binding contract", () => {
  // The engine's tests read the same vectors to the same bytes and digest.
  it.each(vectors.valid)("encodes and digests $name as the engine does", vector => {
    const binding = releasedLineageBindingFromCanonical(vector.canonical);
    expect(canonicalReleasedLineageBinding(binding)).toBe(vector.canonical);
    expect(releasedLineageBindingDigest(binding)).toBe(vector.digest);
    // A binding decoded from the wire's parsed object names the same digest.
    expect(releasedLineageBindingDigest(decodeReleasedLineageBinding(JSON.parse(vector.canonical)))).toBe(vector.digest);
  });

  it.each(vectors.invalid)("refuses $name", vector => {
    expect(() => releasedLineageBindingFromCanonical(vector.text)).toThrow("Invalid released-lineage binding");
  });

  it("keeps a null namespace explicit and refuses one dropped from a parsed binding", () => {
    const binding = JSON.parse(vectors.valid[1]!.canonical);
    expect(decodeReleasedLineageBinding(binding).incoming.relayNamespace).toBeNull();
    const {relayNamespace: _dropped, ...incoming} = binding.incoming;
    expect(() => decodeReleasedLineageBinding({...binding, incoming})).toThrow("incoming");
    expect(() => decodeReleasedLineageBinding({...binding, incoming: {...incoming, relayNamespace: ""}})).toThrow("relayNamespace");
  });

  it("refuses a lone surrogate the engine cannot hold", () => {
    const binding = JSON.parse(vectors.valid[1]!.canonical);
    expect(() => decodeReleasedLineageBinding({...binding, objectId: "object-\ud800"})).toThrow("objectId");
  });

  it("names the domain in the digest", () => {
    const binding = releasedLineageBindingFromCanonical(vectors.valid[0]!.canonical);
    expect(releasedLineageBindingDigest(binding)).not.toBe(createHash("sha256").update(vectors.valid[0]!.canonical).digest("hex"));
  });
});
