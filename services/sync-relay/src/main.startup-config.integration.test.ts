import { accountDeletionKey, ACCOUNT_DELETION_PATH, ACCOUNT_DELETION_KEY_HEADER } from "@dohc/security-contract/account-deletion";
import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realDaemonReaderConfig } from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { initializeRelayDeployment } from "./relayDeployment";
import { RELAY_API_VERSIONS } from "./apiVersion";
import { relayProcessFixture, projectionEngine, productionEnv } from "./mainProcessTestSupport";

const { tempRoot, spawnRunningRelay, spawnRelayExpectExit } = relayProcessFixture();

describe("sync relay startup guards", () => {
  it.each(["", "short"])("does not mount account deletion with test auth and a short secret: %s",async secret=>{
    const root=await tempRoot("deletion-short-secret");
    const relay=await spawnRunningRelay(join(root,"relay.sqlite"),{BETTER_AUTH_SECRET:secret});
    const response=await fetch(relay.baseUrl+ACCOUNT_DELETION_PATH,{method:"POST",headers:{"content-type":"application/json",[ACCOUNT_DELETION_KEY_HEADER]:accountDeletionKey(secret)},body:JSON.stringify({operation:"purge",userId:"person",email:"person@example.test"})});
    expect(response.status).toBe(404);
  });

  it("requires an internal share-web URL when its public origin is set",async()=>{
    const {code,stderr}=await spawnRelayExpectExit({NODE_ENV:"test",SYNC_RELAY_TEST_AUTH:"1",DOHC_RELAY_SHARE_WEB_ORIGIN:"https://share.example.test",DOHC_RELAY_SHARE_WEB_URL:undefined});
    expect(code).toBe(1);expect(stderr).toContain("requires DOHC_RELAY_SHARE_WEB_URL");
  });

  it("starts an empty self-host deployment with supported live defaults and reports readiness", async () => {
    const root = await tempRoot("self-host-ready"), configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
    initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
    const relay = await spawnRunningRelay(relayPath, {DOHC_SELF_HOST_LIVE: "1", SYNC_RELAY_DB_PATH: undefined,
      DOHC_RELAY_DEPLOYMENT_CONFIG: configPath, DOHC_RELAY_SERVICE_HOST_ROOT: root,
      DOHC_RELAY_ENGINE_EXECUTABLE: projectionEngine.require(), DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1", DOHC_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      DOHC_RELAY_SHARE_WEB_URL: "http://share-web:1790", DOHC_RELAY_NAMED_LIVE_HOSTS: "relay.example.test",
      DOHC_RELAY_EXCHANGE_KEY: "x".repeat(32), DOHC_RELAY_LINK_KEY: "y".repeat(32), DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig()});
    expect(relay.stderr()).toContain("WARNING: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION=1");
    // The empty deployment must complete its engine handshake and first pass.
    await vi.waitFor(async () => {
      const response = await fetch(`${relay.baseUrl}/ready`);
      expect(response.status, `relay stayed unready\nstderr:\n${relay.stderr()}`).toBe(200);
      // The self-host profile runs automations by default.
      expect(await response.json()).toEqual({ok: true, service: "sync-relay", selfHostedLive: true, apiVersions: RELAY_API_VERSIONS, automations: "on"});
    }, {timeout: 10_000});
    expect((await fetch(`${relay.baseUrl}/sync/workspace/live-host`)).status).toBe(404);
  });

  it.each(["true", "", "2"])("refuses an invalid automations flag before opening storage: %j", async value => {
    const dbPath = join(await tempRoot("invalid-automations"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, DOHC_RELAY_AUTOMATIONS: value});
    expect(code).toBe(1); expect(stderr).toContain("DOHC_RELAY_AUTOMATIONS must be 0 or 1.");
    await expect(access(dbPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  it("refuses automations without what its copies of workspaces need", async () => {
    const dbPath = join(await tempRoot("automations-without-copies"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, DOHC_RELAY_AUTOMATIONS: "1"});
    expect(code).toBe(1);
    expect(stderr).toContain("Copies of workspaces on this server require a deployment");
  });
  it.each(["true", "", "2"])("refuses an invalid self-host live flag before opening storage: %j", async value => {
    const dbPath = join(await tempRoot("invalid-self-host"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, DOHC_SELF_HOST_LIVE: value});
    expect(code).toBe(1); expect(stderr).toContain("DOHC_SELF_HOST_LIVE must be 0 or 1.");
    await expect(access(dbPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  it.each([
    {host: {DOHC_SELF_HOST_LIVE: "1"}, reader: undefined, reason: "DOHC_ENGINE_READER_CONFIG is not set"},
    {host: {DOHC_RELAY_SERVICE_HOST_CONFIG: "/missing/host.json"}, reader: undefined, reason: "DOHC_ENGINE_READER_CONFIG is not set"},
    {host: {DOHC_SELF_HOST_LIVE: "1"}, reader: "{}", reason: "DOHC_ENGINE_READER_CONFIG is not a JSON object"},
  ])("refuses a live host without the Markdown reader before opening storage: %j", async ({host, reader, reason}) => {
    const dbPath = join(await tempRoot("live-host-no-reader"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, ...host, DOHC_ENGINE_READER_CONFIG: reader});
    expect(code).toBe(1); expect(stderr).toContain(`Edit shares need the Markdown reader, but ${reason}`);
    await expect(access(dbPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  it.each([
    {quota: "nope", reason: "DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT must be 0 or a positive safe integer."},
    {quota: "2", reason: "App collections require DOHC_RELAY_APP_PUBLICATIONS=1."},
  ])("refuses invalid collection configuration before opening storage: $quota", async ({quota, reason}) => {
    const dbPath = join(await tempRoot("invalid-app-collection"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, DOHC_RELAY_APP_PUBLICATIONS: "0",
      DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: quota});
    expect(code).toBe(1);
    expect(stderr).toContain(`FATAL: ${reason}`);
    await expect(access(dbPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  it("refuses invalid app publication opt-in before opening storage", async () => {
    const dbPath = join(await tempRoot("invalid-app-publication"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath, DOHC_RELAY_APP_PUBLICATIONS: "true"});
    expect(code).toBe(1);
    expect(stderr).toContain("FATAL: DOHC_RELAY_APP_PUBLICATIONS must be 0 or 1.");
    await expect(access(dbPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  const namedBrowserLimitsReason =
    "DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS must be valid JSON with all required positive limits within their supported bounds, a safe expiry timestamp, and capacity for the named session envelopes.";

  it.each([
    { label: "missing origin", origin: undefined, key: "x".repeat(32), expected: "DOHC_RELAY_SHARE_WEB_ORIGIN must be an HTTPS origin" },
    { label: "HTTP origin", origin: "http://127.0.0.1:48123", key: "x".repeat(32), expected: "DOHC_RELAY_SHARE_WEB_ORIGIN must be an HTTPS origin" },
    { label: "missing key", origin: "https://share.example.test", key: undefined, expected: "DOHC_RELAY_EXCHANGE_KEY must be set" },
    { label: "short key", origin: "https://share.example.test", key: "x".repeat(31), expected: "DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters" },
    { label: "small request", origin: "https://share.example.test", key: "x".repeat(32), maxRequestBytes: 1037, expected: namedBrowserLimitsReason },
    { label: "small response", origin: "https://share.example.test", key: "x".repeat(32), maxResponseBytes: 4151, expected: namedBrowserLimitsReason },
    { label: "unsafe expiry", origin: "https://share.example.test", key: "x".repeat(32), retentionMs: Number.MAX_SAFE_INTEGER, expected: namedBrowserLimitsReason },
  ])("refuses named browser configuration before opening storage: $label", async ({ label, origin, key, expected, ...overrides }) => {
    const dbPath = join(await tempRoot(`named-${label.replaceAll(" ", "-")}`), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1", SYNC_RELAY_PORT: "0", SYNC_RELAY_DB_PATH: dbPath,
      DOHC_RELAY_SHARE_WEB_ORIGIN: origin, DOHC_RELAY_EXCHANGE_KEY: key,
      DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS: JSON.stringify({ maxSessions: 4, retentionMs: 60000,
        maxPendingRequests: 2, maxRequestBytes: 1038, maxResponseBytes: 4152, timeoutMs: 1000, ...overrides }),
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain(`FATAL: ${expected}`);
    expect(stderr).not.toContain("TypeError:");
    await expect(access(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["development", "test"])("warns when projection development opt-in is honored in %s", async nodeEnv => {
    const root = await tempRoot("projection-warning");
    const relay = await spawnRunningRelay(join(root,"relay.sqlite"), {NODE_ENV:nodeEnv,
      DOHC_RELAY_ENGINE_EXECUTABLE:process.execPath, DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION:"1"}, {projectionHandshake:true});
    expect(relay.stderr()).toContain("WARNING: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION=1");
  });

  it.each(["production", "staging", undefined])("refuses the projection development flag outside development/test: %s", async nodeEnv => {
    for (const flag of ["0", "1"]) {
      const root = await tempRoot("projection-production-opt-in");
      const configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
      initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
      const {code, stderr} = await spawnRelayExpectExit({...productionEnv, NODE_ENV:nodeEnv,
        SYNC_RELAY_DB_PATH:undefined, DOHC_RELAY_DEPLOYMENT_CONFIG:configPath,
        DOHC_RELAY_ENGINE_EXECUTABLE:process.execPath, DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION:flag}, {projectionHandshake:true});
      expect(code).toBe(1);
      expect(stderr).toContain("DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION is allowed only in development/test.");
      const database = new DatabaseSync(relayPath, {readOnly: true});
      try {
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all())
          .toEqual([{name: "sync_relay_continuity"}]);
      } finally { database.close(); }
    }
  });

  it.each(["true", "", "2"])("refuses invalid projection development opt-in before opening storage: %j", async value => {
    const dbPath = join(await tempRoot("projection-invalid-opt-in"), "relay.sqlite");
    const {code, stderr} = await spawnRelayExpectExit({NODE_ENV:"test", SYNC_RELAY_TEST_AUTH:"1", SYNC_RELAY_DB_PATH:dbPath, DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION:value});
    expect(code).toBe(1); expect(stderr).toContain("DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION must be 0 or 1.");
    await expect(access(dbPath)).rejects.toMatchObject({code:"ENOENT"});
  });

  it.each([
    {executable: undefined, reason: "Document sharing requires DOHC_RELAY_ENGINE_EXECUTABLE outside development/test."},
    {executable: "relative-engine", reason: process.platform === "linux"
      ? "The projection engine must be an absolute executable file." : "Document projection requires Linux memory isolation"},
    {executable: process.execPath, reason: process.platform === "linux"
      ? "Projection engine did not pass startup probes:" : "Document projection requires Linux memory isolation"},
  ])("refuses production projection startup for $executable: $reason", async ({executable, reason}) => {
    const root = await tempRoot("projection-startup");
    const configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
    initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
    const {code, stderr} = await spawnRelayExpectExit({...productionEnv, SYNC_RELAY_DB_PATH:undefined,
      DOHC_RELAY_DEPLOYMENT_CONFIG:configPath, DOHC_RELAY_ENGINE_EXECUTABLE:executable});
    expect(code).toBe(1);
    expect(stderr).toContain(reason);
  });

  it.skipIf(process.platform==="linux" || projectionEngine.missing)("refuses non-Linux projection startup without development opt-in",async()=>{
    const dbPath=join(await tempRoot("projection-platform"),"relay.sqlite");
    const {code,stderr}=await spawnRelayExpectExit({NODE_ENV:"test",SYNC_RELAY_TEST_AUTH:"1",SYNC_RELAY_DB_PATH:dbPath,DOHC_RELAY_ENGINE_EXECUTABLE:projectionEngine.require(),DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION:undefined});
    expect(code).toBe(1);expect(stderr).toContain("requires Linux memory isolation");await expect(access(dbPath)).rejects.toMatchObject({code:"ENOENT"});
  });
});
