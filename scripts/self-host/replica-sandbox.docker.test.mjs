import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {setTimeout as pollDelay} from "node:timers/promises";

function docker(args, check = true) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", b => {stdout += b;}); child.stderr.on("data", b => {stderr += b;});
    child.once("error", reject); child.once("close", code => {
      if (check && code !== 0) reject(Error(`${args[0]} failed: ${stderr}`));
      else resolve({code, stdout, stderr});
    });
  });
}

// Opt in with DOHC_REPLICA_SANDBOX_TEST_IMAGE after building the test image.
test("replica sandbox under compose security options and a 64 MiB replicas tmpfs", {
  skip: !process.env.DOHC_REPLICA_SANDBOX_TEST_IMAGE, timeout: 1_200_000,
}, async () => {
  const name = `replica4b-${randomUUID()}`;
  const pg = `${name}-postgres`;
  const label = `dohc.replica-proof=${name}`;
  await docker(["network", "create", "--internal", "--label", label, name]);
  try {
  await docker(["run", "-d", "--rm", "--pull=never", "--name", pg, "--label", label, "--network", name, "--network-alias", "postgres",
    "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_USER=probe@dohc.test", "-e", "POSTGRES_DB=replica", "-e", "POSTGRES_PASSWORD=local-proof-only",
    "--health-cmd", "pg_isready -U probe@dohc.test -d replica", "--health-interval", "1s", "postgres:17.9-alpine"]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const health = await docker(["inspect", "--format", "{{.State.Health.Status}}", pg]);
    if (health.stdout.trim() === "healthy") break;
    assert(Date.now() < deadline, "Postgres never became healthy");
    await pollDelay(100); // Poll readiness, never use a fixed startup sleep.
  }
  const child = spawn("docker", ["run", "--rm", "--pull=never", "--name", name, "--label", label, "--network", name, "--init", "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL", "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/data:uid=1000,gid=1000", "--tmpfs", "/continuity:uid=1000,gid=1000,mode=700",
    "--tmpfs", "/replicas:size=64m,uid=1000,gid=1000,mode=700", process.env.DOHC_REPLICA_SANDBOX_TEST_IMAGE, "--probes", "--measure"],
  {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const result = await new Promise((resolve, reject) => {child.once("error", reject); child.once("close", resolve);});
  assert.equal(result, 0);
  } finally {
    for (const container of [name, pg]) {
      const inspect = await docker(["inspect", "--format", '{{index .Config.Labels "dohc.replica-proof"}}', container], false);
      if (inspect.code === 0) {assert.equal(inspect.stdout.trim(), name); await docker(["rm", "-f", container]);}
    }
    await docker(["network", "rm", name]);
  }
});

// The engine's own policy must deny these calls even without Docker's seccomp filter.
test("replica kernel-surface and IPC filter without an outer seccomp profile", {
  skip: !process.env.DOHC_REPLICA_SANDBOX_TEST_IMAGE, timeout: 60_000,
}, async () => {
  const name = `replica4b-kernel-${randomUUID()}`;
  try {
    for (const action of ["kernel-surface", "ipc"]) for (const mode of ["control", "sandbox"]) {
      const result = await docker(["run", "--rm", "--pull=never", "--name", name, "--network", "none", "--init",
        "--security-opt", "no-new-privileges:true", "--security-opt", "seccomp=unconfined", "--cap-drop", "ALL", "--read-only",
        "--tmpfs", "/replicas:uid=1000,gid=1000,mode=700", "--workdir", "/replicas", "--entrypoint", "/app/probe",
        process.env.DOHC_REPLICA_SANDBOX_TEST_IMAGE, action, mode, "1"], action === "kernel-surface");
      // The probe asserts EPERM itself; a denied ipc run exits 13 and an escape panics.
      if (action === "ipc") assert.equal(result.code, mode === "sandbox" ? 13 : 0, result.stdout + result.stderr);
      console.log(action, mode, result.stdout);
    }
  } finally {
    // This test exclusively owns the unpredictable name.
    await docker(["rm", "-f", name], false);
  }
});
