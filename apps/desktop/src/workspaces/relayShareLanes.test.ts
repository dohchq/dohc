import { describe, expect, it } from "vitest";
import {
  isDamagedShareRow,
  isReadableChatChannelRow,
  pathShareLanes,
} from "./relayShareLanes";

// Ending a share is only possible from the manager that lists it, so the
// split between the two managers has to be exhaustive for granted rows.
// These trace both managers over the same listing.

const pathRow = (shareId: string) => ({
  shareId,
  selector: { paths: ["docs"], versionId: null },
  access: "view",
  grantId: `grant-${shareId}`,
  generation: 1,
});
const chatRow = (shareId: string) => ({
  shareId,
  selector: { kind: "chat", channelWireId: "wire-1" },
  access: "read-write",
  grantId: `grant-${shareId}`,
  generation: 1,
});
const groupRow = (shareId: string) => ({
  shareId,
  selector: { kind: "group", channelWireId: "wire-1", paths: ["team"], versionId: null },
  access: "read-write",
  grantId: `grant-${shareId}`,
  generation: 1,
});
// What the relay sends for a row it could not read: no selector, and the
// kind only when it survived.
const damagedChatRow = (shareId: string) => ({
  shareId,
  selector: null,
  access: "read-write",
  grantId: `grant-${shareId}`,
  generation: 1,
  damaged: true,
  selectorKind: "chat",
});
const damagedPathRow = (shareId: string) => ({
  shareId,
  selector: null,
  access: "view",
  grantId: `grant-${shareId}`,
  generation: 1,
  damaged: true,
});

describe("relay share lanes", () => {
  it("sends a healthy chat grant to the chat manager, not this one", () => {
    const lanes = pathShareLanes({
      granted: [pathRow("s-path"), chatRow("s-chat")],
      received: [pathRow("r-path"), chatRow("r-chat")],
    });
    expect(lanes.granted.map((row) => row.shareId)).toEqual(["s-path"]);
    expect(lanes.received.map((row) => row.shareId)).toEqual(["r-path"]);
  });

  // A group is one grant: its folder is not a second path share for
  // Settings to list and end on its own.
  it("sends a group grant to the chat manager too", () => {
    const lanes = pathShareLanes({
      granted: [pathRow("s-path"), groupRow("s-group")],
      received: [pathRow("r-path"), groupRow("r-group"), { ...groupRow("r-damaged"), selector: null, damaged: true, selectorKind: "group" }],
    });
    expect(lanes.granted.map((row) => row.shareId)).toEqual(["s-path"]);
    expect(lanes.received.map((row) => row.shareId)).toEqual(["r-path"]);
  });

  // The regression this rule exists for. The chat manager scopes by
  // selector.kind and channelWireId, which a damaged row does not have, so
  // dropping it here too left it in neither manager and unendable.
  it("keeps a damaged chat grant listed, because no other manager can", () => {
    const damaged = damagedChatRow("s-damaged-chat");
    // Traced: the chat manager cannot take this row.
    expect(isReadableChatChannelRow(damaged)).toBe(false);
    expect(isDamagedShareRow(damaged)).toBe(true);

    const lanes = pathShareLanes({ granted: [damaged], received: [damaged] });
    expect(
      lanes.granted.map((row) => row.shareId),
      "a damaged chat grant reaches neither manager and cannot be ended",
    ).toEqual(["s-damaged-chat"]);
    // The receive side has nothing to accept, so it is dropped there.
    expect(lanes.received).toEqual([]);
  });

  it("keeps a damaged path grant in both lanes", () => {
    const damaged = damagedPathRow("s-damaged-path");
    const lanes = pathShareLanes({ granted: [damaged], received: [damaged] });
    expect(lanes.granted.map((row) => row.shareId)).toEqual(["s-damaged-path"]);
    expect(lanes.received.map((row) => row.shareId)).toEqual(["s-damaged-path"]);
  });

  // The property the split owes: every granted row is listed by exactly one
  // manager, so none is left without a way to end it.
  it("leaves no granted row without a manager", () => {
    const granted = [
      pathRow("a"),
      chatRow("b"),
      damagedChatRow("c"),
      damagedPathRow("d"),
    ];
    const lanes = pathShareLanes({ granted });
    for (const row of granted) {
      const here = lanes.granted.some((kept) => kept.shareId === row.shareId);
      const chatManager = isReadableChatChannelRow(row);
      expect(here || chatManager, `${row.shareId} is listed by no manager`).toBe(true);
    }
  });

  it("handles a listing with no rows at all", () => {
    expect(pathShareLanes({})).toEqual({ granted: [], received: [] });
  });
});
