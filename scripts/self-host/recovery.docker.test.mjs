import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { archiveDeployment } from "./archive.mjs";

// Use the built self-host image so the bundled command resolves its real runtime dependencies.
test("Docker cold repair and private deployment archive", { skip: !process.env.DOHC_RECOVERY_TEST_IMAGE, timeout: 120_000 }, async () => {
  const image = process.env.DOHC_RECOVERY_TEST_IMAGE;
  const owner = `dohc-recovery-proof-${randomUUID()}`;
  const scratch = await mkdtemp(join(tmpdir(), owner));
  const volumes = ["data", "continuity", "host", "auth"].map(kind => `${owner}-${kind}`);
  const created = [];
  function docker(args, allowedFailure = false) {
    const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 90_000 });
    if (!allowedFailure) assert.equal(result.status, 0, `${args.slice(0, 2).join(" ")}: ${result.stderr}`);
    return result;
  }
  const commandPath = "/app/services/sync-relay/dist/relay-deployment.js";
  const common = ["run", "--rm", "--network", "none", "--user", "0:0",
    "--mount", `type=volume,source=${volumes[0]},target=/data`,
    "--mount", `type=volume,source=${volumes[1]},target=/continuity`,
    "--mount", `type=bind,source=${scratch},target=/backup`,
    "--mount", `type=bind,source=${resolve("services/sync-relay/dist/relay-deployment.js")},target=${commandPath},readonly`,
    "--entrypoint", "node", image];
  const command = (...args) => docker([...common, commandPath, ...args]);
  try {
    for (const volume of volumes) {
      docker(["volume", "create", "--label", `dohc.recovery-proof=${owner}`, volume]);
      created.push(volume);
    }
    command("initialize", "--config", "/continuity/deployment.json", "--database", "/data/sync-relay.sqlite", "--continuity-directory", "/continuity/history");
    command("provision-service", "--config", "/continuity/deployment.json", "--host-id", "proof-host");
    command("backup", "--config", "/continuity/deployment.json", "--directory", "/backup/snapshot");
    docker([...common, "-e", "require('node:fs').writeFileSync('/data/sync-relay.sqlite','damaged proof bytes')"]);
    command("restore", "--config", "/continuity/deployment.json", "--directory", "/backup/snapshot");
    command("provision-service", "--config", "/continuity/deployment.json", "--host-id", "proof-host");
    command("check-backup", "--config", "/continuity/deployment.json", "--directory", "/backup/snapshot");
    command("salvage", "--directory", "/backup/snapshot", "--output", "/backup/salvage");
    assert.equal(JSON.parse(await readFile(join(scratch, "salvage/recovery.json"), "utf8")).complete, true);
    const envFile = join(scratch, "deployment.env");
    await writeFile(envFile, "PRIVATE_PROOF_SECRET=archive-preserves-it\n", { mode: 0o600 });
    const config = { name: owner, services: { "sync-relay": { image } },
      volumes: Object.fromEntries(volumes.map(name => [name, { name }])) };
    const directory = join(scratch, "archive");
    await archiveDeployment({ directory, envFile }, config, args => docker(args).stdout);
    const manifest = JSON.parse(await readFile(join(directory, "archive.json"), "utf8"));
    assert.equal(manifest.complete, true);
    assert.equal(manifest.files.filter(file => file.volumeName).length, 4);
    assert.equal(await readFile(join(directory, "environment.env"), "utf8"), "PRIVATE_PROOF_SECRET=archive-preserves-it\n");
    const listing = docker(["run", "--rm", "--network", "none", "--user", "0:0", "--mount", `type=bind,source=${directory},target=/archive,readonly`,
      "--entrypoint", "tar", image, "-tzf", "/archive/volume-1.tar.gz"]).stdout;
    assert.match(listing, /deployment.json/);
    assert.match(listing, /continuity.sqlite/);
  } finally {
    for (const volume of created.reverse()) {
      const inspection = JSON.parse(docker(["volume", "inspect", volume]).stdout)[0];
      assert.equal(inspection.Labels?.["dohc.recovery-proof"], owner);
      docker(["volume", "rm", volume]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
