import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { OwnerAppFormRequest } from "./appForm";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";

const request = { workspaceId: "workspace", collectionPath: "Participants", appRoot: "apps/registration", publicFields: ["name"] };
const result = { appRoot: request.appRoot, schemaSource: "Participants/collection.yaml", files: ["apps/registration/app.publish.json"], recordsCopied: 0 as const };
describe("app form creation CLI", () => {
  it("sends the selected fields and workspace without publishing", async () => {
    expect(parseCliArguments(["--as-agent", "app", "createForm", JSON.stringify(request)], {})).toMatchObject({ actor: "agent", verb: "appForm", request });
    const send = vi.fn(async () => result);
    const executed = await executeCli({ argv: ["app", "createForm", JSON.stringify(request), "--json"], request: send, env: {} });
    expect(executed.exitCode).toBe(0);
    expect(JSON.parse(executed.stdout)).toMatchObject(result);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ verb: "appForm", args: expect.objectContaining({ request }) }));
    const wire = { token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "appForm", args: { cwd: "/workspace", actor: "human", request } };
    expect(cliRequestSchema.parse(wire)).toEqual(wire);
    expect(parseCliResult("appForm", result)).toEqual(result);
  });
  it("requires explicit unique public fields and refuses extra authority", () => {
    for (const invalid of [{ ...request, publicFields: [] }, { ...request, publicFields: ["name", "name"] }, { ...request, overwrite: true }, { ...request, approve: true }]) {
      expect(() => OwnerAppFormRequest.parse(invalid)).toThrow();
    }
    expect(() => parseCliResult("appForm", { ...result, recordsCopied: 1 })).toThrow();
  });
});
