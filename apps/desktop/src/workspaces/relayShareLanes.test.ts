import { describe, expect, it } from "vitest";
import {
  isDamagedShareRow,
  isReadableChatChannelRow,
  pathShareLanes,
} from "./relayShareLanes";

// Ending a share is only possible from the manager that LISTS it, so the
// split between the two managers has to be exhaustive for granted rows.
// These trace both managers over the same listing.

const pathRow = (shareId: string) => ({
  shareId,
  selector: { paths: ["docs"], versionId: null, access: "view" },
});
const chatRow = (shareId: string) => ({
  shareId,
  selector: { kind: "chat-channel", channelWireId: "wire-1", access: "read-write" },
});
// What the relay sends for a row it could not read: no selector, and the
// kind only when it survived.
const damagedChatRow = (shareId: string) => ({
  shareId,
  selector: null,
  damaged: true,
  selectorKind: "chat-channel",
});
const damagedPathRow = (shareId: string) => ({ shareId, selector: null, damaged: true });

describe("relay share lanes", () => {
  it("sends a healthy chat-channel grant to the chat manager, not this one", () => {
    const lanes = pathShareLanes({
      granted: [pathRow("s-path"), chatRow("s-chat")],
      received: [pathRow("r-path"), chatRow("r-chat")],
    });
    expect(lanes.granted.map((row) => row.shareId)).toEqual(["s-path"]);
    expect(lanes.received.map((row) => row.shareId)).toEqual(["r-path"]);
  });

  // The regression this rule exists for. The chat manager scopes by
  // selector.kind and channelWireId, which a damaged row does not have, so
  // dropping it here too left it in NEITHER manager and unendable.
  it("keeps a damaged chat-channel grant listed, because no other manager can", () => {
    const damaged = damagedChatRow("s-damaged-chat");
    // Traced: the chat manager cannot take this row.
    expect(isReadableChatChannelRow(damaged)).toBe(false);
    expect(isDamagedShareRow(damaged)).toBe(true);

    const lanes = pathShareLanes({ granted: [damaged], received: [damaged] });
    expect(
      lanes.granted.map((row) => row.shareId),
      "MUTATION: a damaged chat-channel grant reaches neither manager and cannot be ended",
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

  // The property the split owes: every GRANTED row is listed by exactly one
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
