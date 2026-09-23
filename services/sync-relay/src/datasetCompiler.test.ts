import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { initializeAppDatabase, evaluateAppOperation } from "@dohc/app-backend-runtime";
import { compileDatasetOperations } from "./datasetCompiler";

describe("the relay dataset compiler", () => {
  it("compiles typed source for the real isolated operation runtime", async () => {
    const source = await compileDatasetOperations(`type Input={value:string};globalThis.operations={read(_ctx:unknown,input:Input){return {value:input.value};}};`, "data/operations.ts");
    const database = await initializeAppDatabase({schemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL);", tables: ["records"]});
    const evaluated = await evaluateAppOperation({source, database, tables: ["records"], operation: "read", caller: {kind: "owner"}, input: {value: "typed"}, readOnly: true, nowMs: 1, requestId: "compiler-test"});
    expect(evaluated.result).toEqual({value: "typed"});
  });
  it("compiles the real fundraiser operations without a fixture compiler override", async () => {
    const source = await readFile(new URL("../../../examples/fundraiser/backend.ts", import.meta.url), "utf8");
    expect(await compileDatasetOperations(source, "fundraiser/backend.ts")).toContain("globalThis.operations");
  });
  it("refuses invalid syntax and oversized source before approval", async () => {
    await expect(compileDatasetOperations("function {", "data/operations.ts")).rejects.toThrow("could not compile");
    await expect(compileDatasetOperations(" ".repeat(256 * 1024 + 1), "data/operations.ts")).rejects.toThrow("256 KiB");
  });
});
