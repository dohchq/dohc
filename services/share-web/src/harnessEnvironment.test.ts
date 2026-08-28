import { describe, expect, it } from "vitest";
import { buildHarnessEnvironment } from "../e2e/harnessEnvironment";

describe("buildHarnessEnvironment", () => {
  it("removes inherited service configuration before applying harness overrides", () => {
    const environment = buildHarnessEnvironment(
      {
        DOHC_SHARE_WEB_PORT: "poisoned-share-port",
        DOHC_UNRELATED_POISON: "poisoned-dohc-value",
        PATH: "C:\\tools",
        SYNC_RELAY_DB_PATH: "poisoned-relay-db",
        SYNC_RELAY_PORT: "poisoned-relay-port",
        TEMP: "C:\\temp",
      },
      {
        DOHC_SHARE_WEB_PORT: "4123",
        NODE_ENV: "test",
        SYNC_RELAY_PORT: "0",
      },
    );

    expect(environment).toEqual({
      DOHC_SHARE_WEB_PORT: "4123",
      NODE_ENV: "test",
      PATH: "C:\\tools",
      SYNC_RELAY_PORT: "0",
      TEMP: "C:\\temp",
    });
    expect(Object.values(environment)).not.toContain("poisoned-dohc-value");
    expect(Object.values(environment)).not.toContain("poisoned-relay-db");
  });
});
