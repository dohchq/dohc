import { afterEach, expect, it, vi } from "vitest";
import * as compiler from "@dohc/app-backend-runtime/dataset-compiler";
import { createDatasetFixtureCompiler } from "./datasetFixtureCompiler";

const source = "globalThis.operations = { read() { return 1; } };";
const path = "items/operations.js";
afterEach(() => vi.restoreAllMocks());

it("reuses real compiled bytes only for the same source and path within one fixture compiler", async () => {
  const compile = vi.spyOn(compiler, "compileDatasetOperations");
  const first = createDatasetFixtureCompiler(), second = createDatasetFixtureCompiler();
  const signal = new AbortController().signal;
  const bytes = await first(source, path, signal);
  expect(await first(source, path, signal)).toBe(bytes);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(await first(source.replace("return 1", "return 2"), path, signal)).not.toBe(bytes);
  expect(await first(source, "other/operations.js", signal)).toBe(bytes);
  expect(await second(source, path, signal)).toBe(bytes);
  expect(compile).toHaveBeenCalledTimes(4);
});

it("checks cancellation for cached bytes and does not retain a compilation cancelled before delivery", async () => {
  const compile = vi.spyOn(compiler, "compileDatasetOperations");
  const fixture = createDatasetFixtureCompiler();
  const signal = new AbortController().signal;
  await fixture(source, path, signal);
  await expect(fixture(source, path, AbortSignal.abort(new Error("Closed fixture")))).rejects.toThrow("Closed fixture");
  expect(compile).toHaveBeenCalledTimes(1);

  const controller = new AbortController();
  const different = source.replace("return 1", "return 3");
  compile.mockImplementationOnce(async () => {
    controller.abort(new Error("Retired during compilation"));
    return "cancelled bytes";
  });
  await expect(fixture(different, path, controller.signal)).rejects.toThrow("Retired during compilation");
  expect(await fixture(different, path, signal)).not.toBe("cancelled bytes");
  expect(compile).toHaveBeenCalledTimes(3);
});

it("tries the real compiler again after a failed request", async () => {
  const compile = vi.spyOn(compiler, "compileDatasetOperations");
  const fixture = createDatasetFixtureCompiler();
  const signal = new AbortController().signal;
  compile.mockRejectedValueOnce(new Error("Compiler stopped"));
  await expect(fixture(source, path, signal)).rejects.toThrow("Compiler stopped");
  const bytes = await fixture(source, path, signal);
  expect(await fixture(source, path, signal)).toBe(bytes);
  expect(compile).toHaveBeenCalledTimes(2);
});
