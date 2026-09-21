import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./args";
import { OwnerAppBackendRequest, OwnerAppBackendResult } from "./appBackend";

const selection = { workspaceId: "workspace", publicationId: "a".repeat(64) };
describe("owner app backend CLI", () => {
  it.each(["describe", "helper", "invoke", "export"])("parses %s owner commands", action => {
    const fields = action === "helper" ? { grantId: "grant", enabled: true } : action === "invoke" ? { operation: "list", idempotencyKey: "request-1", input: {} } : action === "export" ? { savePath: "C:\\Exports\\app.json" } : {};
    const request = { ...selection, ...fields, action };
    expect(parseCliArguments(["--as-agent", "app", action, JSON.stringify({ ...selection, ...fields })], {})).toMatchObject({ actor: "agent", verb: "appBackend", request });
  });
  it("requires an explicit CLI export path and refuses client authority", () => {
    expect(() => parseCliArguments(["app", "export", JSON.stringify(selection)], {})).toThrow();
    expect(() => OwnerAppBackendRequest.parse({ ...selection, action: "describe", authorityRevision: 9 })).toThrow();
    expect(() => OwnerAppBackendResult.parse({ result: {}, revision: 0, replayed: false, private: true })).toThrow();
  });
});
