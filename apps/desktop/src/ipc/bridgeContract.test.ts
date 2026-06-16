import { describe, expect, it } from "vitest";
import { AppRuntimeRpcPayload } from "./bridgeContract";

describe("AppRuntimeRpcPayload", () => {
  const base = { workspaceId: "ws-apps", appRoot: "finance/.apps/ledger" };

  it("accepts bounded collection list and insert requests", () => {
    expect(
      AppRuntimeRpcPayload.parse({
        ...base,
        request: {
          id: "1",
          op: "collection.list",
          args: { name: "transactions" },
        },
      }).request,
    ).toEqual({
      id: "1",
      op: "collection.list",
      args: { name: "transactions" },
    });
    expect(
      AppRuntimeRpcPayload.parse({
        ...base,
        request: {
          id: "2",
          op: "collection.insert",
          args: { name: "transactions", record: { id: "x", amount: 42 } },
        },
      }).request,
    ).toEqual({
      id: "2",
      op: "collection.insert",
      args: { name: "transactions", record: { id: "x", amount: 42 } },
    });
  });

  it("rejects malformed operations, missing insert records, and oversized payloads", () => {
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < 9; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(
      AppRuntimeRpcPayload.safeParse({
        ...base,
        request: {
          id: "1",
          op: "collection.delete",
          args: { name: "transactions", record: { id: "x" } },
        },
      }).success,
    ).toBe(false);
    expect(
      AppRuntimeRpcPayload.safeParse({
        ...base,
        request: {
          id: "2",
          op: "collection.insert",
          args: { name: "transactions" },
        },
      }).success,
    ).toBe(false);
    expect(
      AppRuntimeRpcPayload.safeParse({
        ...base,
        request: {
          id: "3",
          op: "collection.insert",
          args: {
            name: "transactions",
            record: { id: "x", body: "x".repeat(300 * 1024) },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      AppRuntimeRpcPayload.safeParse({
        ...base,
        request: {
          id: "4",
          op: "collection.insert",
          args: { name: "transactions", record: tooDeep },
        },
      }).success,
    ).toBe(false);
    expect(
      AppRuntimeRpcPayload.safeParse({
        ...base,
        request: {
          id: "5",
          op: "collection.insert",
          args: {
            name: "transactions",
            record: { id: "x", values: Array.from({ length: 501 }, () => 0) },
          },
        },
      }).success,
    ).toBe(false);
  });
});
