import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { deferred, type Deferred } from "../testing/deferred";
import type { TransactionalField } from "./transactionalCollectionModel";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";
import { admitCollectionChanges, openCollectionChangeShell } from "./collectionChangeShells";
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

/** The rules a test's page has other than the usual ones. */
type Rules = Partial<Pick<WriteQueueHost, "primaryKeyFieldId" | "revision" | "revisionSha256" | "fields" | "operations">>;
/** A page's rules and handlers. Each request waits in `calls` for the test to answer it. */
function host(overrides: Rules = {}) {
  const calls: Array<{ request: TransactionalInvoke; answer: Answer }> = [];
  const invoke = vi.fn((request: TransactionalInvoke) => { const answer: Answer = deferred(); calls.push({ request, answer }); return answer.promise; });
  const given = { workspaceId: "workspace", datasetId: "collection", revision: 1, revisionSha256: "a".repeat(64), tableName: "People", fields: [name, amount, member], primaryKeyFieldId: "member" as string | undefined,
    operations, offline: false, invoke, onError: vi.fn(), onSettled: vi.fn(), confirmed: vi.fn(), dropped: vi.fn(() => false), unconfirmed: vi.fn(), read: vi.fn(), describe: vi.fn(), ...overrides };
  const inputs = (operationId: string) => calls.filter(call => call.request.operationId === operationId).map(call => call.request.input);
  return { ...given, calls, inputs };
}
/** The toast and Notices of a workspace's open shell. */
const shellReports = () => ({ onError: vi.fn(), onSettled: vi.fn(), onNotice: vi.fn() });
/** Opens the workspace's shell, as the window does when it shows the workspace. Main has not admitted its session yet. Returns its reports, what admits it, and what closes it. */
function mountShell(workspaceId = "workspace") {
  const reports = shellReports(), close = openCollectionChangeShell(workspaceId, reports);
  return { ...reports, admit: () => admitCollectionChanges(workspaceId), close };
}
/** Opens the workspace's shell and admits its session, as the window does once main has opened the workspace. */
function openShell(workspaceId = "workspace") {
  const mounted = mountShell(workspaceId);
  mounted.admit();
  return mounted;
}
// The window shows the pages' workspace unless a test closes its shell.
let shell: ReturnType<typeof openShell>;
beforeEach(() => { shell = openShell(); });
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
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledOnce());
    expect(shell.onError.mock.calls[0]).toEqual(["dohc could not read record 1 in People, so its changes are waiting.", expect.objectContaining({ message: "Offline" }), expect.any(Function), expect.any(String)]);
    expect(page.statuses.get("1", "amount")).toMatchObject({ state: "waiting", reason: "Waiting for dohc to read this record again" });
    expect(queue.attention()).toEqual([expect.objectContaining({ kind: "waiting", reason: "Waiting for dohc to read this record again" })]);
    (shell.onError.mock.calls[0]![2] as () => void)();
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
    // Both pages are on one revision, so the request goes through the rules of the page that gave them first.
    expect([left.calls, right.calls].map(calls => calls.length)).toEqual([1, 0]);
    left.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(left.read).toHaveBeenCalledOnce());
    expect(right.read).toHaveBeenCalledOnce();
    expect(left.confirmed).toHaveBeenCalledOnce(); expect(right.confirmed).toHaveBeenCalledOnce();
    expect(shell.onNotice).not.toHaveBeenCalled();
    // Each page shows the confirmed value until its own read shows it. This read finds the record changed again since.
    a.page.readShown(a.page.readStarted(), [row(1, 5)]);
    expect([state(a.page, 1, name), state(b.page, 1, name)]).toEqual([undefined, "pending"]);
    // A change from the page that has not read yet goes with the newest version any page has read, not its own old one.
    b.queue.enqueue(edit(row(1, 2), amount, 9));
    expect(left.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 5, values: { amount: 9 } });
  });

  it("goes on sending with no page open, and reports to the open shell of its workspace", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    close();
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    expect(shell.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People");
    expect(rules.confirmed).not.toHaveBeenCalled(); expect(rules.read).not.toHaveBeenCalled();
    rules.calls[1]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledOnce());
    expect(shell.onError.mock.calls[0]).toEqual(["dohc could not confirm the change to People. Open it to check its records.", expect.objectContaining({ message: "Lost reply" }), expect.any(Function), expect.any(String)]);
    // Nothing went to the closed page's own handlers.
    expect([rules.onError, rules.onSettled].map(report => report.mock.calls.length)).toEqual([0, 0]);
    // The row's Try again sends the exact request, and once it saves, the row goes.
    (shell.onError.mock.calls[0]![2] as () => void)();
    expect(rules.calls[2]!.request).toEqual(rules.calls[1]!.request);
    rules.calls[2]!.answer.resolve({ result: { id: 1, version: 4 } });
    await vi.waitFor(() => expect(shell.onSettled).toHaveBeenLastCalledWith(shell.onError.mock.calls[0]![3]));
    expect(shell.onNotice).toHaveBeenCalledTimes(2);
  });

  it("sends nothing from a Notices row while the Collection is offline and no page is open, and sends once a page has it online again", async () => {
    const rules = host(), first = open(rules);
    const lost = first.queue.enqueue(edit(row(1, 2), name, "Alicia"));
    first.close();
    rules.calls[0]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledOnce());
    const retry = shell.onError.mock.calls[0]![2] as () => void;
    // A page opens, learns the Collection is offline, and closes.
    const offline = open({ ...rules, offline: true });
    offline.close();
    retry();
    expect(rules.calls).toHaveLength(1);
    expect(first.queue.find(lost)?.state).toBe("unconfirmed");
    // A page opens with the Collection online, and closes. The row's Try again now sends the exact request.
    open(rules).close();
    retry();
    expect(rules.calls[1]!.request).toEqual(rules.calls[0]!.request);
  });

  it("drops a change its host refuses with no page open because the rules changed elsewhere, and says so in Notices", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    close();
    const replaced = () => new Error("Error invoking remote method 'desktop:dataset': DatasetHostError [conflict]: The Collection's rules changed. Its owner must approve this access again.");
    // No page is open to learn the new rules, so the next change goes under the old ones too, and is refused the same way.
    rules.calls[0]!.answer.reject(replaced());
    await vi.waitFor(() => expect(rules.calls).toHaveLength(2));
    rules.calls[1]!.answer.reject(replaced());
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledTimes(2));
    for (const call of shell.onError.mock.calls) expect(call).toEqual(["The rules of People changed, so dohc did not save the change. Open it to check its records.", expect.any(Error), null]);
    expect(queue.size).toBe(0);
    // What was typed stays for the person, on its cells when a page opens.
    const again = open(rules);
    expect([state(again.page, 1, name), state(again.page, 2, name)]).toEqual(["refused", "refused"]);
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

describe("the rules of a table open at two revisions", () => {
  const tags: TransactionalField = { fieldId: "tags", name: "Tags", type: "text", required: false, unique: false };
  /** The next revision: it adds Tags, which the edit operation takes, and removes Amount. */
  const revised = (): Rules => ({ revision: 2, revisionSha256: "b".repeat(64), fields: [name, member, tags],
    operations: [operation("read", "read", ["name", "member", "tags"]), operation("edit", "edit", ["name", "tags"]), operation("create", "create", ["name"]), operation("delete", "delete", [])] });

  it("keeps the newer revision's rules when the page on the older one draws again, so an edit to a field only the newer one has still sends", async () => {
    const old = host(), next = host(revised());
    const a = open(old), b = open(next);
    // The older page draws again, and gives its rules again.
    a.page.sync(old);
    b.queue.enqueue(edit(row(1, 2), tags, "vip"), b.page);
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]!.request).toMatchObject({ revision: 2, revisionSha256: "b".repeat(64), input: { id: 1, expectedVersion: 2, values: { tags: "vip" } } });
    expect(state(b.page, 1, tags)).toBe("pending");
    // The older page's edit to a field the newer rules removed is checked against them, and its cell says why it did not save.
    a.queue.enqueue(edit(row(2, 4), amount, 9), a.page);
    next.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(state(a.page, 2, amount)).toBe("refused"));
    expect(a.page.statuses.get("2", "amount")).toMatchObject({ value: 9, reason: "This field was removed, so dohc did not save this value." });
    expect([old.calls, next.calls].map(calls => calls.length)).toEqual([0, 1]);
  });

  it("keeps the newer rules once only the page on the older revision is open, until that page has the newer revision too", async () => {
    const old = host(), next = host(revised());
    const a = open(old), b = open(next);
    b.close();
    a.page.sync(old);
    a.queue.enqueue(edit(row(1, 2), name, "Alicia"), a.page);
    // The change goes under the newest rules any page has given, as the page that gave them sent.
    expect(next.calls[0]!.request).toMatchObject({ revision: 2, input: { id: 1, expectedVersion: 2, values: { name: "Alicia" } } });
    expect(old.calls).toHaveLength(0);
    // The open page reads the newer revision, and the queue's rules are that page's from then on.
    const caught = host(revised());
    a.page.sync(caught);
    a.queue.enqueue(edit(row(2, 4), tags, "vip"), a.page);
    next.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(caught.calls).toHaveLength(1));
    expect(caught.calls[0]!.request).toMatchObject({ revision: 2, input: { id: 2, expectedVersion: 4, values: { tags: "vip" } } });
    expect(old.calls).toHaveLength(0);
  });

  it("lets the page that gave the rules change them, and no page on an older revision", () => {
    const old = host(), next = host(revised());
    const a = open(old), b = open(next);
    b.page.sync({ ...next, offline: true });
    b.queue.enqueue(edit(row(1, 2), name, "Alicia"), b.page);
    expect(b.page.statuses.get("1", "name")).toMatchObject({ state: "waiting", reason: "Waiting for the Collection to come back online" });
    // The older page can't say the Collection is back online.
    a.page.sync(old);
    expect([old.calls, next.calls].map(calls => calls.length)).toEqual([0, 0]);
    b.page.sync(next);
    expect([old.calls, next.calls].map(calls => calls.length)).toEqual([0, 1]);
  });
});

describe("a read of one record that a newer read has answered", () => {
  it.each([
    ["an older version of the record", { rows: [row(1, 3)], nextCursor: null }],
    ["no record", { rows: [], nextCursor: null }],
  ])("changes nothing when it returns %s", async (_returned, answer) => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    // The receipt reports no version, and the page's read leaves the record out, so the queue reads it by its key.
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalled());
    page.readShown(page.readStarted(), []);
    expect(rules.inputs("read")).toHaveLength(1);
    // A newer read by the page returns the record at version 8 before the queue's own read answers.
    page.readShown(page.readStarted(), [row(1, 8)]);
    expect(rules.inputs("edit")).toHaveLength(1);
    rules.calls[1]!.answer.resolve({ result: answer });
    await vi.waitFor(() => expect(rules.inputs("edit")).toHaveLength(2));
    expect(rules.inputs("edit")[1]).toEqual({ id: 1, expectedVersion: 8, values: { amount: 9 } });
    expect(state(page, 1, amount)).toBe("pending");
    expect(queue.attention()).toEqual([]);
  });
});

describe("a new record the Collection refuses while two pages are open", () => {
  const create = (queue: ReturnType<typeof open>["queue"], from: ReturnType<typeof open>["page"]) =>
    queue.enqueue({ kind: "create", record: null, operationId: "create", values: { name: { value: "Bob", under: name } }, label: "Created a record" }, from);
  const REFUSED = "The Collection refused this change. Name is taken.";

  it.each([["first", 0], ["second", 1]] as const)("tells the %s page, which made it, and not the other", async (_which, maker) => {
    const hosts = [host(), host()];
    // Each page would take the record: the one that made it into its open form, the other into a form it opens again.
    for (const given of hosts) given.dropped.mockReturnValue(true);
    const views = hosts.map(given => open(given));
    const id = create(views[0]!.queue, views[maker]!.page);
    hosts[0]!.calls[0]!.answer.reject(refusal("Name is taken."));
    await vi.waitFor(() => expect(hosts[maker]!.dropped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), REFUSED, true));
    expect(hosts[1 - maker]!.dropped).not.toHaveBeenCalled();
    expect(views[0]!.queue.attention()).toEqual([]);
  });

  it("keeps the record in the list when the page that made it can't show it, and offers it to no other page", async () => {
    const left = host(), right = host();
    right.dropped.mockReturnValue(true);
    const a = open(left);
    open(right);
    const id = create(a.queue, a.page);
    left.calls[0]!.answer.reject(refusal("Name is taken."));
    await vi.waitFor(() => expect(a.queue.attention()).toEqual([{ kind: "record", id, values: { name: { value: "Bob", under: name } }, reason: REFUSED }]));
    expect(left.dropped).toHaveBeenCalledOnce();
    expect(right.dropped).not.toHaveBeenCalled();
  });

  it("offers it to the other page once the page that made it has closed", async () => {
    const left = host(), right = host();
    right.dropped.mockReturnValue(true);
    const a = open(left);
    open(right);
    const id = create(a.queue, a.page);
    a.close();
    left.calls[0]!.answer.reject(refusal("Name is taken."));
    await vi.waitFor(() => expect(right.dropped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), REFUSED, true));
    expect(left.dropped).not.toHaveBeenCalled();
  });
});

describe("while the window shows another workspace", () => {
  it("sends nothing and reports no failure, and goes on when its workspace's shell opens again with no page open", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    const waiting = queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    // The window switches workspace: this workspace's shell closes, then its pages, and the other's shell opens.
    shell.close();
    close();
    const other = openShell("other");
    // The change in flight is confirmed. The next one waits unsent, and is no failure.
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(queue.size).toBe(1));
    expect(rules.calls).toHaveLength(1);
    expect(queue.find(waiting)?.state).toBe("queued");
    for (const reports of [shell, other]) expect([reports.onError, reports.onNotice].map(report => report.mock.calls.length)).toEqual([0, 0]);
    expect(rules.onError).not.toHaveBeenCalled();
    // The window shows the workspace again. No page of the table opens, and the change goes.
    other.close();
    const back = openShell();
    expect(rules.calls[1]!.request.input).toEqual({ id: 2, expectedVersion: 4, values: { name: "Beatrice" } });
    expect(back.onError).not.toHaveBeenCalled();
    rules.calls[1]!.answer.resolve({ result: { id: 2, version: 5 } });
    await vi.waitFor(() => expect(back.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People"));
    expect(other.onNotice).not.toHaveBeenCalled();
  });

  it("files one row in Notices, with Try again, for a table whose change could not be confirmed meanwhile", async () => {
    const rules = host(), { queue, close } = open(rules);
    const lost = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    shell.close();
    close();
    // Main refuses the change in flight as the window leaves the workspace.
    rules.calls[0]!.answer.reject(new Error("Collection changes stopped because this window changed workspaces."));
    await vi.waitFor(() => expect(queue.find(lost)?.state).toBe("unconfirmed"));
    expect(shell.onError).not.toHaveBeenCalled();
    // The workspace's shell opens again: one row for the table, for the change dohc could not confirm and the one that waits behind it.
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("dohc could not confirm a change to People. Another change is waiting. Open it to check its records.", expect.any(Error), expect.any(Function), expect.any(String));
    const [, , retry, identity] = back.onError.mock.calls[0]!;
    // Try again sends the exact request, and the row goes once nothing needs the person.
    (retry as () => void)();
    expect(rules.calls[1]!.request).toEqual(rules.calls[0]!.request);
    expect(back.onSettled).toHaveBeenCalledWith(identity);
    rules.calls[1]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(rules.calls).toHaveLength(3));
    expect(rules.calls[2]!.request.input).toEqual({ id: 1, expectedVersion: 3, values: { amount: 9 } });
  });

  it("files a row with no Try again for a table that holds only values dohc did not save, in its own workspace's Notices", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    shell.close();
    close();
    const other = openShell("other");
    // The Collection's refusal answers after the window left: no shell of this workspace is open to hear it.
    rules.calls[0]!.answer.reject(refusal("No."));
    await vi.waitFor(() => expect(queue.attention()).toHaveLength(1));
    expect([shell, other].map(reports => [reports.onError, reports.onNotice, reports.onSettled].map(report => report.mock.calls.length))).toEqual([[0, 0, 0], [0, 0, 0]]);
    other.close();
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("dohc did not save a change to People. Open it to check its records.", expect.any(Error), null, expect.any(String));
    expect(other.onError).not.toHaveBeenCalled();
    // The row goes once the person has cleared the value.
    queue.dismiss("1", "name");
    expect(back.onSettled).toHaveBeenCalledExactlyOnceWith(back.onError.mock.calls[0]![3]);
  });

  it("files no row for a table whose changes only wait to be sent", () => {
    const rules = host(), { queue, close } = open(rules);
    shell.close();
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    close();
    expect(rules.calls).toHaveLength(0);
    const back = openShell();
    expect(back.onError).not.toHaveBeenCalled();
    expect(rules.calls).toHaveLength(1);
  });

  it("keeps the table's row in Notices after its Try again, for the value dohc did not save, until the person clears that value", async () => {
    const rules = host(), { queue, close } = open(rules);
    const lost = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.hold(row(2, 4), name, "typed", "This edit was still open, so dohc did not save it.");
    shell.close();
    close();
    rules.calls[0]!.answer.reject(new Error("Collection changes stopped because this window changed workspaces."));
    await vi.waitFor(() => expect(queue.find(lost)?.state).toBe("unconfirmed"));
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("dohc could not confirm a change to People, and did not save 1 more. Open it to check its records.", expect.any(Error), expect.any(Function), expect.any(String));
    const [, , retry, identity] = back.onError.mock.calls[0]!;
    // Try again sends the change. The row stays, changed where it stands, for the value that still needs the person.
    (retry as () => void)();
    expect(rules.calls[1]!.request).toEqual(rules.calls[0]!.request);
    expect(back.onError).toHaveBeenLastCalledWith("dohc did not save a change to People. Open it to check its records.", expect.any(Error), null, identity, true);
    rules.calls[1]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(back.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People"));
    expect(back.onError).toHaveBeenCalledTimes(2);
    expect(back.onSettled).not.toHaveBeenCalledWith(identity);
    // The row goes once nothing needs the person.
    queue.dismiss("2", "name");
    expect(back.onSettled).toHaveBeenCalledWith(identity);
  });

  it("leaves a change out of the table's row once it has a row of its own, so a change that fails again is said once", async () => {
    const rules = host(), { queue, close } = open(rules);
    const lost = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.hold(row(2, 4), name, "typed", "This edit was still open, so dohc did not save it.");
    shell.close();
    close();
    rules.calls[0]!.answer.reject(new Error("Collection changes stopped because this window changed workspaces."));
    await vi.waitFor(() => expect(queue.find(lost)?.state).toBe("unconfirmed"));
    const back = openShell();
    (back.onError.mock.calls[0]![2] as () => void)();
    rules.calls[1]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(queue.find(lost)?.state).toBe("unconfirmed"));
    // The change has its own row, with Try again. The table's row still counts only the value.
    expect(back.onError.mock.calls.map(([words]) => words)).toEqual([
      "dohc could not confirm a change to People, and did not save 1 more. Open it to check its records.",
      "dohc did not save a change to People. Open it to check its records.",
      "dohc could not confirm the change to People. Open it to check its records.",
    ]);
  });
});

describe("until main has admitted the workspace's session", () => {
  it("sends nothing while the workspace's shell is open, marks nothing unconfirmed, and sends with no page open once main admits it", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    const waiting = queue.enqueue(edit(row(2, 4), name, "Beatrice"));
    shell.close();
    close();
    // The window shows the workspace again. Its shell is open, and main still holds the other workspace's session.
    const back = mountShell();
    // The change that was in flight is confirmed meanwhile. The next one stays unsent, and is no failure.
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(queue.size).toBe(1));
    expect(rules.calls).toHaveLength(1);
    expect(queue.find(waiting)?.state).toBe("queued");
    expect(queue.attention()).toEqual([]);
    expect(back.onError).not.toHaveBeenCalled();
    // Main admits the session, and the change goes.
    back.admit();
    expect(rules.calls[1]!.request.input).toEqual({ id: 2, expectedVersion: 4, values: { name: "Beatrice" } });
    expect(back.onError).not.toHaveBeenCalled();
  });

  it("admits only the open shell, when the shell's effects run twice as in development, and stops sending when the admission ends", async () => {
    const rules = host(), { queue, close } = open(rules);
    shell.close();
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    close();
    // The shell opens, closes, and opens again. The first one's close runs once more, late.
    const first = mountShell();
    first.close();
    const second = mountShell();
    first.close();
    // An admission of the shell that closed admits nothing.
    expect(rules.calls).toHaveLength(0);
    const end = second.admit();
    expect(rules.calls).toHaveLength(1);
    expect(second.onError).not.toHaveBeenCalled();
    rules.calls[0]!.answer.resolve({ result: { id: 1, version: 3 } });
    await vi.waitFor(() => expect(second.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People"));
    // The admission ends, as when the shell opens the workspace again, and a change made then waits.
    end();
    const next = writeQueueFor(scope), page = next.page();
    page.sync(rules);
    const closeNext = page.open();
    next.enqueue(edit(row(2, 4), name, "Beatrice"));
    closeNext();
    expect(rules.calls).toHaveLength(1);
    second.admit();
    expect(rules.calls).toHaveLength(2);
    expect(first.onError).not.toHaveBeenCalled();
    expect(second.onError).not.toHaveBeenCalled();
  });
});

describe("a record the queue can't read by a key", () => {
  const LOOK_UP = "dohc could not look up record 1 in People, so its changes are waiting. Open People and find the record.";

  it("says in Notices that the record's changes wait, when main admits the workspace with no page open", async () => {
    const rules = host({ primaryKeyFieldId: undefined }), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    shell.close();
    close();
    // The first change's receipt reports no version while the window shows another workspace.
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(queue.size).toBe(1));
    const back = openShell();
    expect(rules.calls).toHaveLength(1);
    // No Try again: only a page's read can return the record.
    expect(back.onError).toHaveBeenCalledExactlyOnceWith(LOOK_UP, expect.any(Error), null, expect.any(String));
    expect(queue.attention()).toEqual([expect.objectContaining({ kind: "waiting", reason: "Waiting for dohc to read this record again" })]);
    // A page opens and its read returns the record. The change goes, and the row goes.
    const again = open(rules);
    again.page.readShown(again.page.readStarted(), [row(1, 6)]);
    expect(rules.calls[1]!.request.input).toEqual({ id: 1, expectedVersion: 6, values: { amount: 9 } });
    expect(rules.onSettled).toHaveBeenCalledWith(back.onError.mock.calls[0]![3]);
  });

  it("says so too when a receipt reports no version after the table's page closed", async () => {
    const rules = host({ primaryKeyFieldId: undefined }), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    close();
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledOnce());
    expect(shell.onError.mock.calls[0]).toEqual([LOOK_UP, expect.any(Error), null, expect.any(String)]);
    expect(rules.calls).toHaveLength(1);
  });

  it("says so in Notices when the page that showed the record's changes waiting closes", async () => {
    const rules = host({ primaryKeyFieldId: undefined }), { queue, page, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalledOnce());
    // The page's read leaves the record out, and the page shows that its change waits.
    page.readShown(page.readStarted(), []);
    expect(state(page, 1, amount)).toBe("waiting");
    expect([rules.onError, shell.onError].map(report => report.mock.calls.length)).toEqual([0, 0]);
    close();
    expect(shell.onError).toHaveBeenCalledExactlyOnceWith(LOOK_UP, expect.any(Error), null, expect.any(String));
  });

  it("counts a record whose read failed while the window showed another workspace in the table's row, with Try again", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue(edit(row(1, 2), amount, 9));
    close();
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.inputs("read")).toHaveLength(1));
    // The window leaves the workspace, and main refuses the read in flight.
    shell.close();
    rules.calls[1]!.answer.reject(new Error("Collection changes stopped because this window changed workspaces."));
    await vi.waitFor(() => expect(queue.attention()).toHaveLength(1));
    expect(shell.onError).not.toHaveBeenCalled();
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("A change to People is waiting. Open it to check its records.", expect.any(Error), expect.any(Function), expect.any(String));
    (back.onError.mock.calls[0]![2] as () => void)();
    rules.calls[2]!.answer.resolve({ result: { rows: [row(1, 8)], nextCursor: null } });
    await vi.waitFor(() => expect(rules.inputs("edit")).toHaveLength(2));
    expect(rules.inputs("edit")[1]).toEqual({ id: 1, expectedVersion: 8, values: { amount: 9 } });
    expect(back.onSettled).toHaveBeenCalledWith(back.onError.mock.calls[0]![3]);
  });
});

describe("a deletion that did not happen", () => {
  const RULES_CHANGED = "The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.";
  const replaced = () => new Error("Error invoking remote method 'desktop:dataset': DatasetHostError [conflict]: The Collection's rules changed. Its owner must approve this access again.");

  it.each([
    ["the Collection refuses it", () => refusal("Paid records stay."), "The Collection refused this change. Paid records stay."],
    ["its host refuses it for replaced rules", replaced, RULES_CHANGED],
  ])("is kept when %s with no page and no shell open, and the table's row counts and names it when the window returns", async (_when, cause, reason) => {
    const rules = host(), { queue, close } = open(rules);
    const gone = queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    shell.close();
    close();
    rules.calls[0]!.answer.reject(cause());
    await vi.waitFor(() => expect(queue.attention()).toEqual([{ kind: "deletion", id: gone, recordId: 1, name: "Alice", reason }]));
    expect(shell.onError).not.toHaveBeenCalled();
    expect(writeQueueFor(scope)).toBe(queue);
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("dohc did not delete Alice from People. Open it to check its records.", expect.any(Error), null, expect.any(String));
    // Dismiss lets it go, and the row and the queue with it.
    queue.dismissDeletion(gone);
    expect(back.onSettled).toHaveBeenCalledExactlyOnceWith(back.onError.mock.calls[0]![3]);
    expect(hasWriteQueueForTests(scope)).toBe(false);
  });

  it("is named by its record's id when the page gave no name, counted with the others, and replaced by a new deletion of its record", async () => {
    const rules = host(), { queue, close } = open(rules);
    queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    queue.enqueue({ kind: "delete", record: row(2, 4), operationId: "delete", label: "Deleted the record" });
    queue.hold(row(3, 1), name, "typed", "This edit was still open, so dohc did not save it.");
    shell.close();
    close();
    rules.calls[0]!.answer.reject(refusal("No."));
    await vi.waitFor(() => expect(rules.calls).toHaveLength(1));
    await vi.waitFor(() => expect(queue.attention().filter(item => item.kind === "deletion")).toHaveLength(1));
    const back = openShell();
    expect(back.onError).toHaveBeenCalledExactlyOnceWith("dohc did not save a change to People, and did not delete Alice. Open it to check its records.", expect.any(Error), null, expect.any(String));
    rules.calls[1]!.answer.reject(refusal("No."));
    await vi.waitFor(() => expect(back.onError).toHaveBeenLastCalledWith("dohc did not save a change to People, and did not delete Alice and 1 other record. Open it to check its records.", expect.any(Error), null, back.onError.mock.calls[0]![3], true));
    expect(queue.attention().filter(item => item.kind === "deletion").map(item => item.name)).toEqual(["Alice", "record 2"]);
    // The person deletes the first record again, and that deletion is no longer one that did not happen.
    queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    expect(queue.attention().filter(item => item.kind === "deletion").map(item => item.name)).toEqual(["record 2"]);
  });

  it("keeps a deletion the rules stopped allowing before it was sent, and nothing of one sent before them, which may have happened", () => {
    const rules = host(), { queue, page } = open(rules);
    // The first deletion is with the host. The second is not sent yet.
    const sent = queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    const unsent = queue.enqueue({ kind: "delete", record: row(2, 4), name: "Bea", operationId: "delete", label: "Deleted the record" });
    // New rules take the delete operation away.
    page.sync({ ...rules, revision: 2, revisionSha256: "b".repeat(64), operations: operations.filter(candidate => candidate.kind !== "delete") });
    queue.rulesChanged();
    expect([queue.find(sent), queue.find(unsent)]).toEqual([undefined, undefined]);
    expect(queue.attention()).toEqual([{ kind: "deletion", id: unsent, recordId: 2, name: "Bea", reason: "The Collection's rules no longer allow this change, so dohc did not save it." }]);
  });

  it("keeps nothing of a deletion dohc could not confirm once the person discards it, since it may have happened", async () => {
    const rules = host(), { queue } = open(rules);
    const lost = queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    rules.calls[0]!.answer.reject(new Error("Lost reply"));
    await vi.waitFor(() => expect(queue.find(lost)?.state).toBe("unconfirmed"));
    queue.discard(lost);
    expect(queue.attention()).toEqual([]);
  });

  it("keeps nothing of a deletion whose record is already gone", async () => {
    const rules = host(), { queue, page } = open(rules);
    queue.enqueue(edit(row(1, 2), name, "Alicia"));
    queue.enqueue({ kind: "delete", record: row(1, 2), name: "Alice", operationId: "delete", label: "Deleted the record" });
    rules.calls[0]!.answer.resolve({ result: null });
    await vi.waitFor(() => expect(rules.read).toHaveBeenCalled());
    page.readShown(page.readStarted(), []);
    rules.calls[1]!.answer.resolve({ result: { rows: [], nextCursor: null } });
    await vi.waitFor(() => expect(queue.size).toBe(0));
    expect(queue.attention()).toEqual([]);
  });
});

describe("a Collection whose folder moved while its page was closed", () => {
  it("tells the person that the change sent through the closed page failed, and sends it through a page opened at the new folder", async () => {
    const rules = host(), { queue, close } = open(rules);
    const moved = queue.enqueue(edit(row(1, 2), name, "Alicia"));
    close();
    // The closed page's request names the folder the Collection was in, where main finds none.
    rules.calls[0]!.answer.reject(new Error("Error invoking remote method 'desktop:dataset': Error: Collection reference broken: budget/dataset.json. Choose its current dataset.json path."));
    await vi.waitFor(() => expect(shell.onError).toHaveBeenCalledOnce());
    expect(shell.onError.mock.calls[0]).toEqual(["dohc could not confirm the change to People. Open it to check its records.",
      expect.objectContaining({ message: expect.stringContaining("Collection reference broken: budget/dataset.json.") }), expect.any(Function), expect.any(String)]);
    expect(queue.find(moved)?.state).toBe("unconfirmed");
    // The Collection opens at its new folder. That page's requests reach it, and Try again sends the change through them.
    const reopened = host();
    open(reopened);
    queue.retry(moved);
    expect(reopened.calls[0]!.request).toEqual(rules.calls[0]!.request);
    expect(rules.calls).toHaveLength(1);
  });
});
