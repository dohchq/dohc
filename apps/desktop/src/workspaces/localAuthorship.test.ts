import { describe, expect, it } from "vitest";
import { deferred } from "../testing/deferred";
import { createLocalAuthorship } from "./localAuthorship";

function authorship() {
  const load = deferred<unknown>();
  let loads = 0;
  const local = createLocalAuthorship({
    installationId: () => "local:installation",
    sign: (workspaceId, personId) => `${workspaceId}:${personId}`,
    loadCredentials: () => {
      loads += 1;
      return load.promise;
    },
  });
  return { local, load, loads: () => loads };
}

describe("local authorship", () => {
  it("reads a settled account when the request arrives, while a later load is still held", async () => {
    const { local, load, loads } = authorship();
    local.credentialsSettled("account-alice");
    // A sign-in reload is under way and its cleanup has not finished.
    const request = local.person("workspace");
    local.credentialsSettled("account-bob");
    load.resolve(undefined);
    await expect(request).resolves.toEqual({
      kind: "human", humanId: "account-alice", authorContext: "workspace:account-alice",
    });
    expect(loads()).toBe(0);
  });

  it("waits for the first credential load on a cold start", async () => {
    const { local, load } = authorship();
    const request = local.person("workspace");
    local.credentialsSettled("account-alice");
    load.resolve(undefined);
    await expect(request).resolves.toMatchObject({ humanId: "account-alice" });
  });

  it("credits this installation once signed out has settled, without waiting", async () => {
    const { local, loads } = authorship();
    local.credentialsSettled(null);
    await expect(local.person("workspace")).resolves.toMatchObject({ humanId: "local:installation" });
    expect(local.authorContext("workspace")).toBe("workspace:local:installation");
    expect(loads()).toBe(0);
  });

  it("credits this installation when the first load cannot read the store, and loads again next time", async () => {
    const { local, load, loads } = authorship();
    load.resolve({ error: new Error("EACCES") });
    await expect(local.person("workspace")).resolves.toMatchObject({ humanId: "local:installation" });
    await local.settled();
    expect(loads()).toBe(2);
  });
});
