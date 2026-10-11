import {expect, it} from "vitest";
import { RESERVED_WORKSPACE_IDS as desktopReservedIds, checkManifest } from "../../../packages/workspace-core/src/metadata";
import {parseWorkspaceId, RESERVED_WORKSPACE_IDS} from "./requestInputs";

it.each(["shares", "notices", "link"])("refuses the reserved workspace ID %s", workspaceId => {
  expect(() => parseWorkspaceId(workspaceId)).toThrowError(expect.objectContaining({
    code: "bad_request",
    statusCode: 400,
    message: "workspaceId is reserved",
  }));
});

it.each([
  "9e937809-5a3d-4ffb-8c02-9f47734b53f0",
  "link-lane-owner", "linkx", "link-refresh", "shares-owner", "notices-owner",
])("accepts the workspace ID %s", workspaceId => {
  expect(parseWorkspaceId(workspaceId)).toBe(workspaceId);
});

it("uses the same reserved-ID object as desktop manifest admission", () => {
  expect(RESERVED_WORKSPACE_IDS).toBe(desktopReservedIds);
  expect(RESERVED_WORKSPACE_IDS).toEqual(["link", "shares", "notices"]);
  for (const workspaceId of RESERVED_WORKSPACE_IDS) {
    expect(checkManifest({ version: 1, workspaceId, kind: "personal", mode: "local-first" }))
      .toEqual({ status: "reserved-id", workspaceId });
  }
});
