import { describe, expect, it, vi } from "vitest";
import { parseAuthenticatedLogOps, parseNamedShareLogOps } from "./relayLogInputs";
import { stableJsonStringify } from "./canonicalJson";

function message(authorKind: unknown, authorDisplayName: unknown = "Writer") {
  return {originSeq: 0, recordedAtMs: 1, opKind: "chat.message.append", payload: {
    ...(authorKind === undefined ? {} : {authorKind}), authorDisplayName, authorUserId: "recipient", authorOwnerDisplayName: "Forged owner",
  }};
}

describe("named share log author admission", () => {
  it("looks up one account name for a batch and ignores client snapshots", async () => {
    const lookup = vi.fn(() => " Recipient ");
    const ops = await parseNamedShareLogOps([message("human"), message("agent"), message("automation")].map((op, originSeq) => ({
      ...op, originSeq, admittedAuthorSnapshot: [{kind: "human", humanId: "owner", humanName: "Owner"}],
    })), "recipient", lookup);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("recipient");
    expect(ops.map(op => op.admittedAuthorSnapshot)).toEqual(Array(3).fill([{kind: "human", humanId: "recipient", humanName: "Recipient"}]));
    expect(JSON.parse(ops[1]!.payloadJson).authorDisplayName).toBe("Writer");
  });

  it.each(["agent", "automation"])("requires a bounded, well-formed %s name", async kind => {
    for (const name of [null, 5, {}, [], "", " ", "x".repeat(201), "\ud800"]) {
      await expect(parseNamedShareLogOps([message(kind, name)], "recipient", () => "Recipient")).rejects.toThrow("invalid display name");
    }
    const missing = message(kind);
    const {authorDisplayName: _name, ...payload} = missing.payload;
    await expect(parseNamedShareLogOps([{...missing, payload}], "recipient", () => "Recipient")).rejects.toThrow("invalid display name");
    const op = message(kind, "w".repeat(200));
    expect((await parseNamedShareLogOps([op], "recipient", () => "Recipient"))[0]?.payloadJson).toBe(stableJsonStringify(op.payload));
  });

  it.each([undefined, null, "robot", 1])("rejects an unknown author kind: %j", async kind => {
    await expect(parseNamedShareLogOps([message(kind)], "recipient", () => "Recipient")).rejects.toThrow("invalid author kind");
  });

  it("leaves other ops and ordinary workspace chat unnamed", async () => {
    const lookup = vi.fn(() => "Recipient");
    const other = {...message("human"), opKind: "chat.thread.create"};
    expect((await parseNamedShareLogOps([other], "recipient", lookup))[0]?.admittedAuthorSnapshot).toBeUndefined();
    expect((await parseAuthenticatedLogOps([message("human")], "recipient", lookup))[0]?.admittedAuthorSnapshot).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
