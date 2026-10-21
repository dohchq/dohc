import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "./releasedLineageBindingVectors.json" with { type: "json" };
import {
  canonicalReleasedLineageBinding,
  decodeReleasedLineageBinding,
  releasedLineageBindingDigest,
  releasedLineageBindingFromCanonical,
  releasedTailContributionsCommitment,
} from "./releasedLineageBinding";

describe("released-lineage binding contract", () => {
  // The engine's tests read the same vectors to the same commitments, bytes and digests.
  it.each(vectors.commitments)("commits to $name as the engine does", vector => {
    expect(releasedTailContributionsCommitment(vector.contributions)).toEqual({count: vector.count, digest: vector.digest});
    expect(releasedTailContributionsCommitment([...vector.contributions].reverse())).toEqual({count: vector.count, digest: vector.digest});
  });

  it("commits to every contribution's identity, digest and position, and to each addition and removal", () => {
    const [carried, outbox] = vectors.commitments[0]!.contributions;
    const committed = releasedTailContributionsCommitment([carried, outbox]).digest;
    const changed = [
      [{...carried, deliveryId: "delivery-9"}, outbox], [{...carried, updateDigest: "e".repeat(64)}, outbox],
      [{...carried, journalCursor: 8}, outbox], [carried, {...outbox, outboxId: "outbox-9"}], [carried, {...outbox, sequence: 4}],
      [carried, outbox, {...outbox, sequence: 4}], [carried, outbox, carried], [carried],
    ];
    for (const contributions of changed) expect(releasedTailContributionsCommitment(contributions).digest).not.toBe(committed);
    expect(() => releasedTailContributionsCommitment([])).toThrow("unproven");
    expect(() => releasedTailContributionsCommitment([{...carried, journalCursor: 2 ** 53}])).toThrow("journalCursor");
  });

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

  it("names the domain in the digest and the commitment", () => {
    const binding = releasedLineageBindingFromCanonical(vectors.valid[0]!.canonical);
    expect(releasedLineageBindingDigest(binding)).not.toBe(createHash("sha256").update(vectors.valid[0]!.canonical).digest("hex"));
    const [commitment] = vectors.commitments;
    const undomained = createHash("sha256").update(JSON.stringify(commitment!.contributions.map(contribution =>
      Object.fromEntries(Object.entries(contribution).sort(([a], [b]) => a < b ? -1 : 1))))).digest("hex");
    expect(commitment!.digest).not.toBe(undomained);
  });
});
