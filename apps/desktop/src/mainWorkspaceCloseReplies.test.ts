import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tells dispatch sync callers to reopen a workspace that closed", () => {
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function syncWorkspaceForDispatch(");
  const sync = main.slice(start, main.indexOf("activity.queueCloudSync(workspaceId);", start));
  expect(sync).toMatch(/throw new Error\(\s*"This workspace was closed\. Open it again\.",?\s*\)/);
});
