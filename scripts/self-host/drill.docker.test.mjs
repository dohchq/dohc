import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeArgs, readSettings } from "../../tools/self-host/config.mjs";
import { runMove } from "./move.mjs";

// Not in the root test list: it needs a Linux Docker host and the image named by DOHC_RECOVERY_TEST_IMAGE.
// Build the image from this checkout. See "Move to a new host" in docs/how-to/self-host-recovery.md.
const skip = !process.env.DOHC_RECOVERY_TEST_IMAGE ? "Set DOHC_RECOVERY_TEST_IMAGE to a built self-host image."
  : process.platform !== "linux" ? "The data-disk drill needs a Linux Docker host." : false;
const root = fileURLToPath(new URL("../../", import.meta.url));

test("a killed deployment's data disk starts in a fresh Compose project and refuses an older relay database", { skip, timeout: 900_000 }, async () => {
  const image = process.env.DOHC_RECOVERY_TEST_IMAGE;
  const owner = `dohc-drill-${randomUUID().slice(0, 8)}`;
  const scratch = await mkdtemp(join(tmpdir(), `${owner}-`));
  const disk = join(scratch, "disk", "dohc"), drill = join(scratch, "drill");
  function docker(args, { allowFailure = false, timeout = 300_000 } = {}) {
    const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
    if (!allowFailure) assert.equal(result.status, 0, `docker ${args.filter(arg => !arg.startsWith("-")).slice(0, 3).join(" ")}: ${result.stderr}`);
    return result;
  }
  const asRoot = script => docker(["run", "--rm", "--network", "none", "--user", "0:0",
    "--mount", `type=bind,source=${scratch},target=/scratch`, "--entrypoint", "node", image, "-e", script]).stdout.trim();
  const secret = () => randomBytes(32).toString("base64url");
  const secrets = { POSTGRES_PASSWORD: secret(), BETTER_AUTH_SECRET: secret(), DOHC_RELAY_LINK_KEY: secret(), DOHC_RELAY_EXCHANGE_KEY: secret() };
  const subnet = `10.234.${100 + Math.floor(Math.random() * 100)}`;
  const projects = {};
  async function project(suffix, dataDirectory, extra = []) {
    const name = `${owner}-${suffix}`, env = join(scratch, `${suffix}.env`);
    await writeFile(env, Object.entries({ ...secrets, DOHC_DEPLOYMENT_NAME: name, DOHC_IMAGE: image,
      DOHC_PUBLIC_ORIGIN: "https://drill.dohc.invalid", DOHC_PUBLIC_HOST: "drill.dohc.invalid", DOHC_SERVER_NETWORK_ACCESS: "public",
      DOHC_SMTP_HOST: "smtp.dohc.invalid", DOHC_SMTP_FROM: "drill@dohc.invalid", DOHC_RELAY_AUTOMATIONS: "0", DOHC_DATA_DIRECTORY: dataDirectory,
      DOHC_NETWORK_SUBNET: `${subnet}.0/24`, DOHC_NETWORK_IP_RANGE: `${subnet}.128/25`,
      DOHC_GATEWAY_ADDRESS: `${subnet}.2`, DOHC_SHARE_WEB_ADDRESS: `${subnet}.3`,
    }).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    projects[suffix] = { name, env, args: (...args) => composeArgs(env, readSettings(env), ...extra, ...args) };
    return projects[suffix];
  }
  const compose = (target, args, options) => docker(target.args(...args), options);
  const relayWork = (target, action) => JSON.parse(compose(target, ["run", "--rm", "--no-deps", "-T",
    "--volume", `${drill}:/app/services/sync-relay/drill:ro`, "--entrypoint", "node", "sync-relay", "/app/services/sync-relay/drill/drill.mjs", action])
    .stdout.trim().split("\n").at(-1));
  const accounts = target => compose(target, ["exec", "-T", "postgres", "psql", "-At", "-U", "dohc", "-d", "dohc", "-c", 'SELECT id FROM "user" ORDER BY id']).stdout.trim();
  const continuity = () => JSON.parse(asRoot(`const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');
    const config=JSON.parse(fs.readFileSync('/scratch/disk/dohc/continuity/deployment.json','utf8'));
    const db=new DatabaseSync('/scratch/disk/dohc/continuity/history/continuity.sqlite',{readOnly:true});
    try{console.log(JSON.stringify({namespace:config.namespace,stamp:db.prepare('SELECT expected_stamp FROM continuity').get().expected_stamp}));}finally{db.close();}`));
  try {
    await mkdir(drill);
    const { buildRelayFixture } = await import("../../services/sync-relay/scripts/build.mjs");
    await buildRelayFixture(fileURLToPath(new URL("./drill-relay.mjs", import.meta.url)), join(drill, "drill.mjs"));
    const first = await project("a", disk);
    const empty = await project("c", join(scratch, "empty"));

    // An unmounted disk leaves the folder missing. The volume mount fails and nothing is created.
    assert.notEqual(compose(first, ["run", "--rm", "--no-deps", "-T", "relay-initialize"], { allowFailure: true }).status, 0);
    assert.equal(existsSync(disk), false);
    asRoot(`const fs=require('node:fs');for(const base of ['/scratch/disk/dohc','/scratch/empty'])for(const folder of ['sync-relay','continuity','host-data']){
      fs.mkdirSync(base+'/'+folder,{recursive:true});fs.chownSync(base+'/'+folder,1000,1000);}fs.mkdirSync('/scratch/old');`);
    const dockerRun = (command, args) => spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true }).status;
    assert.throws(() => runMove({ envFile: empty.env }, dockerRun, () => {}), /No relay deployment found/);
    for (const folder of ["sync-relay", "continuity", "host-data"]) assert.deepEqual(readdirSync(join(scratch, "empty", folder)), []);

    compose(first, ["up", "-d", "--wait", "sync-relay"]);
    compose(first, ["stop"]);
    const saved = asRoot(`const fs=require('node:fs');const names=fs.readdirSync('/scratch/disk/dohc/sync-relay').filter(name=>/^sync-relay\\.sqlite(-wal)?$/.test(name));
      for(const name of names)fs.copyFileSync('/scratch/disk/dohc/sync-relay/'+name,'/scratch/old/'+name);console.log(names.join());`);
    assert.match(saved, /^sync-relay\.sqlite/);
    compose(first, ["up", "-d", "--wait", "postgres"]);
    compose(first, ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "dohc", "-d", "dohc", "-c",
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('drill-owner', 'Owner', 'owner@drill.invalid', true), ('drill-reader', 'Reader', 'reader@drill.invalid', true)`]);
    const seeded = relayWork(first, "seed");
    assert.deepEqual(seeded, { files: ["packing.md"], blob: "# Packing list\n", share: "drill-workspace", grant: "drill-reader" });
    compose(first, ["up", "-d", "--wait", "sync-relay"]);

    // The old server dies without a clean shutdown and never runs again.
    compose(first, ["kill"]);
    assert.equal(compose(first, ["ps", "--quiet", "--status", "running"]).stdout.trim(), "");
    compose(first, ["down"]);
    const killed = continuity();

    // Postgres stays in a Docker volume in this layout, so the drill carries it over separately.
    const override = join(scratch, "postgres.yml");
    await writeFile(override, `volumes:\n  dohc_self_host_postgres:\n    external: true\n    name: ${first.name}_dohc_self_host_postgres\n`);
    const second = await project("b", disk, ["-f", override]);
    runMove({ envFile: second.env }, (command, args) => command === "docker" ? dockerRun(command, args)
      : compose(second, ["up", "-d", "--wait", "sync-relay"]).status, () => {});
    // The relay opens only when its database stamp equals the continuity counter.
    const reopened = continuity();
    assert.equal(reopened.namespace, killed.namespace);
    assert.ok(reopened.stamp >= killed.stamp, `continuity moved back from ${killed.stamp} to ${reopened.stamp}`);
    assert.equal(accounts(second), "drill-owner\ndrill-reader");
    compose(second, ["stop", "sync-relay"]);
    assert.deepEqual(relayWork(second, "verify"), seeded);

    asRoot(`const fs=require('node:fs');const dir='/scratch/disk/dohc/sync-relay';
      for(const name of ['sync-relay.sqlite','sync-relay.sqlite-wal','sync-relay.sqlite-shm'])fs.rmSync(dir+'/'+name,{force:true});
      for(const name of fs.readdirSync('/scratch/old')){fs.copyFileSync('/scratch/old/'+name,dir+'/'+name);fs.chownSync(dir+'/'+name,1000,1000);}`);
    const refused = compose(second, ["run", "--rm", "--no-deps", "-T", "sync-relay"], { allowFailure: true, timeout: 120_000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Relay deployment continuity is unavailable/);
  } finally {
    for (const target of Object.values(projects).reverse()) {
      compose(target, ["down", "--remove-orphans", "--timeout", "0"], { allowFailure: true });
      const volumes = docker(["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${target.name}`]).stdout.trim().split("\n").filter(Boolean);
      if (volumes.length) docker(["volume", "rm", ...volumes]);
    }
    if (process.getuid) {
      docker(["run", "--rm", "--network", "none", "--user", "0:0", "--mount", `type=bind,source=${scratch},target=/scratch`,
        "--entrypoint", "chown", image, "-R", `${process.getuid()}:${process.getgid()}`, "/scratch"]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
