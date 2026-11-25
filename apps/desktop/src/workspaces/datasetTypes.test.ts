import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import { datasetTypes, datasetTypesPath, writeDatasetTypes } from "./datasetTypes";

const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin/tsc",
);

const definition = parseDatasetDefinition(
  {
    formatVersion: 2,
    datasetId: "11111111-1111-4111-8111-111111111101",
    name: "Books",
    tables: [
      {
        sqlName: "accounts",
        primaryKey: "id",
        fields: [
          { sqlColumn: "id", type: "number" },
          { sqlColumn: "name", type: "text", required: true },
        ],
      },
      {
        sqlName: "entries",
        primaryKey: "id",
        fields: [
          { sqlColumn: "id", type: "text" },
          { sqlColumn: "posted_on", type: "date", required: true },
          { sqlColumn: "memo", type: "text" },
          { sqlColumn: "cents", type: "number", required: true },
          { sqlColumn: "cleared", type: "checkbox", required: true },
          { sqlColumn: "kind", type: "select", required: true, options: ["debit", "credit"] },
          { sqlColumn: "tags", type: "multi-select", options: ["tax", "travel"] },
          {
            sqlColumn: "account",
            type: "relation",
            required: true,
            relation: { table: "accounts", field: "id" },
          },
          {
            sqlColumn: "splits",
            type: "relation",
            relation: { table: "entries", field: "id", many: true },
          },
          { name: "Reconcile", type: "button" },
        ],
      },
    ],
    operations: [
      { name: "listEntries", table: "entries", kind: "read", fields: ["id", "cents", "tags"] },
      {
        name: "addEntry",
        table: "entries",
        kind: "create",
        fields: ["posted_on", "cents", "account"],
      },
      { name: "deleteEntry", table: "entries", kind: "delete", access: "link", fields: [] },
      {
        name: "reconcile",
        table: "entries",
        kind: "action",
        readOnly: false,
        contract: {
          input: {
            object: {
              entryId: "string",
              kind: { enum: ["debit", "credit"] },
              note: { nullable: "string" },
              splits: { array: "number" },
            },
            optional: ["note"],
          },
          output: { object: { cleared: "boolean", status: { enum: ["open", "done", 3] } } },
        },
      },
      { name: "recalculate", table: "entries", kind: "action", readOnly: false },
    ],
  },
  { descriptorPath: "finance/books/dataset.json" },
);

const usage = `
import type { FieldIds, Input, OperationName, Operations, Output, Row } from "../.dohc/types/finance-books-11111111-1111-4111-8111-111111111101";

const entry: Row<"entries"> = {
  id: "e1",
  posted_on: "2026-11-24",
  memo: null,
  cents: -1230,
  cleared: false,
  kind: "debit",
  tags: ["tax"],
  account: 7,
  splits: null,
};
const account: Row<"accounts"> = { id: 7, name: "Checking" };
const listed: Operations["listEntries"]["fields"] = { id: "e1", cents: 5, tags: null };
type ListedValues = {
  [Column in keyof Operations["listEntries"]["fields"] as FieldIds["entries"][Column]]: Operations["listEntries"]["fields"][Column];
};
type ListedPage = {
  rows: Array<{ id: Row<"entries">["id"]; version: number; values: ListedValues }>;
  nextCursor: { id: Row<"entries">["id"]; value: unknown } | null;
};
const page: ListedPage = {
  rows: [
    {
      id: "e1",
      version: 1,
      values: {
        "${definition.tables[1]!.fields[0]!.fieldId}": "e1",
        "${definition.tables[1]!.fields[3]!.fieldId}": 5,
        "${definition.tables[1]!.fields[6]!.fieldId}": ["tax"],
      },
    },
  ],
  nextCursor: null,
};
const added: Operations["addEntry"]["fields"] = { posted_on: "2026-11-24", cents: 1, account: 7 };
const kind: Operations["deleteEntry"]["kind"] = "delete";
const access: Operations["deleteEntry"]["access"] = "link";
const names: OperationName[] = ["listEntries", "addEntry", "deleteEntry", "reconcile"];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exactInput: Equal<
  Input<"reconcile">,
  { entryId: string; kind: "credit" | "debit"; note?: string | null; splits: Array<number> }
> = true;
const exactOutput: Equal<Output<"reconcile">, { cleared: boolean; status: 3 | "done" | "open" }> = true;
const undeclared: Equal<Input<"recalculate">, unknown> & Equal<Output<"recalculate">, unknown> = true;
const notAnAction: Equal<Input<"listEntries">, never> & Equal<Input<"reconcile" | "listEntries">, Input<"reconcile">> & Equal<Output<"reconcile" | "listEntries">, Output<"reconcile">> = true;
// @ts-expect-error an action takes only its declared input
const wrongInput: Input<"reconcile"> = { entryId: "e1", kind: "refund", splits: [] };
const fieldId: FieldIds["entries"]["cents"] = "${definition.tables[1]!.fields[3]!.fieldId}";
// @ts-expect-error a select takes only its options
const wrongKind: Row<"entries">["kind"] = "refund";
// @ts-expect-error a checkbox holds true or false
const wrongCleared: Row<"entries">["cleared"] = 1;
// @ts-expect-error a required field is never null
const missingCents: Row<"entries">["cents"] = null;
// @ts-expect-error a relation to a number key holds numbers
const wrongAccount: Row<"entries">["account"] = "7";
// @ts-expect-error a read lists only its own fields
const extra: Operations["listEntries"]["fields"] = { id: "e1", cents: 5, tags: null, memo: null };
// @ts-expect-error an operation name must exist
const unknown: OperationName = "dropEntries";
// @ts-expect-error buttons store nothing
const button: Row<"entries">["Reconcile"] = null;
export { entry, account, listed, page, added, kind, access, names, exactInput, exactOutput, undeclared, notAnAction, wrongInput, fieldId, wrongKind, wrongCleared, missingCents, wrongAccount, extra, unknown, button };
`;

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("dataset types", () => {
  it("names the file with a bounded slug and full Collection id so colliding folders stay distinct", () => {
    expect(datasetTypesPath(definition)).toBe(
      ".dohc/types/finance-books-11111111-1111-4111-8111-111111111101.d.ts",
    );
    expect(
      datasetTypesPath({
        datasetId: "11111111-2222-4222-8222-222222222202",
        name: "Books",
        schemaPath: "finance-books/schema.sql",
      }),
    ).toBe(".dohc/types/finance-books-11111111-2222-4222-8222-222222222202.d.ts");
    expect(
      datasetTypesPath({
        datasetId: "33333333-3333-4333-8333-333333333303",
        name: "My Books!",
        schemaPath: "schema.sql",
      }),
    ).toBe(".dohc/types/my-books-33333333-3333-4333-8333-333333333303.d.ts");
    expect(
      datasetTypesPath({
        datasetId: "44444444-4444-4444-8444-444444444404",
        name: "Books",
        schemaPath: "books/revisions/3-11111111-1111-4111-8111-111111111102/schema.sql",
      }),
    ).toBe(".dohc/types/books-44444444-4444-4444-8444-444444444404.d.ts");
    const longPath = datasetTypesPath({
      datasetId: "55555555-5555-4555-8555-555555555505",
      name: "Deep",
      schemaPath: `${"segment/".repeat(20)}schema.sql`,
    });
    expect(longPath.length).toBeLessThanOrEqual(
      ".dohc/types/".length + 64 + 1 + 36 + ".d.ts".length,
    );
    expect(longPath).toMatch(
      /^\.dohc\/types\/[a-z0-9-]+-55555555-5555-4555-8555-555555555505\.d\.ts$/,
    );
  });

  it("generates declarations that type an app's rows and operations under strict tsc", async () => {
    root = await mkdtemp(join(tmpdir(), "dohc-dataset-types-"));
    const withLineSeparator = { ...definition, name: "Books\u20282026\u2029Ledger" };
    const path = join(root, datasetTypesPath(withLineSeparator));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, datasetTypes({ revision: 3, definition: withLineSeparator }));
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app/main.ts"), usage);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "esnext",
          types: [],
        },
        include: ["app/main.ts"],
      }),
    );
    const result = await promisify(execFile)(process.execPath, [tsc, "-p", root]).catch(
      (error: { stdout: string }) => error,
    );
    expect(result.stdout).toBe("");
  }, 60_000);

  it("writes the file inside the workspace and refuses a .dohc/types that leads elsewhere", async () => {
    root = await mkdtemp(join(tmpdir(), "dohc-dataset-types-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = await writeDatasetTypes(workspace, { revision: 3, definition });
    expect(path).toBe(".dohc/types/finance-books-11111111-1111-4111-8111-111111111101.d.ts");
    expect(await readFile(join(workspace, path), "utf8")).toBe(
      datasetTypes({ revision: 3, definition }),
    );

    await rm(join(workspace, ".dohc/types"), { recursive: true });
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(workspace, ".dohc/types"), "junction");
    await expect(writeDatasetTypes(workspace, { revision: 3, definition })).rejects.toThrow(
      "dohc could not write Collection types.",
    );
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });
});
