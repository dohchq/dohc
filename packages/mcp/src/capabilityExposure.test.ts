import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import mainTools from "./toolsList.main.json";

it.each(["owner", "view", "comment", "edit"] as const)("preserves main tools/list output for %s", async level => {
  expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(mainTools[level]);
});
