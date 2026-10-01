import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { captureLocalAuthorContext, readOrCreateLocalInstallationIdentity } from "./localInstallationIdentity";
import { createTestScratch } from "./testTemp";

let dir: string;
beforeEach(async () => { dir = await createTestScratch("dohc-local-id-"); });
const idFile = () => join(dir, "dohc-local-id.json");

describe("local installation identity", () => {
  it("persists the subject and private credential across restarts", async () => {
    const first = readOrCreateLocalInstallationIdentity(idFile());
    expect(first.id).toMatch(/^local:/u);
    expect(first.authorContextSecret).toMatch(/^[a-f0-9]{64}$/u);
    expect(readOrCreateLocalInstallationIdentity(idFile())).toEqual(first);
    expect(JSON.parse(await readFile(idFile(), "utf8"))).toEqual(first);
    expect(await readdir(dir)).toEqual(["dohc-local-id.json"]);
  });
  it("adds the private credential while retaining an existing installation id", async () => {
    await writeFile(idFile(), JSON.stringify({ id: "local:preexisting" }));
    const identity = readOrCreateLocalInstallationIdentity(idFile());
    expect(identity.id).toBe("local:preexisting");
    expect(readOrCreateLocalInstallationIdentity(idFile())).toEqual(identity);
  });
  it("refuses a corrupt identity instead of relabeling signed-out work", async () => {
    await writeFile(idFile(), "not json {");
    expect(() => readOrCreateLocalInstallationIdentity(idFile())).toThrow();
    expect(await readFile(idFile(), "utf8")).toBe("not json {");
  });
  it("refuses an identity that cannot be persisted", () => {
    expect(() => readOrCreateLocalInstallationIdentity(join(dir, "missing", "identity.json"))).toThrow();
  });
  it("signs the context the engine verifies", () => {
    // The vector crates/dohc-workspace-engine/src/rpc/author_context.rs pins.
    expect(captureLocalAuthorContext({ id: "local:unused", authorContextSecret: "a".repeat(64) }, "workspace", "alice"))
      .toBe("eyJ3b3Jrc3BhY2VJZCI6IndvcmtzcGFjZSIsInBlcnNvbklkIjoiYWxpY2UifQ.k9frBJAz_6bdaYT1D7rJB84fgMERh9fehkZECfpjLsE");
  });
});
