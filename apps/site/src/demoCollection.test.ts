import { describe, expect, it, vi } from "vitest";
import type { TransactionalInvoke } from "../../desktop/src/renderer/TransactionalCollectionPage";
import { DEMO_GUESTS, GUESTS_DATASET, demoCollectionStore } from "./demoCollection";

const operation = (kind: string) =>
  GUESTS_DATASET.operations.find((each) => each.kind === kind)!.operationId;
const field = (name: string) =>
  GUESTS_DATASET.tables[0]!.fields.find((each) => each.name === name)!.fieldId;
const NAME = field("Name");
const ROOM = field("Room");
const MEI = DEMO_GUESTS[4]!.id;

type Json = TransactionalInvoke["input"];

function store() {
  const save = vi.fn();
  const { invoke } = demoCollectionStore(DEMO_GUESTS, save);
  const call = async (kind: string, input: Record<string, Json>) =>
    (
      await invoke({
        workspaceId: "marketing-demo",
        datasetId: GUESTS_DATASET.datasetId,
        revision: GUESTS_DATASET.revision,
        revisionSha256: GUESTS_DATASET.revisionSha256,
        operationId: operation(kind),
        input,
        idempotencyKey: crypto.randomUUID(),
      })
    ).result as Record<string, unknown>;
  const names = async (input: Record<string, Json> = {}) =>
    (
      (await call("read", { limit: 50, ...input })).rows as { values: Record<string, unknown> }[]
    ).map((row) => row.values[NAME]);
  return { save, call, names };
}

describe("demoCollectionStore", () => {
  it("edits a record, returning exactly the changed fields' earlier values so the page can undo", async () => {
    const { save, call, names } = store();
    const edited = await call("edit", {
      id: MEI,
      expectedVersion: 1,
      values: { [ROOM]: "Alfama flat" },
    });
    expect(edited).toEqual({ id: MEI, version: 2, priorValues: { [ROOM]: "Not booked" } });
    expect(save).toHaveBeenCalledOnce();
    expect(await names({ filters: [{ fieldId: ROOM, value: "Alfama flat" }] })).toEqual([
      "You",
      "Sam",
      "Mei",
    ]);
  });

  it("refuses an edit against an older version, and changes nothing", async () => {
    const { save, call } = store();
    await call("edit", { id: MEI, expectedVersion: 1, values: { [ROOM]: "Sintra cottage" } });
    await expect(
      call("edit", { id: MEI, expectedVersion: 1, values: { [ROOM]: "Alfama flat" } }),
    ).rejects.toThrow("Someone changed this record first.");
    expect(save).toHaveBeenCalledOnce();
  });

  it("creates with the field defaults, then searches, sorts, and deletes", async () => {
    const { call, names } = store();
    const created = await call("create", { values: { [NAME]: "Ana" } });
    expect(await names({ search: "ana" })).toEqual(["Ana"]);
    expect(await names({ sort: { fieldId: NAME, direction: "asc" } })).toEqual([
      "Ana",
      "Jonas",
      "Mei",
      "Priya",
      "Sam",
      "You",
    ]);
    const rows = (await call("read", { limit: 50, search: "ana" })).rows as {
      values: Record<string, unknown>;
    }[];
    expect(rows[0]!.values[ROOM]).toBe("Not booked");
    await call("delete", { id: created.id as Json, expectedVersion: 1 });
    expect(await names({ search: "ana" })).toEqual([]);
  });

  it("reads a board column and a calendar range, and names each in its answer", async () => {
    const { call } = store();
    const ARRIVES = field("Arrives");
    const group = { fieldId: ROOM, value: "Sintra cottage" };
    const column = await call("read", { limit: 50, group });
    expect(column.group).toEqual(group);
    expect((column.rows as unknown[]).length).toBe(2);
    const range = { fieldId: ARRIVES, start: "2027-05-15", end: "2027-05-16" };
    const month = await call("read", { limit: 50, range });
    expect(month.range).toEqual(range);
    expect(
      (month.rows as { values: Record<string, unknown> }[]).map((row) => row.values[NAME]),
    ).toEqual(["Priya", "Jonas"]);
  });

  it("pages a read and a board's column values with cursors", async () => {
    const { call, names } = store();
    const first = await call("read", { limit: 2, sort: { fieldId: NAME, direction: "asc" } });
    expect(first.nextCursor).toEqual({ id: MEI, value: "Mei" });
    expect(
      await names({
        limit: 2,
        sort: { fieldId: NAME, direction: "asc" },
        after: first.nextCursor as Json,
      }),
    ).toEqual(["Priya", "Sam"]);
    const groups = await call("read", { limit: 2, groupBy: NAME });
    expect(groups).toEqual({
      groupBy: NAME,
      groups: ["Jonas", "Mei"],
      nextGroupCursor: { value: "Mei" },
    });
    expect(await call("read", { limit: 8, groupBy: NAME, groupAfter: { value: "Mei" } })).toEqual({
      groupBy: NAME,
      groups: ["Priya", "Sam", "You"],
      nextGroupCursor: null,
    });
  });

  it("refuses a guest with no name", async () => {
    const { call } = store();
    await expect(call("create", { values: { [NAME]: " " } })).rejects.toThrow(
      "A guest needs a name.",
    );
  });
});
