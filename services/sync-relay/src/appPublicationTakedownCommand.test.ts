import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildRelayFixture } from "../scripts/build.mjs";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import type { StorageContext } from "./storage/context";

const exec = promisify(execFile), publicationId = "a".repeat(64);
let root: string, command: string;
beforeAll(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, {recursive: true});
  root = await mkdtemp(join(scratch, "takedown-command-"));
  command = join(root, "app-takedown.mjs");
  await buildRelayFixture(fileURLToPath(new URL("./appPublicationTakedownCommand.ts", import.meta.url)), command);
}, 30_000);
afterAll(async () => { if (root) await rm(root, {recursive: true, force: true}); });

async function run(args: string[]) {
  try {
    const result = await exec(process.execPath, [command, ...args], {windowsHide: true, timeout: 20_000, env: {...process.env, NODE_OPTIONS: ""}});
    return {code: 0, ...result};
  } catch (error) {
    const result = error as Error & {code: number; stdout: string; stderr: string};
    return {code: result.code, stdout: result.stdout, stderr: result.stderr};
  }
}
function deployment(name: string) {
  const directory = join(root, name), config = join(directory, "deployment.json");
  initializeRelayDeployment({configPath: config, relayPath: join(directory, "relay", "relay.sqlite"), continuityDirectory: join(directory, "continuity")});
  const {storage} = openRelayDeployment(config);
  try {
    storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
    storage.createShare({share: {shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["app"], versionId: null}), createdAtMs: 1},
      grant: {grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
    const context = storage as StorageContext;
    context.tx(() => {
      context.db.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content,created_at_ms) VALUES('w',?,1,x'00',1)").run("b".repeat(64));
      context.db.prepare(`INSERT INTO sync_relay_app_publications(publication_id,workspace_id,share_id,grant_id,grant_generation,owner_user_id,manifest_sha256,created_at_ms,active,authority_revision)
        VALUES(?,'w','s','g',1,'owner',?,1,1,1)`).run(publicationId, "b".repeat(64));
    });
  } finally {storage.close();}
  return config;
}

it("runs the actual command against a stopped deployment and durably preserves its first record", async () => {
  const config = deployment("disabled");
  const args = ["--deployment-config", config, "--publication-id", publicationId, "--reason", "Confirmed phishing"];
  const result = await run(args);
  expect(result, result.stderr).toMatchObject({code: 0});
  const disabled = JSON.parse(result.stdout);
  expect(disabled).toMatchObject({publicationId, authorityRevision: 2, operatorTakedown: {actor: "operator", reason: "Confirmed phishing", disabledAtMs: expect.any(Number)}});
  const retry = await run([...args.slice(0, -1), "Retry with another reason"]);
  expect(retry).toMatchObject({code: 0, stdout: result.stdout});
  const {storage} = openRelayDeployment(config);
  try {
    expect(storage.listAppPublications({workspaceId: "w", ownerUserId: "owner", limits: {maxFiles: 10, maxMetadataBytes: 16384, maxBundleBytes: 4096}}).publications[0])
      .toMatchObject({active: false, manifestUnavailable: true, operatorTakedown: disabled.operatorTakedown});
  } finally {storage.close();}
});

it("refuses a deployment held by the running relay", async () => {
  const config = deployment("held"), {storage} = openRelayDeployment(config);
  try {
    expect(await run(["--deployment-config", config, "--publication-id", publicationId, "--reason", "Malware"])).toMatchObject({code: 1, stdout: ""});
    expect((storage as StorageContext).db.prepare("SELECT active,authority_revision FROM sync_relay_app_publications").get()).toMatchObject({active: 1, authority_revision: 1});
  } finally {storage.close();}
});

it("validates required arguments before opening storage and never creates a missing deployment", async () => {
  const config = join(root, "missing.json");
  await writeFile(config, "operator-owned bytes");
  const valid = ["--deployment-config", config, "--publication-id", publicationId, "--reason", "Malware"];
  for (const args of [valid.slice(0, -2), [...valid, "--reason", "Other"], [...valid.slice(0, -1), " "], [...valid.slice(0, 3), "bad-id", ...valid.slice(4)]]) {
    expect(await run(args)).toMatchObject({code: 1, stdout: ""});
    expect(await readFile(config, "utf8")).toBe("operator-owned bytes");
  }
  const missing = join(root, "does-not-exist.json");
  expect(await run(["--deployment-config", missing, "--publication-id", publicationId, "--reason", "Malware"])).toMatchObject({code: 1, stdout: ""});
  await expect(stat(missing)).rejects.toMatchObject({code: "ENOENT"});
});

it("explains the owner-visible reason and permanent disablement in help", async () => {
  const result = await run(["--help"]);
  expect(result).toMatchObject({code: 0, stderr: ""});
  expect(result.stdout).toContain("The owner cannot reactivate it.");
  expect(result.stdout).toContain("The owner sees the reason.");
});
