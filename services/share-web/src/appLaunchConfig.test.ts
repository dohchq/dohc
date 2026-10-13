import { describe, expect, it } from "vitest";
import { parseAppLaunchConfig } from "./appLaunchConfig";

describe("app launch configuration", () => {
  const viewerOrigin = "https://share.example.com";

  it.each(["exampleapps.com", "vercel.app", "github.io"])("accepts app domain %s", appDomain => {
    const config = { viewerOrigin, appDomain };
    expect(parseAppLaunchConfig(config)).toEqual(config);
  });

  it("refuses the viewer's registrable domain", () => {
    expect(() => parseAppLaunchConfig({ viewerOrigin, appDomain: "example.com" })).toThrow(TypeError);
    expect(() => parseAppLaunchConfig({ viewerOrigin: "https://share.tenant.github.io", appDomain: "tenant.github.io" })).toThrow(TypeError);
  });

  it("refuses a private suffix under the viewer's registrable domain", () => {
    expect(() => parseAppLaunchConfig({ viewerOrigin: "https://share.amazonaws.com", appDomain: "s3.amazonaws.com" })).toThrow(TypeError);
  });

  it("refuses an app domain whose launch hosts are public suffixes", () => {
    expect(() => parseAppLaunchConfig({ viewerOrigin, appDomain: "platformsh.site" })).toThrow(TypeError);
  });

  it.each(["vercel.app", "github.io"])("refuses a viewer under app suffix %s", appDomain => {
    for (const host of [appDomain, `share.${appDomain}`, `nested.share.${appDomain}`, `share.${appDomain}.`]) {
      expect(() => parseAppLaunchConfig({ viewerOrigin: `https://${host}`, appDomain })).toThrow(TypeError);
    }
  });

  it("accepts separate registrable domains under the same private suffix", () => {
    const config = { viewerOrigin: "https://a.github.io", appDomain: "b.github.io" };
    expect(parseAppLaunchConfig(config)).toEqual(config);
  });

  it("keeps hostname suffix boundaries distinct", () => {
    const config = { viewerOrigin: "https://share.notvercel.app", appDomain: "vercel.app" };
    expect(parseAppLaunchConfig(config)).toEqual(config);
  });

  it.each(["com", "co.uk", "apps.example.com", "localhost", "127.0.0.1", "EXAMPLE.NET", "example.net.",
    "https://example.net", "example.net:443", "*.example.net", "example_net"])("refuses invalid app domain %s", appDomain => {
    expect(() => parseAppLaunchConfig({ viewerOrigin, appDomain })).toThrow(TypeError);
  });

  it.each(["http://share.example.com", "https://share.example.com:8443", "https://share.example.com:443",
    "https://share.example.com/", "https://share.example.com/path", "https://localhost", "https://127.0.0.1"])(
    "refuses invalid viewer origin %s", viewerOrigin => {
      expect(() => parseAppLaunchConfig({ viewerOrigin, appDomain: "exampleapps.com" })).toThrow(TypeError);
    },
  );
});
