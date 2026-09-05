import { describe, expect, it } from "vitest";
import {
  assertInstanceBudget,
  MAX_PLUGIN_WEB_APP_INSTANCES,
  requireDeclaredWebApp,
} from "./pluginWebAppInstances";

const SINGLE = { id: "app", instanced: false };
const PER_INSTANCE = { id: "preview", instanced: true };
const DECLARED = [SINGLE, PER_INSTANCE];

describe("requireDeclaredWebApp", () => {
  it("refuses a web app the manifest never declared", () => {
    expect(() => requireDeclaredWebApp("p", DECLARED, "ghost", null)).toThrow(
      /does not declare web app "ghost"/,
    );
  });

  it("refuses a web app when the plugin declares none at all", () => {
    expect(() => requireDeclaredWebApp("p", undefined, "app", null)).toThrow(
      /does not declare web app "app"/,
    );
  });

  it("accepts the two shapes that match their manifest entry", () => {
    expect(requireDeclaredWebApp("p", DECLARED, "app", null)).toEqual(SINGLE);
    expect(requireDeclaredWebApp("p", DECLARED, "preview", "sites/a")).toEqual(
      PER_INSTANCE,
    );
  });

  it("refuses a per-instance web app opened without an instance", () => {
    expect(() =>
      requireDeclaredWebApp("p", DECLARED, "preview", null),
    ).toThrow(/opens one tab per instance, so an open must name an instance/);
  });

  it("refuses an instance named on a single-tab web app", () => {
    expect(() => requireDeclaredWebApp("p", DECLARED, "app", "sites/a")).toThrow(
      /opens one tab for the whole plugin, so an open must not name an instance/,
    );
  });

  it("names the plugin, the web app, and the instance it refused", () => {
    expect(() => requireDeclaredWebApp("acme", DECLARED, "app", "sites/a"))
      .toThrow(/"acme".*"app".*"sites\/a"/);
  });
});

describe("assertInstanceBudget", () => {
  it("allows instances up to one short of the limit", () => {
    expect(() =>
      assertInstanceBudget("p", "preview", MAX_PLUGIN_WEB_APP_INSTANCES - 1),
    ).not.toThrow();
  });

  it("refuses the instance that would pass the limit, and says why", () => {
    expect(() =>
      assertInstanceBudget("acme", "preview", MAX_PLUGIN_WEB_APP_INSTANCES),
    ).toThrow(
      new RegExp(
        `acme.*preview.*${MAX_PLUGIN_WEB_APP_INSTANCES} instances.*limit of ${MAX_PLUGIN_WEB_APP_INSTANCES} instances per web app.*Close an instance tab`,
        "s",
      ),
    );
  });
});
