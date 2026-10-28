import { expect, it, vi } from "vitest";
import { compareVersion, listVersionConflicts, listVersions, type ToolContext } from "./tools";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";

const tools = ["dohc_list_versions", "dohc_compare_version", "dohc_list_version_conflicts"];

it("offers the version reads to the owner only and sends them as the agent", async () => {
  expect((await advertisedCapabilityTools(undefined)).map(tool => tool.name)).toEqual(expect.arrayContaining(tools));
  for (const shareAccess of ["view", "comment", "edit"] as const) {
    const names = (await advertisedCapabilityTools(shareAccess)).map(tool => tool.name);
    for (const tool of tools) expect(names).not.toContain(tool);
  }
  const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => ({ ok: false, reason: "Versions belong to the owning workspace. Open it to continue." }));
  const ctx: ToolContext = { root: process.cwd(), home: process.cwd(), request };
  await listVersions(ctx);
  await compareVersion(ctx, { version: "Draft", afterPath: "a.md" });
  await listVersionConflicts(ctx, { afterConflictId: "c1" });
  expect(request.mock.calls.map(([sent]) => sent)).toEqual([
    expect.objectContaining({ verb: "versionList", args: expect.objectContaining({ actor: "agent" }) }),
    expect.objectContaining({ verb: "versionCompare", args: expect.objectContaining({ actor: "agent", version: "Draft", afterPath: "a.md" }) }),
    expect.objectContaining({ verb: "versionConflicts", args: expect.objectContaining({ actor: "agent", afterConflictId: "c1" }) }),
  ]);
});
