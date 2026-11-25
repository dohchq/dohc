import type {
  TransactionalDatasetDescription,
  TransactionalInvoke,
} from "../../desktop/src/renderer/TransactionalCollectionPage";

type AppBackendJson = TransactionalInvoke["input"];

const id = (n: number) => `0d0c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const GUESTS_DATASET_PATH = "guests/dataset.json";
export const GUESTS_TABLE_ID = id(2);

const recordId = id(10);
const name = id(11);
const arrives = id(12);
const room = id(13);
const paid = id(14);
const note = id(15);

const read = id(20);
const create = id(21);
const edit = id(22);
const remove = id(23);

const FIELD_IDS = [recordId, name, arrives, room, paid, note];
const WRITABLE = [name, arrives, room, paid, note];
const ROOMS = ["Alfama flat", "Sintra cottage", "Not booked"];

export const GUESTS_DATASET: TransactionalDatasetDescription = {
  datasetId: id(1),
  name: "Guests",
  revision: 1,
  revisionSha256: "d".repeat(64),
  tables: [
    {
      tableId: GUESTS_TABLE_ID,
      name: "Guests",
      primaryKeyFieldId: recordId,
      fields: [
        {
          fieldId: recordId,
          name: "Record ID",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        { fieldId: name, name: "Name", type: "text", required: true, unique: false },
        { fieldId: arrives, name: "Arrives", type: "date", required: false, unique: false },
        {
          fieldId: room,
          name: "Room",
          type: "select",
          options: ROOMS,
          required: true,
          unique: false,
          default: "Not booked",
        },
        {
          fieldId: paid,
          name: "Paid",
          type: "checkbox",
          required: false,
          unique: false,
          default: false,
        },
        { fieldId: note, name: "Note", type: "text", required: false, unique: false },
      ],
    },
  ],
  operations: [
    {
      operationId: read,
      name: "list",
      label: "Read",
      kind: "read",
      access: "owner",
      readOnly: true,
      tableId: GUESTS_TABLE_ID,
      fieldIds: FIELD_IDS,
    },
    {
      operationId: create,
      name: "create",
      label: "Create",
      kind: "create",
      access: "owner",
      readOnly: false,
      tableId: GUESTS_TABLE_ID,
      fieldIds: WRITABLE,
    },
    {
      operationId: edit,
      name: "edit",
      label: "Edit",
      kind: "edit",
      access: "owner",
      readOnly: false,
      reversible: true,
      tableId: GUESTS_TABLE_ID,
      fieldIds: WRITABLE,
    },
    {
      operationId: remove,
      name: "delete",
      label: "Delete",
      kind: "delete",
      access: "owner",
      readOnly: false,
      tableId: GUESTS_TABLE_ID,
      fieldIds: [],
    },
  ],
};

export type DemoRecord = {
  id: string;
  version: number;
  values: Record<string, AppBackendJson>;
};

function guest(
  n: number,
  who: string,
  date: string | null,
  where: string,
  deposit: boolean,
  words: string,
): DemoRecord {
  const key = id(100 + n);
  return {
    id: key,
    version: 1,
    values: {
      [recordId]: key,
      [name]: who,
      [arrives]: date,
      [room]: where,
      [paid]: deposit,
      [note]: words,
    },
  };
}

export const DEMO_GUESTS: readonly DemoRecord[] = [
  guest(1, "You", "2027-05-14", "Alfama flat", true, "Booking the flat"),
  guest(2, "Sam", "2027-05-14", "Alfama flat", true, "Same flight as you"),
  guest(3, "Priya", "2027-05-15", "Sintra cottage", false, "Lands at 9:40"),
  guest(4, "Jonas", "2027-05-15", "Sintra cottage", true, "Vegetarian"),
  guest(5, "Mei", "2027-05-16", "Not booked", false, "Joins for the weekend"),
];

function text(value: AppBackendJson | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compare(left: AppBackendJson | undefined, right: AppBackendJson | undefined): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return text(left).localeCompare(text(right));
}

function matches(value: AppBackendJson | undefined, wanted: AppBackendJson): boolean {
  if (Array.isArray(wanted)) return wanted.some((one) => matches(value, one));
  if (Array.isArray(value)) return value.some((one) => one === wanted);
  return value === wanted;
}

function input(request: TransactionalInvoke): Record<string, AppBackendJson> {
  const value = request.input;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The demo Collection got a request it doesn't take.");
  }
  return value;
}

function writable(values: AppBackendJson | undefined): Record<string, AppBackendJson> {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([field]) => WRITABLE.includes(field)));
}

function fields(value: AppBackendJson | undefined): Record<string, AppBackendJson> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const same = (left: AppBackendJson | undefined, right: AppBackendJson | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function readPage(
  records: readonly DemoRecord[],
  body: Record<string, AppBackendJson>,
): AppBackendJson {
  let rows = records;
  const search = typeof body.search === "string" ? body.search.trim().toLowerCase() : "";
  if (search) {
    rows = rows.filter((record) =>
      WRITABLE.some((field) => text(record.values[field]).toLowerCase().includes(search)),
    );
  }
  for (const filter of Array.isArray(body.filters) ? body.filters : []) {
    const wanted = fields(filter);
    if (wanted)
      rows = rows.filter((record) =>
        matches(record.values[String(wanted.fieldId)], wanted.value ?? null),
      );
  }
  const limit = Math.min(typeof body.limit === "number" ? body.limit : 50, 50);

  const groupBy = typeof body.groupBy === "string" ? body.groupBy : null;
  if (groupBy) {
    let groups = [...new Set(rows.map((record) => JSON.stringify(record.values[groupBy] ?? null)))]
      .map((value) => JSON.parse(value) as AppBackendJson)
      .sort(compare);
    const after = fields(body.groupAfter);
    if (after) groups = groups.slice(groups.findIndex((value) => same(value, after.value)) + 1);
    const page = groups.slice(0, limit);
    return {
      groupBy,
      groups: page,
      nextGroupCursor: groups.length > limit ? { value: page.at(-1) ?? null } : null,
    };
  }

  const group = fields(body.group);
  if (group)
    rows = rows.filter((record) => same(record.values[String(group.fieldId)], group.value));
  const range = fields(body.range);
  if (range) {
    rows = rows.filter((record) => {
      const date = record.values[String(range.fieldId)];
      return typeof date === "string" && date >= String(range.start) && date < String(range.end);
    });
  }
  const sort = fields(body.sort);
  if (sort) {
    const field = String(sort.fieldId);
    const direction = sort.direction === "desc" ? -1 : 1;
    rows = [...rows].sort(
      (left, right) => compare(left.values[field], right.values[field]) * direction,
    );
  }
  const after = fields(body.after);
  if (after) rows = rows.slice(rows.findIndex((record) => record.id === after.id) + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((record) => ({
      id: record.id,
      version: record.version,
      values: { ...record.values },
    })),
    nextCursor:
      rows.length > limit && last
        ? { id: last.id, value: sort ? (last.values[String(sort.fieldId)] ?? null) : last.id }
        : null,
    ...(group ? { group } : {}),
    ...(range ? { range } : {}),
  };
}

export function demoCollectionStore(
  initial: readonly DemoRecord[],
  save: (records: readonly DemoRecord[]) => void,
) {
  let records = initial.map((record) => ({ ...record, values: { ...record.values } }));
  const find = (key: AppBackendJson | undefined) => {
    const found = records.find((record) => record.id === key);
    if (!found) throw new Error("This record is no longer in this Collection.");
    return found;
  };
  const checkVersion = (record: DemoRecord, expected: AppBackendJson | undefined) => {
    if (expected !== record.version) {
      throw new Error("Someone changed this record first. Refresh to see it.");
    }
  };

  async function invoke(request: TransactionalInvoke): Promise<{ result: AppBackendJson }> {
    const body = input(request);
    switch (request.operationId) {
      case read:
        return { result: readPage(records, body) };
      case create: {
        const key = crypto.randomUUID();
        const values: Record<string, AppBackendJson> = {
          [recordId]: key,
          [arrives]: null,
          [room]: "Not booked",
          [paid]: false,
          [note]: "",
          ...writable(body.values),
        };
        if (!text(values[name]).trim()) throw new Error("A guest needs a name.");
        records = [...records, { id: key, version: 1, values }];
        save(records);
        return { result: { id: key, version: 1 } };
      }
      case edit: {
        const record = find(body.id);
        checkVersion(record, body.expectedVersion);
        const changes = writable(body.values);
        if (Object.hasOwn(changes, name) && !text(changes[name]).trim()) {
          throw new Error("A guest needs a name.");
        }
        const priorValues = Object.fromEntries(
          Object.keys(changes).map((field) => [field, record.values[field] ?? null]),
        );
        const next = {
          id: record.id,
          version: record.version + 1,
          values: { ...record.values, ...changes },
        };
        records = records.map((each) => (each.id === record.id ? next : each));
        save(records);
        return { result: { id: next.id, version: next.version, priorValues } };
      }
      case remove: {
        const record = find(body.id);
        checkVersion(record, body.expectedVersion);
        records = records.filter((each) => each.id !== record.id);
        save(records);
        return { result: { id: record.id } };
      }
      default:
        throw new Error("The demo Collection got a request it doesn't take.");
    }
  }

  return { invoke, records: () => records };
}

export function isDemoRecordList(value: unknown): value is DemoRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        typeof record.id === "string" &&
        Number.isSafeInteger(record.version) &&
        record.values !== null &&
        typeof record.values === "object",
    )
  );
}
