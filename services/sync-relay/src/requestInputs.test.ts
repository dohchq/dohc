import {expect, it} from "vitest";
import {parseWorkspaceId} from "./requestInputs";

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