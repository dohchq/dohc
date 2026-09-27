import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { writeDurableNoticeFile } from "./durableNoticeFile";

it("durably replaces a notice file with shell characters in its path", async () => {
  const root = await createTestScratch("durable-notices-");
  const path = join(root, "a '$; & folder", "local.json");
  await writeDurableNoticeFile(path, "first");
  await writeDurableNoticeFile(path, "second");
  expect(await readFile(path, "utf8")).toBe("second");
});

it("rejects failed replacement before the caller can acknowledge a report", async () => {
  const root = await createTestScratch("durable-notices-");
  const path = join(root, "local.json");
  await mkdir(path);
  await expect(writeDurableNoticeFile(path, "refusal")).rejects.toThrow();
});
