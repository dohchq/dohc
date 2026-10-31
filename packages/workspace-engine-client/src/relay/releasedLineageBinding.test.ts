import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "./releasedLineageBindingVectors.json" with { type: "json" };
import {
  canonicalJson,
  canonicalReleasedLineageBinding,
  decodeReleasedLineageBinding,
  decodeRetainedContribution,
  mergedContributionsCommitment,
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

  it.each(vectors.artifacts)("encodes the contribution artifact $name, and commits to its merged list, as the engine does", vector => {
    const artifact = JSON.parse(vector.canonical);
    expect(canonicalJson(artifact)).toBe(vector.canonical);
    expect(createHash("sha256").update(vector.canonical, "utf8").digest("hex")).toBe(vector.sha256);
    expect(mergedContributionsCommitment(artifact.mergedContributionIds)).toEqual(vector.mergedContributions);
    // The same encoding a tail commits to, the empty list's included.
    if (artifact.mergedContributionIds.length > 0) {
      expect(releasedTailContributionsCommitment(artifact.mergedContributionIds)).toEqual(vector.mergedContributions);
    }
  });

  it("commits to merged contributions only in canonical order, each once", () => {
    const [carried, outbox] = vectors.commitments[0]!.contributions;
    expect(mergedContributionsCommitment([carried, outbox])).toEqual(releasedTailContributionsCommitment([outbox, carried]));
    expect(() => mergedContributionsCommitment([outbox, carried])).toThrow("merged order");
    expect(() => mergedContributionsCommitment([outbox, outbox])).toThrow("merged order");
    expect(mergedContributionsCommitment([]).count).toBe(0);
  });

  it("commits to every contribution's identity, digest, position and authors, and to each addition and removal", () => {
    const [carried, outbox] = vectors.commitments[0]!.contributions;
    const committed = releasedTailContributionsCommitment([carried, outbox]).digest;
    const agent = carried!.authors[0]!;
    const changed = [
      [{...carried, deliveryId: "delivery-9"}, outbox], [{...carried, updateDigest: "e".repeat(64)}, outbox],
      [{...carried, journalCursor: 8}, outbox], [carried, {...outbox, outboxId: "outbox-9"}], [carried, {...outbox, sequence: 4}],
      [carried, outbox, {...outbox, sequence: 4}], [carried, outbox, carried], [carried],
      // Only who made the work changes.
      [{...carried, authors: [{...agent, agentId: "other-agent"}]}, outbox],
      [{...carried, authors: [{...agent, onBehalfOf: "someone"}]}, outbox],
      [{...carried, authors: [{...agent, depth: 2}]}, outbox],
      [{...carried, authors: [{kind: "unattributed"}]}, outbox],
      [carried, {...outbox, authors: [{kind: "human", humanId: "local-person"}]}],
    ];
    for (const contributions of changed) expect(releasedTailContributionsCommitment(contributions).digest).not.toBe(committed);
    expect(() => releasedTailContributionsCommitment([])).toThrow("unproven");
    expect(() => releasedTailContributionsCommitment([{...carried, journalCursor: 2 ** 53}])).toThrow("journalCursor");
  });

  it("refuses a contribution outside the engine's contract", () => {
    const [carried, outbox] = vectors.commitments[0]!.contributions;
    const {authors: _authors, ...unauthored} = carried!;
    const refused: [string, unknown, string][] = [
      ["no authors", unauthored, "authors"],
      ["no author", {...carried, authors: []}, "authors"],
      ["two authors", {...carried, authors: [...carried!.authors, ...outbox!.authors]}, "authors"],
      ["a journal cursor of 0", {...carried, journalCursor: 0}, "journalCursor"],
      ["a sequence of 0", {...outbox, sequence: 0}, "sequence"],
      ["an uppercase digest", {...carried, updateDigest: "C".repeat(64)}, "updateDigest"],
      ["a short digest", {...outbox, updateDigest: "d".repeat(63)}, "updateDigest"],
      ["another key", {...carried, extra: 1}, "carried contribution"],
      ["an unknown author kind", {...carried, authors: [{kind: "public"}]}, "author kind"],
      ["an author with another key", {...carried, authors: [{kind: "unattributed", note: 1}]}, "author"],
      ["an agent at an explicit depth of 0", {...carried, authors: [{kind: "agent", agentId: "a", depth: 0}]}, "author depth"],
      ["a chain past its bound", {...carried, authors: [{kind: "agent", agentId: "a", depth: 65}]}, "author depth"],
      ["an automation without its depth", {...carried, authors: [{kind: "automation", automationId: "sort"}]}, "author"],
      ["a person at a depth", {...carried, authors: [{kind: "human", humanId: "p", depth: 1}]}, "author"],
      ["an author with a control character", {...carried, authors: [{kind: "agent", agentId: "a\u0001"}]}, "author agentId"],
      ["an author past the identifier bound", {...carried, authors: [{kind: "agent", agentId: "a".repeat(513)}]}, "author agentId"],
      ["an empty principal", {...carried, authors: [{kind: "agent", agentId: "a", onBehalfOf: ""}]}, "author onBehalfOf"],
    ];
    for (const [name, contribution, field] of refused) {
      expect(() => decodeRetainedContribution(contribution), name).toThrow(field);
    }
    expect(decodeRetainedContribution({...carried, authors: [{kind: "agent", agentId: "a".repeat(512)}]}).authors).toHaveLength(1);
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
