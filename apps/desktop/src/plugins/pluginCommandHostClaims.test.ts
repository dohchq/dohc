import { describe, expect, it } from "vitest";
import { PluginCommandHostClaims } from "./pluginCommandHostClaims";

describe("PluginCommandHostClaims", () => {
  it("keeps an overlapping command claim until its final release", () => {
    const claims = new PluginCommandHostClaims();

    claims.claim("workspace-1\0example-plugin");
    claims.claim("workspace-1\0example-plugin");
    claims.release("workspace-1\0example-plugin");

    expect(claims.has("workspace-1\0example-plugin")).toBe(true);

    claims.release("workspace-1\0example-plugin");

    expect(claims.has("workspace-1\0example-plugin")).toBe(false);
  });
});
