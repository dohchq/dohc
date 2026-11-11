import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { deferred, type Deferred } from "../testing/deferred";
import type { TransactionalField } from "./transactionalCollectionModel";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";
import { hasWriteQueueForTests, resetWriteQueuesForTests, writeQueueFor, type WriteQueueHost } from "./transactionalWriteQueue";

const scope = "workspace/collection/table";
const name: TransactionalField = { fieldId: "name", name: "Name", type: "text", required: false, unique: false };
const amount: TransactionalField = { fieldId: "amount", name: "Amount", type: "number", required: false, unique: false };
const member: TransactionalField = { fieldId: "member", name: "Member", type: "text", required: true, unique: true };
const operation = (operationId: string, kind: DatasetOperation["kind"], fieldIds: string[]): DatasetOperation =>
  ({ operationId, name: operationId, label: operationId, kind, access: "owner", readOnly: kind === "read", tableId: "table", fieldIds });
const operations = [operation("read", "read", ["name", "amount", "member"]), operation("edit", "edit", ["name", "amount"]), operation("create", "create", ["name", "amount"]), operation("delete", "delete", [])];
const row = (id: number, version: number) => ({ id, version, values: {} });
const refusal = (words: string) => Object.assign(new Error(words), { code: "operation_refused" });
type Answer = Deferred<{ result: AppBackendJson }>;

/** A page's rules and handlers. Each request waits in `calls` for the test to answer it. */
function host(overrides: Pick<WriteQueueHost, "primaryKeyFieldId"> = { primaryKeyFieldId: "member" }) {
  const calls: Array<{ request: TransactionalInvoke; answer: Answer }> = [];
  const invoke = vi.fn((request: TransactionalInvoke) => { const answer: Answer = deferred(); calls.push({ request, answer }); return answer.promise; });
  const given = { workspaceId: "workspace", datasetId: "collection", revision: 1, revisionSha256: "a".repeat(64), tableName: "People", fields: [name, amount, member],
    operations, offline: false, invoke, onError: vi.fn(), onSettled: vi.fn(), onNotice: vi.fn(), confirmed: vi.fn(), dropped: vi.fn(() => false), unconfirmed: vi.fn(), read: vi.fn(), describe: vi.fn(), ...overrides };
  const inputs = (operationId: string) => calls.filter(call => call.request.operationId === operationId).map(call => call.request.input);
  return { ...given, calls, inputs };
}
/** Opens a page of the table with these rules. */
function open(given: WriteQueueHost) {
  const queue = writeQueueFor(scope), page = queue.page();
  page.sync(given);
  return { queue, page, close: page.open() };
}
const edit = (record: { id: number; version: number }, field: TransactionalField, value: AppBackendJson) => ({ kind: "edit" as const, record, operationId: "edit", values: { [field.fieldId]: { value, under: field } }, label: "Saved the edit" });
const state = (page: ReturnType<typeof open>["page"], record: number, field: TransactionalField) => page.statuses.get(String(record), field.fieldId)?.state;

afterEach(resetWriteQueuesForTests);

describe("the order changes go in", () => {
  it("sends one request at a time, in the order the changes were made", async () => {
    const rules = host(), { queue } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    queue.enqueue({ kind: "delete", record: row(1, 2), operationId: "delete", label: "Deleted the record" });
    expect(rules.calls).toHaveLength(1);
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    rules.calls[1]!.answer.resolve({ result: { id: 2, version: 5 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(3));
    expect(rules.calls.map(call => call.request.input)).toEqual([
      { id: 1, expectedVersion: 2, values: { name: "Alicia" } },
      { id: 2, expectedVersion: 4, values: { name: "Beatrice" } },
      { id: 1, expectedVersion: 3 },
    ]);
  });

  it("holds a record's later changes behind one dohc could not confirm, and lets another record's go", async () => {
    const rules = host(), { queue, page } = open(rules);
    const first = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    rules.calls[0]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    expect(rules.calls[1]!.request.input).toEqual({ id: 2, expectedVersion: 4, values: { name: "Beatrice" } });
    expect([state(page, 1, name), state(page, 1, amount)]).toEqual(["unconfirmed", "waiting"]);
    expect(rules.unconfirmed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: first }));
    rules.calls[1]!.answer.resolve({ result: { id: 2, version: 5 } });
    await vi.waitFor(() => expect(state(page, 2, name)).toBe("pending"));
    // Try again sends the exact request, and the record's next change follows on the receipt's version.
    queue.retry(first);
    expect(rules.calls[2]!.request).toEqual(rules.calls[0]!.request);
    rules.calls[2]!.answer.resolve({ result: { id: 1, version: 7 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(4));
    expect(rules.calls[3]!.request.input).toEqual({ id: 1, expectedVersion: 7, values: { amount: 9 } });
  });
});

describe("the version a record's next change goes with", () => {
  it("waits for a page's read when a receipt reports no version, and uses the version that read returns", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    const before = page.readStarted();
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalledOnce());
    // A read that started before the change says nothing of the record's version after it.
    page.readShown(before, [row(1, 2)]);
    expect(rules.calls).toHaveLength(1);
    expect(rules.read).toHaveBeenCalledTimes(2);
    page.readShown(page.readStarted(), [row(1, 6)]);
    expect(rules.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 6, values: { amount: 9 } });
  });

  it("reads the record by its key when a page's read leaves it out, and drops its changes when it is gone", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    rules.calls[0]!.answer.resolve({ result: null });
    // Record 2's change does not wait for record 1's version.
    await vi.waitFor(() => expect(rules.inputs("edit")).toHaveLength(2));
    rules.calls[1]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalled());
    page.readShown(page.readStarted(), []);
    expect(rules.inputs("read")).toEqual([{ limit: 1, filters: [{ fieldId: "member", value: 1 }] }]);
    expect(state(page, 1, amount)).toBe("pending");
    rules.calls[2]!.answer.resolve({ result: { rows: [], nextCursor: null } });
    await vi.waitFor(() => expect(state(page, 1, amount)).toBe("refused"));
    expect(page.statuses.get("1", "amount")).toMatchObject({ value: 9, reason: "This record is no longer in the Collection, so dohc did not save this change." });
    expect(rules.inputs("edit")).toHaveLength(2);
  });

  it("says a change waits, with Try again in Notices, when the read of its record fails, and goes on once it works", async () => {
    const rules = host(), { queue, page, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    close();
    rules.calls[0]!.answer.resolve({ result: null });
    // No page is open to read, so the queue reads the record itself.
    await vi.waitFor(() => expect(rules.inputs("read")).toHaveLength(1));
    rules.calls[1]!.answer.reject(new Error("Offline"));
    await vi.waitFor(() => expect(rules.onError).toHaveBeenCalledOnce());
    expect(rules.onError.mock.calls[0]).toEqual(["dohc could not read record 1 in People, so its changes are waiting.", expect.objectContaining({ message: "Offline" }), expect.any(Function), expect.any(String)]);
    expect(page.statuses.get("1", "amount")).toMatchObject({ state: "waiting", reason: "Waiting for dohc to read this record again" });
    expect(queue.attention()).toEqual([expect.objectContaining({ kind: "waiting", reason: "Waiting for dohc to read this record again" })]);
    (rules.onError.mock.calls[0]![2] as () => void)();
    rules.calls[2]!.answer.resolve({ result: { rows: [row(1, 8)], nextCursor: null } });
    await vi.waitFor(() => expect(rules.inputs("edit")).toHaveLength(2));
    expect(rules.inputs("edit")[1]).toEqual({ id: 1, expectedVersion: 8, values: { amount: 9 } });
  });

  it("keeps a record blocked when its table's read can't find it by a key, until a page's read returns it", async () => {
    const rules = host({ primaryKeyFieldId: undefined }), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalledOnce());
    page.readShown(page.readStarted(), []);
    expect(rules.calls).toHaveLength(1);
    expect(state(page, 1, amount)).toBe("waiting");
    page.readShown(page.readStarted(), [row(1, 3)]);
    expect(rules.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 3, values: { amount: 9 } });
  });
});

describe("a value dohc did not save", () => {
  it("is not kept once a later change to its cell is queued, so the cell ends on the later value", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "first"));
    queue.enqueue(edit(row(1, 2), name, "second"));
    rules.calls[0]!.answer.reject(refusal("No."));
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "pending", value: "second" });
    rules.calls[1]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalled());
    page.readShown(page.readStarted(), [row(1, 3)]);
    expect(page.statuses.get("1", "name")).toBeUndefined();
    expect(queue.attention()).toEqual([]);
  });

  it("stays the later one when an earlier change to its cell is refused after it", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "sent"));
    queue.hold(row(1, 2), name, "", "Enter Name.");
    rules.calls[0]!.answer.reject(refusal("No."));
    await vi.waitFor(() => expect(rules.onError).toHaveBeenCalled());
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "refused", value: "", reason: "Enter Name." });
  });

  it("keeps a refused new record's values when no page's form takes them, and gives them to a form that does", async () => {
    const rules = host(), { queue } = open(rules);
    const create = () => queue.enqueue({ kind: "create", record: null, operationId: "create", values: { name: { value: "Bob", under: name } }, label: "Created a record" });
    const first = create();
    rules.calls[0]!.answer.reject(refusal("Name is taken."));
    await vi.waitFor(() => expect(queue.attention()).toHaveLength(1));
    expect(queue.attention()[0]).toEqual({ kind: "record", id: first, values: { name: { value: "Bob", under: name } }, reason: "The Collection refused this change. Name is taken." });
    expect(rules.dropped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: first }), "The Collection refused this change. Name is taken.", true);
    queue.dismissRecord(first);
    rules.dropped.mockReturnValue(true);
    create();
    rules.calls[1]!.answer.reject(refusal("Name is taken."));
    await vi.waitFor(() => expect(rules.dropped).toHaveBeenCalledTimes(2));
    expect(queue.attention()).toEqual([]);
  });
});

describe("Discard", () => {
  it("gives up only a change dohc could not confirm, never sends its request again, and makes the record's next change wait for a read", async () => {
    const rules = host(), { queue, page } = open(rules);
    const first = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    // A change in flight can't be discarded.
    queue.discard(first);
    expect(queue.find(first)?.state).toBe("sending");
    rules.calls[0]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(queue.find(first)?.state).toBe("unconfirmed"));
    const [, , retry, identity] = rules.onError.mock.calls[0]!;
    rules.read.mockClear();

    queue.discard(first);
    expect(queue.find(first)).toBeUndefined();
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "refused", value: "Alicia",
      reason: "dohc could not confirm this change, and you discarded it. Check the record before you make the change again." });
    expect(rules.onSettled).toHaveBeenCalledExactlyOnceWith(identity);
    expect(rules.read).toHaveBeenCalledOnce();
    // Neither Try again, on the cell or in Notices, sends the request again.
    queue.retry(first); (retry as () => void)();
    expect(rules.calls).toHaveLength(1);

    // The next change waits for a read after the discard, and goes with that read's version and its own key.
    queue.enqueue(edit(row(1, 2), amount, 9));
    expect(rules.calls).toHaveLength(1);
    page.readShown(page.readStarted(), [row(1, 5)]);
    expect(rules.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 5, values: { amount: 9 } });
    expect(rules.calls[1]!.request.idempotencyKey).not.toBe(rules.calls[0]!.request.idempotencyKey);
  });

  it("keeps nothing of a discarded change whose cell a later change replaced", async () => {
    const rules = host(), { queue, page } = open(rules);
    const first = queue.enqueue(edit(row(1, 2), name, "first"));
    rules.calls[0]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(queue.find(first)?.state).toBe("unconfirmed"));
    queue.enqueue(edit(row(1, 2), name, "second"));
    queue.discard(first);
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "pending", value: "second" });
    expect(queue.attention()).toEqual([]);
  });
});

describe("one queue for a table", () => {
  it("is the same queue for every page of the table, tells each of a confirmed change, and asks each to read", async () => {
    const left = host(), right = host();
    const a = open(left), b = open(right);
    expect(b.queue).toBe(a.queue);
    a.queue.enqueue(edit(row(1, 2), name, "Alicia"));
    expect([state(a.page, 1, name), state(b.page, 1, name)]).toEqual(["pending", "pending"]);
    // The request goes through the rules given last.
    expect([left.calls, right.calls].map(calls => calls.length)).toEqual([0, 1]);
    right.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(left.read).toHaveBeenCalledOnce());
    expect(right.read).toHaveBeenCalledOnce();
    expect(left.confirmed).toHaveBeenCalledOnce(); expect(right.confirmed).toHaveBeenCalledOnce();
    expect(right.onNotice).not.toHaveBeenCalled();
    // Each page shows the confirmed value until its own read shows it. This read finds the record changed again since.
    a.page.readShown(a.page.readStarted(), [row(1, 5)]);
    expect([state(a.page, 1, name), state(b.page, 1, name)]).toEqual([undefined, "pending"]);
    // A change from the page that has not read yet goes with the newest version any page has read, not its own old one.
    b.queue.enqueue(edit(row(1, 2), amount, 9));
    expect(right.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 5, values: { amount: 9 } });
  });

  it("goes on sending with no page open, reports to the shell, and sends nothing while offline", async () => {
    const rules = host(), { queue, page, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    close();
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    expect(rules.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People");
    expect(rules.confirmed).not.toHaveBeenCalled(); expect(rules.read).not.toHaveBeenCalled();
    rules.calls[1]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(rules.onError).toHaveBeenCalledOnce());
    expect(rules.onError.mock.calls[0]).toEqual(["dohc could not confirm the change to People. Open it to check its records.", expect.objectContaining({ message: "Lost reply" }), expect.any(Function), expect.any(String)]);
    // The row's Try again sends nothing while the Collection is offline.
    page.sync({ ...rules, offline: true });
    (rules.onError.mock.calls[0]![2] as () => void)();
    expect(rules.calls).toHaveLength(2);
    page.sync({ ...rules, offline: false });
    (rules.onError.mock.calls[0]![2] as () => void)();
    expect(rules.calls[2]!.request).toEqual(rules.calls[1]!.request);
    // Once it saves, the row its failure left in Notices goes.
    rules.calls[2]!.answer.resolve({ result: { id: 1, version: 4 } });
    await vi.waitFor(() => expect(rules.onSettled).toHaveBeenLastCalledWith(rules.onError.mock.calls[0]![3]));
    expect(rules.onNotice).toHaveBeenCalledTimes(2);
  });

  it("drops a change its host refuses for replaced rules, and asks each open page to describe the Collection again", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    rules.calls[0]!.answer.reject(new Error("Error invoking remote method 'desktop:dataset': DatasetHostError [conflict]: The Collection's rules changed. Its owner must approve this access again."));
    await vi.waitFor(() => expect(rules.describe).toHaveBeenCalledOnce());
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "refused", value: "Alicia" });
    expect(rules.onError).toHaveBeenCalledExactlyOnceWith("The Collection's rules changed. Check the records before making another change.", expect.any(Error), null);
    // The record's next change waits for a read.
    queue.enqueue(edit(row(1, 2), amount, 9));
    expect(rules.calls).toHaveLength(1);
  });

  it("leaves the list of queues once no page is open and it holds no change and no value", async () => {
    const rules = host(), first = open(rules);
    expect(hasWriteQueueForTests(scope)).toBe(true);
    first.close();
    expect(hasWriteQueueForTests(scope)).toBe(false);

    // A change in flight keeps it after its page closes, until the answer.
    const second = open(rules);
    expect(second.queue).not.toBe(first.queue);
    second.queue.enqueue(edit(row(1, 2), name, "Alicia"));
    second.close();
    expect(hasWriteQueueForTests(scope)).toBe(true);
    expect(writeQueueFor(scope)).toBe(second.queue);
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(hasWriteQueueForTests(scope)).toBe(false));

    // A value kept for the person keeps it until they dismiss the value, even one kept after the page closed.
    const third = open(rules);
    third.close();
    third.queue.hold(row(1, 2), name, "typed", "This edit was still open, so dohc did not save it.");
    expect(writeQueueFor(scope)).toBe(third.queue);
    third.queue.dismiss("1", "name");
    expect(hasWriteQueueForTests(scope)).toBe(false);
  });

  it("drops a request sent under old rules when a page gives new ones, and checks an unsent change against them when it goes", async () => {
    const rules = host(), { queue, page } = open(rules);
    const sent = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(2, 4), amount, 9));
    const next = { ...rules, revision: 2, revisionSha256: "b".repeat(64), fields: [name, member] };
    page.sync(next);
    queue.rulesChanged();
    expect(queue.find(sent)).toBeUndefined();
    expect(page.statuses.get("1", "name")).toMatchObject({ state: "refused", value: "Alicia" });
    expect(page.statuses.get("2", "amount")).toMatchObject({ state: "refused", reason: "This field was removed, so dohc did not save this value." });
    // The old request's late answer changes nothing.
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalled());
    expect(rules.confirmed).not.toHaveBeenCalled();
    expect(rules.calls).toHaveLength(1);
  });
});
