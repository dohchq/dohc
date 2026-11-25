import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  datasetRevisionsPreserveAccess,
  parseDatasetDefinition,
  type DatasetContractType,
  type DatasetDefinition,
  type DatasetOperationContract,
  type DatasetRevision,
} from "./dataset";
import { assessAppDatasetDrift, resolveAppDatasetCapability } from "./datasetAuthorization";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const datasetId = "11111111-1111-4111-8111-111111111101";

function draft(contract?: unknown, kind = "action") {
  return {
    formatVersion: 2,
    datasetId,
    name: "Tasks",
    tables: [
      {
        sqlName: "tasks",
        primaryKey: "id",
        fields: [
          { sqlColumn: "id", type: "text" },
          { sqlColumn: "status", type: "text", required: true },
        ],
      },
    ],
    operations: [
      { name: "listTasks", table: "tasks", kind: "read", fields: ["id", "status"] },
      {
        name: "setStatus",
        label: "Set status",
        table: "tasks",
        kind,
        ...(kind === "read" ? {} : { readOnly: false }),
        ...(contract === undefined ? {} : { contract }),
      },
    ],
  };
}
const parse = (contract?: unknown, kind?: string) =>
  parseDatasetDefinition(draft(contract, kind), { descriptorPath: "tasks/dataset.json" });
const nested = (depth: number): unknown => (depth === 1 ? "string" : { array: nested(depth - 1) });
const objectOf = (count: number, member: unknown = "string") => ({
  object: Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, member])),
});

describe("action contracts", () => {
  it("accepts a contract on an action and stores it in canonical order", () => {
    const parsed = parse({
      output: { object: { status: { enum: ["open", 2, true, "done"] }, id: "string" } },
      input: {
        optional: ["note", "id"],
        object: { note: { nullable: "string" }, id: "string", tags: { array: "string" } },
      },
    });
    expect(parsed.operations[1]!.contract).toEqual({
      input: {
        object: { id: "string", note: { nullable: "string" }, tags: { array: "string" } },
        optional: ["id", "note"],
      },
      output: { object: { id: "string", status: { enum: ["done", "open", 2, true] } } },
    });
    expect(JSON.stringify(parsed.operations[1]!.contract)).toBe(
      '{"input":{"object":{"id":"string","note":{"nullable":"string"},"tags":{"array":"string"}},"optional":["id","note"]},"output":{"object":{"id":"string","status":{"enum":["done","open",2,true]}}}}',
    );
  });

  it("gives the same digest whatever order the author wrote keys and enum values in", () => {
    const first = parse({ input: { object: { b: { enum: [1, "1"] }, a: "number" } } });
    const second = parse({ input: { object: { a: "number", b: { enum: ["1", 1] } } } });
    expect(datasetDefinitionDigestContent(first)).toBe(datasetDefinitionDigestContent(second));
  });

  it("keeps the digest of a Collection without contracts", () => {
    const accounting = parseDatasetDefinition(
      JSON.parse(
        readFileSync(new URL("../../../examples/accounting/dataset.json", import.meta.url), "utf8"),
      ),
      { descriptorPath: "accounting/dataset.json" },
    );
    expect(hash(datasetDefinitionDigestContent(accounting))).toBe(
      "2a82c12c4685c28bc537efe2c23ad9b3e7329676cd6b62d8cd0044b63bde35f3",
    );
  });

  it("refuses a contract on an operation that is not an action", () => {
    expect(() => parse({ output: "string" }, "read")).toThrow(
      'contract is only allowed on "action" operations',
    );
    expect(() => parse({ output: "string" }, "create")).toThrow(
      'contract is only allowed on "action" operations',
    );
  });

  it.each([
    [{}, "must declare input, output, or both"],
    [{ input: "date" }, 'must be "string", "number", "boolean", "unknown"'],
    [{ input: nested(9) }, "is nested 9 levels deep, over the 8-level limit"],
    [
      { input: objectOf(64, { array: "string" }), output: objectOf(64, { array: "string" }) },
      "has 258 types, over the 256-type limit",
    ],
    [{ input: objectOf(65) }, "has 65 properties. It must have 1 to 64"],
    [{ input: { object: {} } }, "has 0 properties. It must have 1 to 64"],
    [
      { input: { enum: Array.from({ length: 65 }, (_, index) => index) } },
      "must contain at most 64 item(s)",
    ],
    [{ input: { enum: [1, 1] } }, "contains duplicate values"],
    [{ input: { enum: ["x".repeat(129)] } }, "strings must be at most 128 bytes"],
    [{ input: { enum: ["é".repeat(65)] } }, "strings must be at most 128 bytes"],
    [{ input: { enum: [null] } }, "must be strings, numbers, or booleans"],
    [{ input: { object: { "1a": "string" } } }, "must match [A-Za-z_$][A-Za-z0-9_$]{0,63}"],
    [{ input: { object: { constructor: "string" } } }, "Invalid app backend record property"],
    [{ input: { object: { a: "string" }, optional: ["b"] } }, "must name keys of"],
    [{ input: { object: { a: "string" }, optional: [] } }, "must contain at least 1 item(s)"],
    [{ input: { nullable: { nullable: "string" } } }, 'must not be "unknown" or another nullable'],
    [{ input: { nullable: "unknown" } }, 'must not be "unknown" or another nullable'],
    [{ input: { array: "string", enum: [1] } }, "has unknown field(s)"],
  ])("refuses %j", (contract, message) => {
    expect(() => parse(contract)).toThrow(message);
  });

  it("accepts the deepest and largest contract within the limits", () => {
    expect(() => parse({ input: nested(8) })).not.toThrow();
    expect(() =>
      parse({
        input: objectOf(64, { array: "string" }),
        output: objectOf(63, { array: "string" }),
      }),
    ).not.toThrow();
  });

  it("keeps app approvals when only a contract changes", () => {
    const before = revision(parse(), 1);
    const after = revision(parse({ input: { object: { status: "string" } } }), 2);
    expect(datasetRevisionsPreserveAccess(before, after)).toBe(true);
  });
});

function revision(definition: DatasetDefinition, number: number): DatasetRevision {
  const value: DatasetRevision = {
    datasetId: definition.datasetId,
    revision: number,
    revisionSha256: "0".repeat(64),
    definitionSha256: hash(datasetDefinitionDigestContent(definition)),
    schemaSha256: hash("schema"),
    operationsSha256: hash("custom"),
    definition,
  };
  value.revisionSha256 = hash(datasetRevisionDigestContent(value));
  return value;
}

describe("contract drift", () => {
  const drift = (
    before: DatasetOperationContract,
    after: DatasetOperationContract | undefined,
    options: { bindingCurrent?: boolean; preservesAccess?: boolean } = {},
  ) => {
    const pinned = revision(parse(before), 1);
    const target = revision(parse(after), 2);
    const action = pinned.definition.operations[1]!;
    const capability = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId,
        revision: 1,
        revisionSha256: pinned.revisionSha256,
        operationIds: [action.operationId],
      },
      pinned,
    );
    return assessAppDatasetDrift(capability, target, {
      scope: "local",
      bindingCurrent: options.bindingCurrent ?? false,
      preservesAccess: options.preservesAccess ?? false,
      pinnedRevision: pinned,
    });
  };
  const object = (
    members: Record<string, DatasetContractType>,
    optional?: string[],
  ): DatasetContractType => ({ object: members, ...(optional ? { optional } : {}) });
  const status = (...values: string[]): DatasetContractType => ({ enum: values });
  const inputBreak = (path: string) => ({
    status: "incompatible",
    reasons: [`Action "Set status" no longer accepts the input it took before${path}.`],
  });
  const outputBreak = (path: string) => ({
    status: "incompatible",
    reasons: [`Action "Set status" can return output the app does not expect${path}.`],
  });
  const quiet = { status: "needs-refresh", reasons: [] };

  it.each<[string, DatasetContractType, DatasetContractType, object]>([
    [
      "a new required field",
      object({ id: "string" }),
      object({ id: "string", note: "string" }),
      inputBreak(" at note"),
    ],
    [
      "a removed field",
      object({ id: "string", note: "string" }, ["note"]),
      object({ id: "string" }),
      inputBreak(" at note"),
    ],
    [
      "an optional field made required",
      object({ id: "string", note: "string" }, ["note"]),
      object({ id: "string", note: "string" }),
      inputBreak(" at note"),
    ],
    [
      "a narrowed union",
      object({ status: status("open", "done") }),
      object({ status: status("open") }),
      inputBreak(" at status"),
    ],
    [
      "a narrowed type",
      object({ status: "string" }),
      object({ status: status("open") }),
      inputBreak(" at status"),
    ],
    [
      "a nested array element change",
      object({ tags: { array: "string" } }),
      object({ tags: { array: "number" } }),
      inputBreak(" at tags[]"),
    ],
    ["a root type change", "string", "number", inputBreak("")],
    [
      "a new optional field",
      object({ id: "string" }),
      object({ id: "string", note: "string" }, ["note"]),
      quiet,
    ],
    [
      "a widened union",
      object({ status: status("open") }),
      object({ status: status("open", "done") }),
      quiet,
    ],
    [
      "a union widened to its type",
      object({ status: status("open") }),
      object({ status: "string" }),
      quiet,
    ],
    [
      "a field made nullable",
      object({ id: "string" }),
      object({ id: { nullable: "string" } }),
      quiet,
    ],
    [
      "a required field made optional",
      object({ id: "string" }),
      object({ id: "string" }, ["id"]),
      quiet,
    ],
    ["a boolean spelled as both values", "boolean", { enum: [false, true] }, quiet],
  ])("input: %s", (_name, before, after, expected) => {
    expect(drift({ input: before }, { input: after })).toEqual(expected);
  });

  it.each<[string, DatasetContractType, DatasetContractType, object]>([
    [
      "a removed required field",
      object({ id: "string", status: "string" }),
      object({ id: "string" }),
      outputBreak(" at status"),
    ],
    [
      "a required field made optional",
      object({ id: "string" }),
      object({ id: "string" }, ["id"]),
      outputBreak(" at id"),
    ],
    [
      "a field made nullable",
      object({ id: "string" }),
      object({ id: { nullable: "string" } }),
      outputBreak(" at id"),
    ],
    [
      "a widened union",
      object({ status: status("open", "done") }),
      object({ status: status("open", "done", "blocked") }),
      outputBreak(" at status"),
    ],
    [
      "a union widened to its type",
      object({ status: status("open") }),
      object({ status: "string" }),
      outputBreak(" at status"),
    ],
    [
      "a root object made nullable",
      object({ id: "string" }),
      { nullable: object({ id: "string" }) },
      outputBreak(""),
    ],
    ["a new field", object({ id: "string" }), object({ id: "string", note: "string" }), quiet],
    [
      "a narrowed union",
      object({ status: status("open", "done") }),
      object({ status: status("open") }),
      quiet,
    ],
    [
      "a removed optional field",
      object({ id: "string", note: "string" }, ["note"]),
      object({ id: "string" }),
      quiet,
    ],
    [
      "a type narrowed to a union",
      object({ status: "string" }),
      object({ status: status("open") }),
      quiet,
    ],
    ["a field made required", object({ id: "string" }, ["id"]), object({ id: "string" }), quiet],
    [
      "a field made non-null",
      object({ id: { nullable: "string" } }),
      object({ id: "string" }),
      quiet,
    ],
    ["a boolean spelled as both values", { enum: [false, true] }, "boolean", quiet],
  ])("output: %s", (_name, before, after, expected) => {
    expect(drift({ output: before }, { output: after })).toEqual(expected);
  });

  it("warns when a declared output is dropped, not when a contract is first added", () => {
    expect(drift({ output: "string" }, undefined)).toEqual(outputBreak(""));
    expect(drift({ input: "string" }, undefined)).toEqual(quiet);
    expect(drift({ input: "string" }, { input: "string", output: "number" })).toEqual(quiet);
  });

  it("warns on a contract-only change while app access stays current", () => {
    expect(
      drift(
        { input: object({ id: "string" }) },
        { input: object({ id: "string", note: "string" }) },
        { bindingCurrent: true, preservesAccess: true },
      ),
    ).toEqual(inputBreak(" at note"));
    expect(
      drift(
        { input: object({ id: "string" }) },
        { input: object({ id: "string", note: "string" }, ["note"]) },
        { bindingCurrent: true, preservesAccess: true },
      ),
    ).toEqual({ status: "compatible", reasons: [] });
  });
});
